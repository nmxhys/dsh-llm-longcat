/**
 * Register a {@link LongCatAdapter} for the `longcat` provider route on
 * `ctx.llm`, with connection facts resolved per request instead of frozen at
 * load: the plugin reads its profile-entry config (`cordis.patch.yml`, or the
 * generated settings form that projects this plugin's `Config` schema) and
 * resolves the API key through the optional credential seam
 * (`ctx.credentials`), so a changed base URL, catalog, or key reaches the very
 * next request, while an in-flight stream keeps the facts it started with. The
 * one registration-captured fact — the retry policy — re-registers the route in
 * place when a volatile config update changes it.
 *
 * @module dsh-llm-longcat
 */

import type { Context, Volatile } from '@deepseek-ai/cordis'
// Loads the loader's `fiber.entry` typing: the settings form keys a plugin's
// Config schema by its composition entry id, which is what `settingsNs` names.
import type {} from '@deepseek-ai/cordis-plugin-loader'
import z from '@deepseek-ai/schemastery'
import { assertUsableApiKey, LlmError, resolveImageAttachmentAccess, resolveRetryPolicy, RetryPolicySchema } from '@deepseek-ai/dsh-llm'
import type { ModelModality, ResolvedRetryPolicy, RetryPolicyConfig } from '@deepseek-ai/dsh-llm'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { launchEnvironmentOf, type LaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { deepEqualJson } from '@deepseek-ai/dsh-util-values'
import {
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_TOKENS,
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  LongCatAdapter,
} from './adapter.ts'
import type { LongCatCatalogModel, LongCatConnectionOptions } from './adapter.ts'
import { DEFAULT_MAX_REQUEST_IMAGE_BYTES } from './images.ts'

export {
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_TOKENS,
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  LongCatAdapter,
  httpErrorCode,
} from './adapter.ts'
export type { LongCatAdapterOptions, LongCatCatalogModel, LongCatConnectionOptions } from './adapter.ts'
export {
  DEFAULT_IMAGE_MAX_BYTES,
  DEFAULT_IMAGE_PIXEL_BUDGET,
  DEFAULT_MAX_REQUEST_IMAGE_BYTES,
  imageRequestTarget,
  prepareImages,
} from './images.ts'
export type { LongCatImagePolicy, LongCatImageRequestOptions, PreparedImages } from './images.ts'
export type { RequestDefaults, LongCatEffort } from './serialize.ts'
export type * from './types.ts'

export const name = 'llm-longcat'
export const inject = ['llm']

const DEFAULT_API_KEY_ENV = 'LONGCAT_API_KEY'
/** The single provider route this plugin owns. */
const PROVIDER = 'longcat'

/** Public API default; an internal endpoint may come from $LONGCAT_BASE_URL. */
export const PUBLIC_BASE_URL = 'https://api.longcat.chat/openai/v1'

/** Environment variable naming this provider's endpoint, honored only from trusted layers. */
const BASE_URL_ENV = 'LONGCAT_BASE_URL'

/** Every request modality a catalog entry may declare. */
const MODEL_MODALITIES = ['text', 'image'] as const satisfies readonly ModelModality[]

/**
 * The shipped catalog.
 *
 * Facts from `GET /openai/v1/models/{model}`: both models report
 * `context_length: 1048576`, and the documented `max_tokens` cap is 131072.
 * LongCat-2.5-Preview reports `modality: text+image->text`; LongCat-2.0 is
 * text-only.
 */
const DEFAULT_MODELS: CatalogModelSchemaShape[] = [
  {
    id: 'LongCat-2.5-Preview',
    name: 'LongCat-2.5-Preview',
    description: 'Native multi-modal agentic model; accepts text and images.',
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: DEFAULT_MAX_TOKENS,
    inputModalities: ['text', 'image'],
  },
  {
    id: 'LongCat-2.0',
    name: 'LongCat-2.0',
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: DEFAULT_MAX_TOKENS,
    inputModalities: ['text'],
  },
]

/**
 * Plugin config, validated by the same-named schemastery schema. This is the
 * live configuration the Loader resolves for the plugin entry, and the shape
 * the harness projects into its settings form.
 *
 * Every field is optional: a missing API key resolves through
 * {@link Config.apiKeyEnv} at each request, so a request without any key fails
 * with `MISSING_CREDENTIAL` rather than failing plugin load — first-run
 * onboarding is "browse models, store the key, prompt again", with no restart
 * between.
 *
 * `apiKeyEnv`, `models`, and `retryPolicy` are volatile: editing a credential
 * reference, the catalog, or the retry policy updates the running route in
 * place instead of remounting it, so an added model or a changed policy
 * reaches the very next request.
 */
export interface Config {
  /** Credential reference (environment-variable name) resolved per request; defaults to `LONGCAT_API_KEY`. */
  apiKeyEnv: Volatile<string>
  /** Endpoint base; falls back to $LONGCAT_BASE_URL from a trusted environment layer, then the public API. */
  baseURL?: string
  /** Deployment thinking policy; `disabled` limits every conversation request to `off`. */
  thinking?: 'enabled' | 'disabled'
  /**
   * Default thinking state. LongCat's switch is binary, so only `off` and
   * `high` exist — there is no gradient to configure.
   */
  reasoningEffort?: 'off' | 'high'
  /** Default per-request output cap (default 131,072, the documented cap). */
  maxTokens?: number
  /** Context capacity used when the selected model has no exact value (default 1,048,576). */
  defaultContextWindow?: number
  /** Accumulated base64 payload bound for one request's images (default 20 MiB). */
  maxRequestImageBytes?: number
  /** Optional bound on retained image occurrences per request; omission leaves the count unbounded. */
  maxImagesPerRequest?: number
  /** Advisory models shown by discovery consumers; defaults to the two shipped models. */
  models?: Volatile<LongCatCatalogModel[]>
  /** Maximum provider idle time while one stream read is outstanding (default five minutes). */
  streamIdleTimeoutMs?: number
  /**
   * Provider-owned model-request retry policy; omission uses normal defaults.
   * Volatile because the registry captures it at registration: a change is
   * applied to the running route in place instead of remounting it.
   */
  retryPolicy?: Volatile<RetryPolicyConfig>
}

/** Deployment inputs with the volatile fields read out of their wrappers. */
export type Options = Omit<Config, 'apiKeyEnv' | 'models' | 'retryPolicy'> & {
  /** Plain credential reference for this configuration generation. */
  apiKeyEnv?: string
  /** Plain model catalog for this configuration generation. */
  models?: readonly LongCatCatalogModel[]
  /** Plain retry policy for this configuration generation. */
  retryPolicy?: RetryPolicyConfig
}

/**
 * The catalog schema's own shape: schemastery builds mutable properties and a
 * mutable modality array, while the adapter reads the resolved catalog as
 * immutable data — exactly what the volatile snapshot hands back.
 */
type CatalogModelSchemaShape = Omit<LongCatCatalogModel, 'inputModalities'> & {
  inputModalities?: ModelModality[]
}

const catalogModel: z<CatalogModelSchemaShape> = z.object({
  id: z.string().required(),
  name: z.string(),
  description: z.string(),
  contextWindow: z.number().step(1).min(1),
  maxTokens: z.number().step(1).min(1),
  inputModalities: z.array(z.union(MODEL_MODALITIES)).min(1).default(['text']),
  imageMaxPixels: z.number().step(1).min(1),
  imageMaxBytes: z.number().step(1).min(1),
})

// Deliberately unannotated: schemastery types a volatile field as its plain
// value while its metadata keeps the wrapper, so `z<Config>` cannot be
// satisfied by a schema that declares one — the in-tree provider plugins split
// the same way, with the `Config` interface above as the runtime contract.
export const Config = z.object({
  apiKeyEnv: z.string().role('credential-ref').default(DEFAULT_API_KEY_ENV).volatile(),
  baseURL: z.string(),
  thinking: z.union(['enabled', 'disabled']),
  reasoningEffort: z.union(['off', 'high']),
  maxTokens: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(DEFAULT_MAX_TOKENS),
  defaultContextWindow: z.number().step(1).min(1).default(DEFAULT_CONTEXT_WINDOW),
  maxRequestImageBytes: z.number().step(1).min(1).default(DEFAULT_MAX_REQUEST_IMAGE_BYTES),
  maxImagesPerRequest: z.number().step(1).min(1),
  models: z.array(catalogModel).default(DEFAULT_MODELS).volatile(),
  streamIdleTimeoutMs: z.number().min(Number.MIN_VALUE).max(MAX_TIMER_DELAY_MS).default(DEFAULT_STREAM_IDLE_TIMEOUT_MS),
  retryPolicy: RetryPolicySchema.volatile(),
})

/** One resolution's complete request facts. */
export type ResolvedLongCatOptions = LongCatConnectionOptions

/**
 * Read one validated configuration generation out of its live form.
 * @param config - live plugin configuration.
 * @returns detached resolver inputs.
 */
export function plainOptions(config: Config): Options {
  // The volatile wrappers are dropped rather than spread: their snapshots are
  // deeply readonly and one generation's catalog must not carry a live handle
  // into a resolved connection snapshot.
  const { apiKeyEnv, models: volatileModels, retryPolicy: volatilePolicy, ...rest } = config
  const models = volatileModels?.get()
  const retryPolicy = volatilePolicy?.get() as RetryPolicyConfig | undefined
  return {
    ...rest,
    apiKeyEnv: apiKeyEnv.get(),
    ...models === undefined ? {} : { models },
    ...retryPolicy === undefined ? {} : { retryPolicy },
  }
}

/** Resolve, validate, and detach the advisory model catalog. */
function resolveModels(models: readonly LongCatCatalogModel[] | undefined): LongCatCatalogModel[] {
  const seen = new Set<string>()
  return (models ?? DEFAULT_MODELS).map((model) => {
    if (model.id.length === 0) throw new Error('llm-longcat: catalog model ids must be non-empty')
    if (model.name !== undefined && model.name.length === 0) {
      throw new Error(`llm-longcat: catalog model "${model.id}" has an empty name`)
    }
    if (model.contextWindow !== undefined
      && (!Number.isInteger(model.contextWindow) || model.contextWindow <= 0)) {
      throw new Error(`llm-longcat: catalog model "${model.id}" contextWindow must be a positive integer`)
    }
    if (model.maxTokens !== undefined
      && (!Number.isInteger(model.maxTokens) || model.maxTokens <= 0)) {
      throw new Error(`llm-longcat: catalog model "${model.id}" maxTokens must be a positive integer`)
    }
    const inputModalities = model.inputModalities ?? ['text']
    if (inputModalities.length === 0) {
      throw new Error(`llm-longcat: catalog model "${model.id}" inputModalities must not be empty`)
    }
    if (inputModalities.some(modality => !MODEL_MODALITIES.includes(modality))) {
      throw new Error(
        `llm-longcat: catalog model "${model.id}" inputModalities must contain only "text" and "image"`,
      )
    }
    if (new Set(inputModalities).size !== inputModalities.length) {
      throw new Error(`llm-longcat: catalog model "${model.id}" inputModalities must not contain duplicates`)
    }
    if (!inputModalities.includes('image')
      && (model.imageMaxPixels !== undefined || model.imageMaxBytes !== undefined)) {
      throw new Error(`llm-longcat: text-only catalog model "${model.id}" cannot declare image request limits`)
    }
    for (const [field, value] of [['imageMaxPixels', model.imageMaxPixels], ['imageMaxBytes', model.imageMaxBytes]] as const) {
      if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) {
        throw new Error(`llm-longcat: catalog model "${model.id}" ${field} must be a positive safe integer`)
      }
    }
    if (seen.has(model.id)) throw new Error(`llm-longcat: duplicate catalog model "${model.id}"`)
    seen.add(model.id)
    return {
      id: model.id,
      ...model.name === undefined ? {} : { name: model.name },
      ...model.description === undefined ? {} : { description: model.description },
      ...model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow },
      ...model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens },
      inputModalities: [...inputModalities],
      ...model.imageMaxPixels === undefined ? {} : { imageMaxPixels: model.imageMaxPixels },
      ...model.imageMaxBytes === undefined ? {} : { imageMaxBytes: model.imageMaxBytes },
    }
  })
}

