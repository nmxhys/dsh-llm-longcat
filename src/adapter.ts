/**
 * `LongCatAdapter`: fetch + SSE against LongCat's OpenAI-compatible
 * chat-completions endpoint, emitting harness StreamChunks. The adapter is
 * transport-only: connection facts arrive through a thunk resolved once per
 * operation and the bearer token through a per-request resolver, so the
 * registering plugin owns validation, layering, and credential policy.
 *
 * @module dsh-llm-longcat/adapter
 */

import {
  attributionHeaders,
  CONTEXT_WINDOW_EXCEEDED_CODE,
  isContextWindowExceededError,
  isQuotaExceededError,
  LlmAdapter,
  LlmError,
  ProviderRequestId,
  QUOTA_EXCEEDED_CODE,
  ReasoningEffortId,
} from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  ImageAttachmentAccessResolver,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  ModelModality,
  RequestMessage,
  ResolvedRetryPolicy,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { AttachmentStore, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import { idleWatchdog, timeoutOf } from '@deepseek-ai/dsh-timeout'
import { prepareImages } from './images.ts'
import type { ImageSerializationContext } from './serialize.ts'
import { serializeRequest } from './serialize.ts'
import type { RequestDefaults } from './serialize.ts'
import { parseSse } from './sse.ts'
import { translate } from './translate.ts'
import type { WireError } from './types.ts'

/** One optional model entry advertised by this adapter. */
export interface LongCatCatalogModel {
  /** Wire model id accepted by the configured endpoint. */
  readonly id: string
  /** Selector label; defaults to {@link id}. */
  readonly name?: string
  /** Optional selector detail. */
  readonly description?: string
  /** Known combined request/response context capacity. */
  readonly contextWindow?: number
  /** Per-request output cap for this model; omission falls back to the profile value. */
  readonly maxTokens?: number
  /**
   * Accepted request modalities; omission means text-only. LongCat-2.5-Preview
   * reports `modality: text+image->text`; LongCat-2.0 is text-only, and an
   * uncatalogued id declares the same negative capability so the host never
   * durably accepts an image this route would then refuse.
   */
  readonly inputModalities?: readonly ModelModality[]
  /** Total-pixel budget for one request image; defaults to 2048×2048. */
  readonly imageMaxPixels?: number
  /** Encoded-byte target for one request image; defaults to 1 MiB. */
  readonly imageMaxBytes?: number
}

/**
 * Validated connection facts for one operation. The plugin's
 * `resolveAdapterOptions` is the one explicit resolve step producing this
 * shape; the adapter re-reads it per operation, which is what makes a
 * configuration change reach the next request without re-registration.
 */
export interface LongCatConnectionOptions {
  /** Endpoint base; `/chat/completions` is appended. */
  baseURL: string
  /**
   * Credential reference from this same resolution, resolved per request.
   * Travelling with the endpoint is the point: a request can never pair one
   * generation's URL with another generation's secret.
   */
  apiKeyEnv: CredentialRef
  /** Request defaults applied to every call. */
  defaults: RequestDefaults
  /** Default per-request output cap; explicit request values win. */
  maxTokens: number
  /** Context capacity used when the selected model has no exact value. */
  defaultContextWindow: number
  /** Advisory models exposed to discovery consumers; requests remain unrestricted. */
  models: readonly LongCatCatalogModel[]
  /** Bound on the accumulated base64 payload of one request's images. */
  maxRequestImageBytes: number
  /** Optional bound on retained image occurrences per request. */
  maxImagesPerRequest?: number
  /** Maximum provider idle time while one stream read is outstanding. */
  streamIdleTimeoutMs: number
  /** Provider-owned model-request retry policy, already resolved. */
  retryPolicy: ResolvedRetryPolicy
}

/** Constructor options: the operation-local resolution hooks the plugin owns. */
export interface LongCatAdapterOptions {
  /** Current validated connection facts; called once per operation. */
  options: () => LongCatConnectionOptions
  /**
   * Resolve the bearer token for the connection facts of one request. The
   * snapshot is passed in — never re-read — so the key can only ever come
   * from the same resolution as the endpoint it is sent to.
   */
  resolveApiKey: (connection: LongCatConnectionOptions) => Promise<string>
  /**
   * Mounted attachment provider, read per request. Absent means this
   * deployment cannot send images at all: an image-bearing request fails with
   * `UNSUPPORTED_CONTENT` instead of quietly dropping bytes.
   */
  resolveAttachments?: () => AttachmentStore | undefined
  /**
   * Resolve current execution-world access for one durable image, used to name
   * the read-only copy in the text handle and in an offloaded placeholder.
   * Absent degrades that text to its no-path form, never to silence.
   */
  resolveImageAccess?: (
    attachments: AttachmentStore,
    ref: ImageAttachmentRef,
  ) => { readonlyPath: string } | undefined
}

/** Default maximum idle interval while a stream read is outstanding. */
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000
/** LongCat-2.0 `context_length` from the model-detail endpoint. */
export const DEFAULT_CONTEXT_WINDOW = 1_048_576
/** Documented `max_tokens` cap for LongCat-2.0. */
export const DEFAULT_MAX_TOKENS = 131_072

const STREAM_IDLE_TIMEOUT_CODE = 'LLM_STREAM_IDLE_TIMEOUT'
const OFF_REASONING_EFFORT = ReasoningEffortId('off')
const HIGH_REASONING_EFFORT = ReasoningEffortId('high')

/**
 * The selectable efforts. LongCat's thinking switch is binary — its
 * `supported_parameters` lists `thinking` and no `reasoning_effort` — so
 * offering `low`/`max` would advertise controls that collapse onto the same
 * two wire bodies.
 */
const REASONING_EFFORTS = [
  { id: OFF_REASONING_EFFORT, name: 'Off' },
  { id: HIGH_REASONING_EFFORT, name: 'Thinking' },
] as const

const OFF_ONLY_REASONING_EFFORTS = [
  { id: OFF_REASONING_EFFORT, name: 'Off' },
] as const

function modelInfo(provider: string, model: LongCatCatalogModel): LlmModelInfo {
  return {
    provider,
    id: model.id,
    name: model.name ?? model.id,
    ...model.description === undefined ? {} : { description: model.description },
    inputModalities: model.inputModalities ?? ['text'],
  }
}

function providerRetryAfterMs(value: string | null): number | undefined {
  if (value === null) return undefined
  if (/^\d+$/.test(value)) {
    const delay = Number(value) * 1_000
    return Number.isFinite(delay) && delay > 0 ? delay : undefined
  }
  const delay = Date.parse(value) - Date.now()
  return Number.isFinite(delay) && delay > 0 ? delay : undefined
}

function requestId(headers: Headers): ReturnType<typeof ProviderRequestId> | undefined {
  const value = headers.get('x-request-id') ?? headers.get('x-longcat-request-id')
  return value === null || value.length === 0 ? undefined : ProviderRequestId(value)
}

/**
 * Map an HTTP status to a stable LlmError code.
 *
 * LongCat documents `permission_error` / `insufficient_quota` on **403** and
 * a dedicated **402** for exhausted token quota, where most OpenAI-compatible
 * providers use 429. Both are classified as QUOTA before the generic
 * auth/rate-limit buckets, so a depleted balance is never reported as a bad
 * key or retried as a transient rate limit.
 * @param status - status of a non-2xx provider response.
 * @param error - parsed provider error body, when available.
 * @returns the normalized harness error code.
 */
export function httpErrorCode(status: number, error?: WireError['error']): string {
  const detail = [error?.code, error?.type, error?.message].filter(Boolean).join(' ')
  // 402 is LongCat's documented "insufficient token quota".
  if (status === 402) return QUOTA_EXCEEDED_CODE
  if (isQuotaExceededError(detail)) return QUOTA_EXCEEDED_CODE
  if (status === 401) return 'AUTH'
  // A 403 carrying quota detail was caught above; anything else is a genuine
  // permission failure.
  if (status === 403) return 'AUTH'
  if (status === 429) return 'RATE_LIMIT'
  if (status === 400) {
    if (isContextWindowExceededError(detail)) return CONTEXT_WINDOW_EXCEEDED_CODE
    return 'INVALID_REQUEST'
  }
  if (status >= 500) return 'SERVER'
  return `HTTP_${status}`
}

/**
 * LongCat chat-completions adapter. One instance serves every model name it
 * was registered under (the harness model name IS the wire model name).
 *
 * One stable signal reaches both the initial fetch and the body reads. Caller
 * aborts map to `ABORTED`; the configured per-read idle watchdog maps to
 * `TIMEOUT`.
 */
export class LongCatAdapter extends LlmAdapter {
  constructor(private readonly config: LongCatAdapterOptions) {
    super()
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: 'LongCat' }
  }

  override providerRetryPolicy(_provider: string): ResolvedRetryPolicy {
    return this.config.options().retryPolicy
  }

  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve(this.config.options().models.map(model => modelInfo(provider, model)))
  }

  override resolveModel(
    provider: string,
    model: string,
    _signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    const connection = this.config.options()
    const configured = connection.models.find(entry => entry.id === model)
    return Promise.resolve({
      // An uncatalogued id declares text-only: "unknown" would let the host
      // accept and durably persist images this adapter has no policy to
      // encode, and the serializer would then have to refuse the turn.
      ...configured === undefined
        ? { provider, id: model, name: model, inputModalities: ['text' as const] }
        : modelInfo(provider, configured),
      context: { contextWindow: configured?.contextWindow ?? connection.defaultContextWindow },
      defaultMaxTokens: configured?.maxTokens ?? connection.maxTokens,
      ...connection.defaults.thinking === 'disabled'
        ? {
          reasoning: {
            efforts: OFF_ONLY_REASONING_EFFORTS,
            defaultEffort: OFF_REASONING_EFFORT,
          },
        }
        : {
          reasoning: {
            efforts: REASONING_EFFORTS,
            defaultEffort: connection.defaults.reasoningEffort === 'off'
              ? OFF_REASONING_EFFORT
              : HIGH_REASONING_EFFORT,
          },
        },
    })
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    // LongCat's supported_parameters does not include `stop`. Failing loudly
    // beats sending it and having generation silently run past the sequence
    // the caller depended on.
    if (options.stop !== undefined) {
      throw new LlmError('LongCat does not support stop sequences', 'UNSUPPORTED_OPTION')
    }

    // One resolution per stream call: connection facts and the credential
    // freeze here and hold for this whole request, so an in-flight stream
    // never observes a configuration change and the next call re-resolves.
    const connection = this.config.options()
    const apiKey = await this.config.resolveApiKey(connection)
    const consumer = new AbortController()
    const upstream = options.signal === undefined
      ? consumer.signal
      : AbortSignal.any([options.signal, consumer.signal])
    using watchdog = idleWatchdog(upstream, connection.streamIdleTimeoutMs, STREAM_IDLE_TIMEOUT_CODE)
    const iterator = this.request(
      options,
      watchdog.signal,
      connection,
      apiKey,
      () => { watchdog.pulse() },
    )[Symbol.asyncIterator]()
    let exhausted = false
    try {
      while (true) {
        const result = await watchdog.next(iterator)
        if (result.done) {
          exhausted = true
          return
        }
        yield result.value
      }
    } catch (error: unknown) {
      if (timeoutOf(watchdog.signal, STREAM_IDLE_TIMEOUT_CODE) !== undefined) {
        throw new LlmError(
          `LongCat stream idle timeout after ${connection.streamIdleTimeoutMs}ms`,
          'TIMEOUT',
          { cause: error },
        )
      }
      if (options.signal?.aborted) {
        throw new LlmError('LongCat request aborted by caller', 'ABORTED', { cause: error })
      }
      if (error instanceof LlmError) throw error
      throw new LlmError(
        `LongCat API stream from ${connection.baseURL} failed`,
        'TRANSPORT',
        { cause: error },
      )
    } finally {
      consumer.abort('LongCat stream consumer stopped')
      if (!exhausted && iterator.return !== undefined) {
        try {
          await iterator.return()
        } catch (_abortedTransportTeardown) {
          // The consumer controller already owns termination; a return-time
          // abort cannot add a second outcome.
        }
      }
    }
  }

  private async * request(
    options: GenerateOptions,
    signal: AbortSignal,
    connection: LongCatConnectionOptions,
    apiKey: string,
    onComment: () => void,
  ): AsyncIterable<StreamChunk> {
    // Images are prepared before serialization: the request version bytes are
    // the wire payload, and an over-budget or unsupported image must fail
    // before any network I/O.
    const prepared = await this.prepareRequestImages(options, connection, signal)
    const body = serializeRequest(
      { ...options, messages: prepared.messages as RequestMessage[] },
      connection.defaults,
      prepared.images,
    )
    // Prepared outside the try so the TRANSPORT label below covers exactly
    // the transport boundary, never a serialization failure.
    const payload = JSON.stringify(body)
    const headers = {
      'authorization': `Bearer ${apiKey}`,
      'content-type': 'application/json',
      'accept': 'text/event-stream',
      ...attributionHeaders(),
    }

    let response: Response
    try {
      response = await fetch(`${connection.baseURL}/chat/completions`, {
        method: 'POST',
        headers,
        body: payload,
        signal,
      })
    } catch (error: unknown) {
      // The outer stream distinguishes caller cancellation and watchdog expiry.
      if (signal.aborted) throw error
      // fetch wraps every transport failure (DNS, refused connection, TLS,
      // proxy) in a bare `TypeError: fetch failed` whose actionable detail
      // lives on `cause`.
      throw new LlmError(
        `LongCat API request to ${connection.baseURL} failed`,
        'TRANSPORT',
        { cause: error },
      )
    }

    if (!response.ok) {
      let message = `LongCat API error (HTTP ${response.status})`
      let providerError: WireError['error']
      try {
        const parsed = await response.json() as WireError
        providerError = parsed.error
        if (providerError?.message) message = providerError.message
      } catch {
        // Only swallow error-body parsing: the HTTP status still identifies
        // the failure, so malformed gateway JSON must not mask it.
      }
      const delay = providerRetryAfterMs(response.headers.get('retry-after'))
      const id = requestId(response.headers)
      throw new LlmError(message, httpErrorCode(response.status, providerError), {
        status: response.status,
        ...delay === undefined ? {} : { providerRetryAfterMs: delay },
        ...id === undefined ? {} : { requestId: id },
      })
    }
    if (!response.body) {
      throw new LlmError('LongCat API returned no response body', 'EMPTY_RESPONSE')
    }

    yield* translate(parseSse(response.body, onComment))
  }

  /**
   * Prepare one request's images.
   *
   * The attachment provider and the execution-world access resolver are read
   * per request, so mounting or unmounting either reaches the next call. An
   * image-bearing request without a provider fails here, before the fetch.
   * @param options - the harness request.
   * @param connection - the frozen connection facts of this request.
   * @param signal - request cancellation, also covering image derivation.
   * @returns the serializable history (offloaded occurrences already replaced
   *   by placeholder text) and the request bytes, or no context for a text-only turn.
   */
  private async prepareRequestImages(
    options: GenerateOptions,
    connection: LongCatConnectionOptions,
    signal: AbortSignal,
  ): Promise<{ messages: readonly RequestMessage[]; images?: ImageSerializationContext }> {
    const carriesImage = options.messages.some(
      message => message.content.some(block => block.type === 'image'),
    )
    if (!carriesImage) return { messages: options.messages }
    const attachments = this.config.resolveAttachments?.()
    const access: ImageAttachmentAccessResolver = ref => attachments === undefined
      ? undefined
      : this.config.resolveImageAccess?.(attachments, ref)
    const prepared = await prepareImages(options.messages, {
      model: connection.models.find(entry => entry.id === options.model),
      attachments,
      access,
      maxRequestImageBytes: connection.maxRequestImageBytes,
      ...connection.maxImagesPerRequest === undefined
        ? {}
        : { maxImagesPerRequest: connection.maxImagesPerRequest },
      signal,
    })
    return { messages: prepared.messages, images: { versions: prepared.versions, access } }
  }
}
