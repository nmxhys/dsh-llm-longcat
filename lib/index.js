/**
 * Register a {@link LongCatAdapter} for the `longcat` provider route on
 * `ctx.llm`, with connection facts resolved per request instead of frozen at
 * load: the plugin layers its entry config under the optional `llm-longcat`
 * user-settings section (`ctx.settings`) and resolves the API key through the
 * optional credential seam (`ctx.credentials`), so a changed base URL,
 * catalog, or key reaches the very next request without restarting anything,
 * while an in-flight stream keeps the facts it started with. The one
 * registration-captured fact — the retry policy — re-registers the route in
 * place when it changes.
 *
 * @module dsh-llm-longcat
 */
import z from '@deepseek-ai/schemastery';
import { assertUsableApiKey, LlmError, resolveRetryPolicy, RetryPolicySchema } from '@deepseek-ai/dsh-llm';
import { credentialRef } from '@deepseek-ai/dsh-credentials';
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment';
import { deepEqualJson, installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings';
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout';
import { DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_TOKENS, DEFAULT_STREAM_IDLE_TIMEOUT_MS, LongCatAdapter, } from "./adapter.js";
export { DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_TOKENS, DEFAULT_STREAM_IDLE_TIMEOUT_MS, LongCatAdapter, httpErrorCode, } from "./adapter.js";
export const name = 'llm-longcat';
export const inject = ['llm'];
const NS = settingsNamespace('llm-longcat');
const DEFAULT_API_KEY_ENV = 'LONGCAT_API_KEY';
/** The single provider route this plugin owns. */
const PROVIDER = 'longcat';
/** Public API default; an internal endpoint may come from $LONGCAT_BASE_URL. */
export const PUBLIC_BASE_URL = 'https://api.longcat.chat/openai/v1';
/** Environment variable naming this provider's endpoint, honored only from trusted layers. */
const BASE_URL_ENV = 'LONGCAT_BASE_URL';
const DEFAULT_MODELS = [
    {
        id: 'LongCat-2.0',
        name: 'LongCat-2.0',
        contextWindow: DEFAULT_CONTEXT_WINDOW,
        maxTokens: DEFAULT_MAX_TOKENS,
    },
];
const catalogModel = z.object({
    id: z.string().required(),
    name: z.string(),
    description: z.string(),
    contextWindow: z.number().step(1).min(1),
    maxTokens: z.number().step(1).min(1),
});
export const Config = z.object({
    apiKeyEnv: z.string().role('credential-ref').default(DEFAULT_API_KEY_ENV),
    baseURL: z.string(),
    thinking: z.union(['enabled', 'disabled']),
    reasoningEffort: z.union(['off', 'high']),
    maxTokens: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(DEFAULT_MAX_TOKENS),
    defaultContextWindow: z.number().step(1).min(1).default(DEFAULT_CONTEXT_WINDOW),
    models: z.array(catalogModel).default(DEFAULT_MODELS),
    streamIdleTimeoutMs: z.number().min(Number.MIN_VALUE).max(MAX_TIMER_DELAY_MS).default(DEFAULT_STREAM_IDLE_TIMEOUT_MS),
    retryPolicy: RetryPolicySchema,
});
/** Resolve, validate, and detach the advisory model catalog. */
function resolveModels(models) {
    const seen = new Set();
    return (models ?? DEFAULT_MODELS).map((model) => {
        if (model.id.length === 0)
            throw new Error('llm-longcat: catalog model ids must be non-empty');
        if (model.name !== undefined && model.name.length === 0) {
            throw new Error(`llm-longcat: catalog model "${model.id}" has an empty name`);
        }
        if (model.contextWindow !== undefined
            && (!Number.isInteger(model.contextWindow) || model.contextWindow <= 0)) {
            throw new Error(`llm-longcat: catalog model "${model.id}" contextWindow must be a positive integer`);
        }
        if (model.maxTokens !== undefined
            && (!Number.isInteger(model.maxTokens) || model.maxTokens <= 0)) {
            throw new Error(`llm-longcat: catalog model "${model.id}" maxTokens must be a positive integer`);
        }
        if (seen.has(model.id))
            throw new Error(`llm-longcat: duplicate catalog model "${model.id}"`);
        seen.add(model.id);
        return {
            id: model.id,
            ...model.name === undefined ? {} : { name: model.name },
            ...model.description === undefined ? {} : { description: model.description },
            ...model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow },
            ...model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens },
        };
    });
}
/**
 * The one explicit resolve step from raw config to validated connection
 * facts. Programmatic construction may bypass Schemastery normalization, so
 * every default and bound is re-judged here — for the composition entry at
 * load (fail loud) and for each settings snapshot at its first use.
 * @param config - raw plugin config or resolved settings snapshot.
 * @param environment - this run's environment layers, or `undefined` outside the product CLI.
 * @returns validated connection facts plus the credential reference.
 */