/**
 * The one explicit resolve step from raw config to validated connection
 * facts. Programmatic construction may bypass Schemastery normalization, so
 * every default and bound is re-judged here — for the composition entry at
 * load (fail loud) and for every later resolution.
 * @param config - raw plugin config or a resolved settings snapshot.
 * @param environment - this run's environment layers, or `undefined` outside the product CLI.
 * @returns validated connection facts plus the credential reference.
 */
export function resolveAdapterOptions(
  config: Options,
  environment?: LaunchEnvironmentSnapshot,
): ResolvedLongCatOptions {
  if (config.thinking === 'disabled'
    && config.reasoningEffort !== undefined
    && config.reasoningEffort !== 'off') {
    throw new Error('llm-longcat: only reasoningEffort "off" can be configured when thinking is disabled')
  }
  if (config.defaultContextWindow !== undefined
    && (!Number.isInteger(config.defaultContextWindow) || config.defaultContextWindow <= 0)) {
    throw new Error('llm-longcat: defaultContextWindow must be a positive integer')
  }
  if (config.maxTokens !== undefined
    && (!Number.isSafeInteger(config.maxTokens) || config.maxTokens <= 0)) {
    throw new Error('llm-longcat: maxTokens must be a positive safe integer')
  }
  const streamIdleTimeoutMs = config.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS
  if (!Number.isFinite(streamIdleTimeoutMs)
    || streamIdleTimeoutMs <= 0
    || streamIdleTimeoutMs > MAX_TIMER_DELAY_MS) {
    throw new Error(
      `llm-longcat: streamIdleTimeoutMs must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`,
    )
  }
  const maxRequestImageBytes = config.maxRequestImageBytes ?? DEFAULT_MAX_REQUEST_IMAGE_BYTES
  if (!Number.isSafeInteger(maxRequestImageBytes) || maxRequestImageBytes <= 0) {
    throw new Error('llm-longcat: maxRequestImageBytes must be a positive safe integer')
  }
  if (config.maxImagesPerRequest !== undefined
    && (!Number.isSafeInteger(config.maxImagesPerRequest) || config.maxImagesPerRequest <= 0)) {
    throw new Error('llm-longcat: maxImagesPerRequest must be a positive safe integer')
  }
  return {
    apiKeyEnv: credentialRef(config.apiKeyEnv ?? DEFAULT_API_KEY_ENV),
    baseURL: config.baseURL
      ?? environment?.get(BASE_URL_ENV)?.value
      ?? PUBLIC_BASE_URL,
    defaults: {
      thinking: config.thinking,
      reasoningEffort: config.reasoningEffort,
    },
    maxTokens: config.maxTokens ?? DEFAULT_MAX_TOKENS,
    defaultContextWindow: config.defaultContextWindow ?? DEFAULT_CONTEXT_WINDOW,
    models: resolveModels(config.models),
    maxRequestImageBytes,
    ...config.maxImagesPerRequest === undefined ? {} : { maxImagesPerRequest: config.maxImagesPerRequest },
    streamIdleTimeoutMs,
    retryPolicy: resolveRetryPolicy(config.retryPolicy, 'llm-longcat: retryPolicy'),
  }
}

