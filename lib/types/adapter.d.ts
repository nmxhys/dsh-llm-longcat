/**
 * `LongCatAdapter`: fetch + SSE against LongCat's OpenAI-compatible
 * chat-completions endpoint, emitting harness StreamChunks. The adapter is
 * transport-only: connection facts arrive through a thunk resolved once per
 * operation and the bearer token through a per-request resolver, so the
 * registering plugin owns validation, layering, and credential policy.
 *
 * @module dsh-llm-longcat/adapter
 */
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
import type { GenerateOptions, LlmModelInfo, LlmProviderInfo, LlmResolvedModelInfo, ResolvedRetryPolicy, StreamChunk } from '@deepseek-ai/dsh-llm';
import type { CredentialRef } from '@deepseek-ai/dsh-credentials';
import type { RequestDefaults } from './serialize.ts';
import type { WireError } from './types.ts';
/** One optional model entry advertised by this adapter. */
export interface LongCatCatalogModel {
    /** Wire model id accepted by the configured endpoint. */
    id: string;
    /** Selector label; defaults to {@link id}. */
    name?: string;
    /** Optional selector detail. */
    description?: string;
    /** Known combined request/response context capacity. */
    contextWindow?: number;
    /** Per-request output cap for this model; omission falls back to the profile value. */
    maxTokens?: number;
}
/**
 * Validated connection facts for one operation. The plugin's
 * `resolveAdapterOptions` is the one explicit resolve step producing this
 * shape; the adapter re-reads it per operation, which is what makes a
 * configuration change reach the next request without re-registration.
 */
export interface LongCatConnectionOptions {
    /** Endpoint base; `/chat/completions` is appended. */
    baseURL: string;
    /**
     * Credential reference from this same resolution, resolved per request.
     * Travelling with the endpoint is the point: a request can never pair one
     * generation's URL with another generation's secret.
     */
    apiKeyEnv: CredentialRef;
    /** Request defaults applied to every call. */
    defaults: RequestDefaults;
    /** Default per-request output cap; explicit request values win. */
    maxTokens: number;
    /** Context capacity used when the selected model has no exact value. */
    defaultContextWindow: number;
    /** Advisory models exposed to discovery consumers; requests remain unrestricted. */
    models: readonly LongCatCatalogModel[];
    /** Maximum provider idle time while one stream read is outstanding. */
    streamIdleTimeoutMs: number;
    /** Provider-owned model-request retry policy, already resolved. */
    retryPolicy: ResolvedRetryPolicy;
}
/** Constructor options: the operation-local resolution hooks the plugin owns. */
export interface LongCatAdapterOptions {
    /** Current validated connection facts; called once per operation. */
    options: () => LongCatConnectionOptions;
    /**
     * Resolve the bearer token for the connection facts of one request. The
     * snapshot is passed in — never re-read — so the key can only ever come
     * from the same resolution as the endpoint it is sent to.
     */
    resolveApiKey: (connection: LongCatConnectionOptions) => Promise<string>;
}
/** Default maximum idle interval while a stream read is outstanding. */
export declare const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300000;
/** LongCat-2.0 `context_length` from the model-detail endpoint. */
export declare const DEFAULT_CONTEXT_WINDOW = 1048576;
/** Documented `max_tokens` cap for LongCat-2.0. */
export declare const DEFAULT_MAX_TOKENS = 131072;
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
export declare function httpErrorCode(status: number, error?: WireError['error']): string;
/**
 * LongCat chat-completions adapter. One instance serves every model name it
 * was registered under (the harness model name IS the wire model name).
 *
 * One stable signal reaches both the initial fetch and the body reads. Caller
 * aborts map to `ABORTED`; the configured per-read idle watchdog maps to
 * `TIMEOUT`.
 */
export declare class LongCatAdapter extends LlmAdapter {
    private readonly config;
    constructor(config: LongCatAdapterOptions);
    providerInfo(provider: string): LlmProviderInfo;
    providerRetryPolicy(_provider: string): ResolvedRetryPolicy;
    listModels(provider: string): Promise<readonly LlmModelInfo[]>;
    resolveModel(provider: string, model: string, _signal?: AbortSignal): Promise<LlmResolvedModelInfo>;
    stream(options: GenerateOptions): AsyncIterable<StreamChunk>;
    private request;
}
