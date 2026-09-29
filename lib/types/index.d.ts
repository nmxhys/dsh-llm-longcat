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
import type { Context, Volatile } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import type { ModelModality, RetryPolicyConfig } from '@deepseek-ai/dsh-llm';
import { type LaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment';
import type { LongCatCatalogModel, LongCatConnectionOptions } from './adapter.ts';
export { DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_TOKENS, DEFAULT_STREAM_IDLE_TIMEOUT_MS, LongCatAdapter, httpErrorCode, } from './adapter.ts';
export type { LongCatAdapterOptions, LongCatCatalogModel, LongCatConnectionOptions } from './adapter.ts';
export { DEFAULT_IMAGE_MAX_BYTES, DEFAULT_IMAGE_PIXEL_BUDGET, DEFAULT_MAX_REQUEST_IMAGE_BYTES, imageRequestTarget, prepareImages, } from './images.ts';
export type { LongCatImagePolicy, LongCatImageRequestOptions, PreparedImages } from './images.ts';
export type { RequestDefaults, LongCatEffort } from './serialize.ts';
export type * from './types.ts';
export declare const name = "llm-longcat";
export declare const inject: string[];
/** Public API default; an internal endpoint may come from $LONGCAT_BASE_URL. */
export declare const PUBLIC_BASE_URL = "https://api.longcat.chat/openai/v1";
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
    apiKeyEnv: Volatile<string>;
    /** Endpoint base; falls back to $LONGCAT_BASE_URL from a trusted environment layer, then the public API. */
    baseURL?: string;
    /** Deployment thinking policy; `disabled` limits every conversation request to `off`. */
    thinking?: 'enabled' | 'disabled';
    /**
     * Default thinking state. LongCat's switch is binary, so only `off` and
     * `high` exist — there is no gradient to configure.
     */
    reasoningEffort?: 'off' | 'high';
    /** Default per-request output cap (default 131,072, the documented cap). */
    maxTokens?: number;
    /** Context capacity used when the selected model has no exact value (default 1,048,576). */
    defaultContextWindow?: number;
    /** Accumulated base64 payload bound for one request's images (default 20 MiB). */
    maxRequestImageBytes?: number;
    /** Optional bound on retained image occurrences per request; omission leaves the count unbounded. */
    maxImagesPerRequest?: number;
    /** Advisory models shown by discovery consumers; defaults to the two shipped models. */
    models?: Volatile<LongCatCatalogModel[]>;
    /** Maximum provider idle time while one stream read is outstanding (default five minutes). */
    streamIdleTimeoutMs?: number;
    /**
     * Provider-owned model-request retry policy; omission uses normal defaults.
     * Volatile because the registry captures it at registration: a change is
     * applied to the running route in place instead of remounting it.
     */
    retryPolicy?: Volatile<RetryPolicyConfig>;
}
/** Deployment inputs with the volatile fields read out of their wrappers. */
export type Options = Omit<Config, 'apiKeyEnv' | 'models' | 'retryPolicy'> & {
    /** Plain credential reference for this configuration generation. */
    apiKeyEnv?: string;
    /** Plain model catalog for this configuration generation. */
    models?: readonly LongCatCatalogModel[];
    /** Plain retry policy for this configuration generation. */
    retryPolicy?: RetryPolicyConfig;
};
/**
 * The catalog schema's own shape: schemastery builds mutable properties and a
 * mutable modality array, while the adapter reads the resolved catalog as
 * immutable data — exactly what the volatile snapshot hands back.
 */
type CatalogModelSchemaShape = Omit<LongCatCatalogModel, 'inputModalities'> & {
    inputModalities?: ModelModality[];
};
export declare const Config: z<Schemastery.ObjectS<NoInfer<{
    apiKeyEnv: z<string, string, "volatile-defined">;
    baseURL: z<string, string, "plain">;
    thinking: z<"enabled" | "disabled", "enabled" | "disabled", "plain">;
    reasoningEffort: z<"off" | "high", "off" | "high", "plain">;
    maxTokens: z<number, number, "defined">;
    defaultContextWindow: z<number, number, "defined">;
    maxRequestImageBytes: z<number, number, "defined">;
    maxImagesPerRequest: z<number, number, "plain">;
    models: z<NoInfer<(Omit<LongCatCatalogModel, "inputModalities"> & {
        inputModalities?: ModelModality[];
    })[]>, NoInfer<CatalogModelSchemaShape[]>, "volatile-defined">;
    streamIdleTimeoutMs: z<number, number, "defined">;
    retryPolicy: z<NoInfer<RetryPolicyConfig>, NoInfer<RetryPolicyConfig>, "volatile">;
}>>, Schemastery.ObjectT<NoInfer<{
    apiKeyEnv: z<string, string, "volatile-defined">;
    baseURL: z<string, string, "plain">;
    thinking: z<"enabled" | "disabled", "enabled" | "disabled", "plain">;
    reasoningEffort: z<"off" | "high", "off" | "high", "plain">;
    maxTokens: z<number, number, "defined">;
    defaultContextWindow: z<number, number, "defined">;
    maxRequestImageBytes: z<number, number, "defined">;
    maxImagesPerRequest: z<number, number, "plain">;
    models: z<NoInfer<(Omit<LongCatCatalogModel, "inputModalities"> & {
        inputModalities?: ModelModality[];
    })[]>, NoInfer<CatalogModelSchemaShape[]>, "volatile-defined">;
    streamIdleTimeoutMs: z<number, number, "defined">;
    retryPolicy: z<NoInfer<RetryPolicyConfig>, NoInfer<RetryPolicyConfig>, "volatile">;
}>>, "plain">;
/** One resolution's complete request facts. */
export type ResolvedLongCatOptions = LongCatConnectionOptions;
/**
 * Read one validated configuration generation out of its live form.
 * @param config - live plugin configuration.
 * @returns detached resolver inputs.
 */
export declare function plainOptions(config: Config): Options;
/**
 * The one explicit resolve step from raw config to validated connection
 * facts. Programmatic construction may bypass Schemastery normalization, so
 * every default and bound is re-judged here — for the composition entry at
 * load (fail loud) and for every later resolution.
 * @param config - raw plugin config or a resolved settings snapshot.
 * @param environment - this run's environment layers, or `undefined` outside the product CLI.
 * @returns validated connection facts plus the credential reference.
 */
export declare function resolveAdapterOptions(config: Options, environment?: LaunchEnvironmentSnapshot): ResolvedLongCatOptions;
export declare function apply(ctx: Context, config: Config): void;