export function apply(ctx: Context, config: Config): void {
  const options = (): ResolvedLongCatOptions => resolveAdapterOptions(plainOptions(config), launchEnvironmentOf(ctx))
  // Resolve once at load so a bad composition fails loud instead of at the
  // first request.
  options()

  const resolveApiKey = async (connection: ResolvedLongCatOptions): Promise<string> => {
    // Every credential fact comes from the caller's snapshot, so a rejected
    // configuration generation cannot leak its key onto the previous endpoint.
    const ref = connection.apiKeyEnv
    const credentials = ctx.get('credentials')
    if (credentials !== undefined) {
      const hit = await credentials.resolve(ref)
      if (hit !== undefined) return assertUsableApiKey(hit.value, 'llm-longcat', ref)
    } else {
      // Without the seam there is no managed store to rank against, so the
      // environment is the whole credential plane.
      const ambient = launchEnvironmentOf(ctx).get(ref)
      if (ambient !== undefined && ambient.value.length > 0) {
        return assertUsableApiKey(ambient.value, 'llm-longcat', ref)
      }
    }
    throw new LlmError(
      `llm-longcat: no API key for provider route "${PROVIDER}"; store ${ref} through the credentials`
      + ` service (the web Models page writes it), or export ${ref} in the launching environment.`
      + ' Create a key at https://longcat.chat/platform/api_keys',
      'MISSING_CREDENTIAL',
    )
  }

  const adapter = new LongCatAdapter({
    options,
    resolveApiKey,
    // Images ride the durable attachment plane; both hooks are read per
    // request, so mounting either reaches the next call without a restart.
    resolveAttachments: () => ctx.get('attachments'),
    resolveImageAccess: (attachments, ref) => resolveImageAttachmentAccess(
      attachments,
      // Structural face: this plugin needs only this one mapping method, and
      // dsh-llm keeps the same shape rather than depending on the filesystem package.
      hostPath => (ctx.get('fs') as { processPathFromHostPath(path: string): string | undefined } | undefined)
        ?.processPathFromHostPath(hostPath),
      ref,
    ),
  })
  ctx.llm.registerConfigurableProviders([
    // The settings form keys this plugin's Config schema by its composition
    // entry id, so the directory entry names that id rather than a namespace.
    { provider: PROVIDER, displayName: 'LongCat', settingsNs: ctx.fiber.entry?.options.id ?? name, settingsPath: [] },
  ])
  const registration = ctx.llm.registerAdapter([PROVIDER], adapter)
  let registeredPolicy = options().retryPolicy
  // Only volatile config changes reach a running plugin without a remount; the
  // retry policy is captured by the registry at registration, so a changed one
  // is re-read here.
  ctx.on('loader/volatile-update', () => {
    let policy: ResolvedRetryPolicy
    try {
      policy = options().retryPolicy
    } catch (error) {
      ctx.logger.warn('llm-longcat: keeping the running route after an invalid configuration update')
      ctx.logger.warn(error)
      return
    }
    if (deepEqualJson(policy, registeredPolicy)) return
    // `replace` re-reads the policy in one synchronous registry section:
    // disposing and re-registering instead would publish an empty route set
    // between the two.
    registration.replace([PROVIDER])
    registeredPolicy = policy
  })
}
