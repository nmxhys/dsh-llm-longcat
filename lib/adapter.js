/**
 * `LongCatAdapter`: fetch + SSE against LongCat's OpenAI-compatible
 * chat-completions endpoint, emitting harness StreamChunks. The adapter is
 * transport-only: connection facts arrive through a thunk resolved once per
 * operation and the bearer token through a per-request resolver, so the
 * registering plugin owns validation, layering, and credential policy.
 *
 * @module dsh-llm-longcat/adapter
 */
var __addDisposableResource = (this && this.__addDisposableResource) || function (env, value, async) {
    if (value !== null && value !== void 0) {
        if (typeof value !== "object" && typeof value !== "function") throw new TypeError("Object expected.");
        var dispose, inner;
        if (async) {
            if (!Symbol.asyncDispose) throw new TypeError("Symbol.asyncDispose is not defined.");
            dispose = value[Symbol.asyncDispose];
        }
        if (dispose === void 0) {
            if (!Symbol.dispose) throw new TypeError("Symbol.dispose is not defined.");
            dispose = value[Symbol.dispose];
            if (async) inner = dispose;
        }
        if (typeof dispose !== "function") throw new TypeError("Object not disposable.");
        if (inner) dispose = function() { try { inner.call(this); } catch (e) { return Promise.reject(e); } };
        env.stack.push({ value: value, dispose: dispose, async: async });
    }
    else if (async) {
        env.stack.push({ async: true });
    }
    return value;
};
var __disposeResources = (this && this.__disposeResources) || (function (SuppressedError) {
    return function (env) {
        function fail(e) {
            env.error = env.hasError ? new SuppressedError(e, env.error, "An error was suppressed during disposal.") : e;
            env.hasError = true;
        }
        var r, s = 0;
        function next() {
            while (r = env.stack.pop()) {
                try {
                    if (!r.async && s === 1) return s = 0, env.stack.push(r), Promise.resolve().then(next);
                    if (r.dispose) {
                        var result = r.dispose.call(r.value);
                        if (r.async) return s |= 2, Promise.resolve(result).then(next, function(e) { fail(e); return next(); });
                    }
                    else s |= 1;
                }
                catch (e) {
                    fail(e);
                }
            }
            if (s === 1) return env.hasError ? Promise.reject(env.error) : Promise.resolve();
            if (env.hasError) throw env.error;
        }
        return next();
    };
})(typeof SuppressedError === "function" ? SuppressedError : function (error, suppressed, message) {
    var e = new Error(message);
    return e.name = "SuppressedError", e.error = error, e.suppressed = suppressed, e;
});
import { attributionHeaders, CONTEXT_WINDOW_EXCEEDED_CODE, isContextWindowExceededError, isQuotaExceededError, LlmAdapter, LlmError, ProviderRequestId, QUOTA_EXCEEDED_CODE, ReasoningEffortId, } from '@deepseek-ai/dsh-llm';
import { idleWatchdog, timeoutOf } from '@deepseek-ai/dsh-timeout';
import { prepareImages } from "./images.js";
import { serializeRequest } from "./serialize.js";
import { parseSse } from "./sse.js";
import { translate } from "./translate.js";
/** Default maximum idle interval while a stream read is outstanding. */
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000;
/** LongCat-2.0 `context_length` from the model-detail endpoint. */
export const DEFAULT_CONTEXT_WINDOW = 1_048_576;
/** Documented `max_tokens` cap for LongCat-2.0. */
export const DEFAULT_MAX_TOKENS = 131_072;
const STREAM_IDLE_TIMEOUT_CODE = 'LLM_STREAM_IDLE_TIMEOUT';
const OFF_REASONING_EFFORT = ReasoningEffortId('off');
const HIGH_REASONING_EFFORT = ReasoningEffortId('high');
/**
 * The selectable efforts. LongCat's thinking switch is binary — its
 * `supported_parameters` lists `thinking` and no `reasoning_effort` — so
 * offering `low`/`max` would advertise controls that collapse onto the same
 * two wire bodies.
 */