export function resolveAdapterOptions(config, environment) {
    if (config.thinking === 'disabled'
        && config.reasoningEffort !== undefined
        && config.reasoningEffort !== 'off') {
        throw new Error('llm-longcat: only reasoningEffort "off" can be configured when thinking is disabled');
    }
    if (config.defaultContextWindow !== undefined
        && (!Number.isInteger(config.defaultContextWindow) || config.defaultContextWindow <= 0)) {
        throw new Error('llm-longcat: defaultContextWindow must be a positive integer');
    }
    if (config.maxTokens !== undefined
        && (!Number.isSafeInteger(config.maxTokens) || config.maxTokens <= 0)) {
        throw new Error('llm-longcat: maxTokens must be a positive safe integer');
    }
    const streamIdleTimeoutMs = config.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS;
    if (!Number.isFinite(streamIdleTimeoutMs)
        || streamIdleTimeoutMs <= 0
        || streamIdleTimeoutMs > MAX_TIMER_DELAY_MS) {
        throw new Error(`llm-longcat: streamIdleTimeoutMs must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`);
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
        streamIdleTimeoutMs,
        retryPolicy: resolveRetryPolicy(config.retryPolicy, 'llm-longcat: retryPolicy'),
    };
}
export function apply(ctx, config) {
    let current = () => config;
    let lastRaw;
    let lastGood;
    const options = () => {
        const raw = current();
        if (raw === lastRaw && lastGood !== undefined)
            return lastGood;
        try {
            const next = resolveAdapterOptions(raw, launchEnvironmentOf(ctx));
            lastRaw = raw;
            lastGood = next;
            return next;
        }
        catch (error) {
            // Static composition resolves before anything registers, so this branch
            // only sees a live settings snapshot failing a beyond-schema bound:
            // keep serving the last good facts and say so once per bad snapshot.
            if (lastGood === undefined)
                throw error;
            lastRaw = raw;
            ctx.logger.error('llm-longcat: keeping the last good configuration after an invalid settings section');
            ctx.logger.error(error);
            return lastGood;
        }
    };
    options();
    const resolveApiKey = async (connection) => {
        // Every credential fact comes from the caller's snapshot, so a rejected
        // settings generation cannot leak its key onto the previous endpoint.
        const ref = connection.apiKeyEnv;
        const credentials = ctx.get('credentials');
        if (credentials !== undefined) {
            const hit = await credentials.resolve(ref);
            if (hit !== undefined)
                return assertUsableApiKey(hit.value, 'llm-longcat', ref);
        }
        else {
            // Without the seam there is no managed store to rank against, so the
            // environment is the whole credential plane.
            const ambient = launchEnvironmentOf(ctx).get(ref);
            if (ambient !== undefined && ambient.value.length > 0) {
                return assertUsableApiKey(ambient.value, 'llm-longcat', ref);
            }
        }
        throw new LlmError(`llm-longcat: no API key for provider route "${PROVIDER}"; store ${ref} through the credentials`
            + ` service (the web Models page writes it), or export ${ref} in the launching environment.`
            + ' Create a key at https://longcat.chat/platform/api_keys', 'MISSING_CREDENTIAL');
    };
    const adapter = new LongCatAdapter({ options, resolveApiKey });
    ctx.llm.registerConfigurableProviders([
        { provider: PROVIDER, displayName: 'LongCat', settingsNs: NS, settingsPath: [] },
    ]);
    // Route effects bind to this apply fiber via the stable `ctx` reference,
    // even when a swap runs inside the scoped settings callback below.
    const registration = ctx.llm.registerAdapter([PROVIDER], adapter);
    let registeredPolicy = options().retryPolicy;
    const ensureRegistrationFacts = () => {
        const policy = options().retryPolicy;
        if (deepEqualJson(policy, registeredPolicy))
            return;
        // The registry captures the retry policy at registration, so it is the one
        // fact per-request resolution cannot refresh. `replace` re-reads it in one
        // synchronous registry section: disposing and re-registering instead would
        // publish an empty route set between the two.
        registration.replace([PROVIDER]);
        registeredPolicy = policy;
    };
    installSettingsSection(ctx, NS, Config, config, {
        setSource: (source) => {
            current = source;
        },
        onChange: ensureRegistrationFacts,
    });
}