const REASONING_EFFORTS = [
    { id: OFF_REASONING_EFFORT, name: 'Off' },
    { id: HIGH_REASONING_EFFORT, name: 'Thinking' },
];
const OFF_ONLY_REASONING_EFFORTS = [
    { id: OFF_REASONING_EFFORT, name: 'Off' },
];
function modelInfo(provider, model) {
    return {
        provider,
        id: model.id,
        name: model.name ?? model.id,
        ...model.description === undefined ? {} : { description: model.description },
        inputModalities: model.inputModalities ?? ['text'],
    };
}
function providerRetryAfterMs(value) {
    if (value === null)
        return undefined;
    if (/^\d+$/.test(value)) {
        const delay = Number(value) * 1_000;
        return Number.isFinite(delay) && delay > 0 ? delay : undefined;
    }
    const delay = Date.parse(value) - Date.now();
    return Number.isFinite(delay) && delay > 0 ? delay : undefined;
}
function requestId(headers) {
    const value = headers.get('x-request-id') ?? headers.get('x-longcat-request-id');
    return value === null || value.length === 0 ? undefined : ProviderRequestId(value);
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
export function httpErrorCode(status, error) {
    const detail = [error?.code, error?.type, error?.message].filter(Boolean).join(' ');
    // 402 is LongCat's documented "insufficient token quota".
    if (status === 402)
        return QUOTA_EXCEEDED_CODE;
    if (isQuotaExceededError(detail))
        return QUOTA_EXCEEDED_CODE;
    if (status === 401)
        return 'AUTH';
    // A 403 carrying quota detail was caught above; anything else is a genuine
    // permission failure.
    if (status === 403)
        return 'AUTH';
    if (status === 429)
        return 'RATE_LIMIT';
    if (status === 400) {
        if (isContextWindowExceededError(detail))
            return CONTEXT_WINDOW_EXCEEDED_CODE;
        return 'INVALID_REQUEST';
    }
    if (status >= 500)
        return 'SERVER';
    return `HTTP_${status}`;
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
    config;
    constructor(config) {
        super();
        this.config = config;
    }
    providerInfo(provider) {
        return { id: provider, name: 'LongCat' };
    }
    providerRetryPolicy(_provider) {
        return this.config.options().retryPolicy;
    }
    listModels(provider) {
        return Promise.resolve(this.config.options().models.map(model => modelInfo(provider, model)));
    }
    resolveModel(provider, model, _signal) {
        const connection = this.config.options();
        const configured = connection.models.find(entry => entry.id === model);
        return Promise.resolve({
            // An uncatalogued id declares text-only: "unknown" would let the host
            // accept and durably persist images this adapter has no policy to
            // encode, and the serializer would then have to refuse the turn.
            ...configured === undefined
                ? { provider, id: model, name: model, inputModalities: ['text'] }
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
        });
    }
    async *stream(options) {
        const env_1 = { stack: [], error: void 0, hasError: false };
        try {
            // LongCat's supported_parameters does not include `stop`. Failing loudly
            // beats sending it and having generation silently run past the sequence
            // the caller depended on.
            if (options.stop !== undefined) {
                throw new LlmError('LongCat does not support stop sequences', 'UNSUPPORTED_OPTION');
            }
            // One resolution per stream call: connection facts and the credential
            // freeze here and hold for this whole request, so an in-flight stream
            // never observes a configuration change and the next call re-resolves.
            const connection = this.config.options();
            const apiKey = await this.config.resolveApiKey(connection);
            const consumer = new AbortController();
            const upstream = options.signal === undefined
                ? consumer.signal
                : AbortSignal.any([options.signal, consumer.signal]);
            const watchdog = __addDisposableResource(env_1, idleWatchdog(upstream, connection.streamIdleTimeoutMs, STREAM_IDLE_TIMEOUT_CODE), false);
            const iterator = this.request(options, watchdog.signal, connection, apiKey, () => { watchdog.pulse(); })[Symbol.asyncIterator]();
            let exhausted = false;
            try {
                while (true) {
                    const result = await watchdog.next(iterator);
                    if (result.done) {
                        exhausted = true;
                        return;
                    }
                    yield result.value;
                }
            }
            catch (error) {
                if (timeoutOf(watchdog.signal, STREAM_IDLE_TIMEOUT_CODE) !== undefined) {
                    throw new LlmError(`LongCat stream idle timeout after ${connection.streamIdleTimeoutMs}ms`, 'TIMEOUT', { cause: error });
                }
                if (options.signal?.aborted) {
                    throw new LlmError('LongCat request aborted by caller', 'ABORTED', { cause: error });
                }
                if (error instanceof LlmError)
                    throw error;
                throw new LlmError(`LongCat API stream from ${connection.baseURL} failed`, 'TRANSPORT', { cause: error });
            }
            finally {
                consumer.abort('LongCat stream consumer stopped');
                if (!exhausted && iterator.return !== undefined) {
                    try {
                        await iterator.return();
                    }
                    catch (_abortedTransportTeardown) {
                        // The consumer controller already owns termination; a return-time
                        // abort cannot add a second outcome.
                    }
                }
            }
        }
        catch (e_1) {
            env_1.error = e_1;
            env_1.hasError = true;
        }
        finally {
            __disposeResources(env_1);
        }
    }
    async *request(options, signal, connection, apiKey, onComment) {
        // Images are prepared before serialization: the request version bytes are
        // the wire payload, and an over-budget or unsupported image must fail
        // before any network I/O.
        const prepared = await this.prepareRequestImages(options, connection, signal);
        const body = serializeRequest({ ...options, messages: prepared.messages }, connection.defaults, prepared.images);
        // Prepared outside the try so the TRANSPORT label below covers exactly
        // the transport boundary, never a serialization failure.
        const payload = JSON.stringify(body);
        const headers = {
            'authorization': `Bearer ${apiKey}`,
            'content-type': 'application/json',
            'accept': 'text/event-stream',
            ...attributionHeaders(),
        };
        let response;
        try {
            response = await fetch(`${connection.baseURL}/chat/completions`, {
                method: 'POST',
                headers,
                body: payload,
                signal,
            });
        }
        catch (error) {
            // The outer stream distinguishes caller cancellation and watchdog expiry.
            if (signal.aborted)
                throw error;
            // fetch wraps every transport failure (DNS, refused connection, TLS,
            // proxy) in a bare `TypeError: fetch failed` whose actionable detail
            // lives on `cause`.
            throw new LlmError(`LongCat API request to ${connection.baseURL} failed`, 'TRANSPORT', { cause: error });
        }
        if (!response.ok) {
            let message = `LongCat API error (HTTP ${response.status})`;
            let providerError;
            try {
                const parsed = await response.json();
                providerError = parsed.error;
                if (providerError?.message)
                    message = providerError.message;
            }
            catch {
                // Only swallow error-body parsing: the HTTP status still identifies
                // the failure, so malformed gateway JSON must not mask it.
            }
            const delay = providerRetryAfterMs(response.headers.get('retry-after'));
            const id = requestId(response.headers);
            throw new LlmError(message, httpErrorCode(response.status, providerError), {
                status: response.status,
                ...delay === undefined ? {} : { providerRetryAfterMs: delay },
                ...id === undefined ? {} : { requestId: id },
            });
        }
        if (!response.body) {
            throw new LlmError('LongCat API returned no response body', 'EMPTY_RESPONSE');
        }
        yield* translate(parseSse(response.body, onComment));
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
    async prepareRequestImages(options, connection, signal) {
        const carriesImage = options.messages.some(message => message.content.some(block => block.type === 'image'));
        if (!carriesImage)
            return { messages: options.messages };
        const attachments = this.config.resolveAttachments?.();
        const access = ref => attachments === undefined
            ? undefined
            : this.config.resolveImageAccess?.(attachments, ref);
        const prepared = await prepareImages(options.messages, {
            model: connection.models.find(entry => entry.id === options.model),
            attachments,
            access,
            maxRequestImageBytes: connection.maxRequestImageBytes,
            ...connection.maxImagesPerRequest === undefined
                ? {}
                : { maxImagesPerRequest: connection.maxImagesPerRequest },
            signal,
        });
        return { messages: prepared.messages, images: { versions: prepared.versions, access } };
    }
}
