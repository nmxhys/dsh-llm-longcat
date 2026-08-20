/**
 * LongCat chat-completions wire format (OpenAI-compatible). Types only.
 *
 * Source of truth: the official API docs at
 * https://longcat.chat/platform/docs/zh/api/chat and the model-detail
 * endpoint `GET /openai/v1/models/{model}`, which is the only documented
 * place that reports `supported_parameters`. Verified against live streams
 * from `api.longcat.chat` (2026-08).
 *
 * @module dsh-llm-longcat/types
 */
/** Request body for `POST {baseURL}/chat/completions`. */
export interface WireRequest {
    model: string;
    messages: WireMessage[];
    stream: true;
    stream_options: {
        include_usage: true;
    };
    /**
     * Thinking-mode toggle. LongCat exposes this as a binary object and does
     * NOT accept OpenAI's top-level `reasoning_effort` — `supported_parameters`
     * lists `thinking` and omits the effort string, so no gradient exists to
     * map and none is ever serialized.
     */
    thinking?: {
        type: 'enabled' | 'disabled';
    };
    tools?: WireTool[];
    temperature?: number;
    top_p?: number;
    /** Documented cap for LongCat-2.0: 131072. */
    max_tokens?: number;
}
/** System-role message: a single string of instructions. */
export interface WireSystemMessage {
    role: 'system';
    content: string;
}
/** User-role message: a single string of user input (LongCat is text-only). */
export interface WireUserMessage {
    role: 'user';
    content: string;
}
/** Tool-role message: the result of one tool call, keyed by its call id. */
export interface WireToolMessage {
    role: 'tool';
    tool_call_id: string;
    content: string;
}
/**
 * Assistant-role history message. Text-less turns send `""` rather than null:
 * the message sits durably in the session log, and a null there would make
 * every later turn of that session replay a body the endpoint can reject.
 */
export interface WireAssistantMessage {
    role: 'assistant';
    content: string | null;
    /**
     * CoT passback on assistant turns that carried tool calls. Mirrors the
     * DeepSeek thinking-mode rule, which LongCat's wire format follows.
     */
    reasoning_content?: string;
    tool_calls?: WireToolCall[];
}
/** One entry of the request `messages` array, discriminated on `role`. */
export type WireMessage = WireSystemMessage | WireUserMessage | WireAssistantMessage | WireToolMessage;
/** A completed tool call replayed on an assistant history message; `arguments` is the raw JSON string. */
export interface WireToolCall {
    id: string;
    type: 'function';
    function: {
        name: string;
        arguments: string;
    };
}
/** One entry of the request `tools` array; `parameters` is a JSON Schema object. */
export interface WireTool {
    type: 'function';
    function: {
        name: string;
        description: string;
        parameters: Record<string, unknown>;
    };
}
/** One parsed SSE `data:` payload (a chat.completion.chunk). */
export interface WireChunk {
    choices?: WireChoice[];
    /** May arrive attached to the finish chunk and/or as a trailing usage-only chunk. */
    usage?: WireUsage | null;
}
/** One streamed choice; `finish_reason` is non-null only on its terminal chunk. */
export interface WireChoice {
    delta?: WireDelta;
    finish_reason?: string | null;
}
/** The incremental content of one streamed choice; any subset of fields may be present per chunk. */
export interface WireDelta {
    role?: string;
    /** Visible text. Null/empty on reasoning and tool-call chunks. */
    content?: string | null;
    /** Thinking-mode CoT; absent entirely when thinking is disabled. */
    reasoning_content?: string | null;
    tool_calls?: WireToolCallDelta[];
}
/**
 * A streamed fragment of one tool call; fragments sharing an `index`
 * concatenate into one call.
 *
 * LongCat carries `id` and `function.name` on the opening delta and then
 * repeats them as explicit `null` on every continuation delta — it does not
 * omit them. Consumers must therefore treat null as "no new value" rather
 * than as a value, or the assembled call loses its identity.
 */
export interface WireToolCallDelta {
    /** Disambiguates parallel tool calls; stable across a call's deltas. */
    index: number;
    /** Set on the first delta of each call; explicitly null afterwards. */
    id?: string | null;
    type?: 'function';
    function?: {
        /** Set on the first delta of each call; explicitly null afterwards. */
        name?: string | null;
        /** Argument JSON fragment (concatenate across deltas). */
        arguments?: string;
    };
}
/**
 * Wire token accounting.
 *
 * LongCat prices a cache-hit input tier separately, so a cached count may be
 * reported under the OpenAI-compatible `prompt_tokens_details.cached_tokens`
 * spelling. Where it is present, `prompt_tokens` is treated as the inclusive
 * total and the hits are subtracted back out to satisfy the harness's
 * disjoint-count convention.
 */
export interface WireUsage {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens?: number;
    prompt_tokens_details?: {
        cached_tokens?: number;
    };
    completion_tokens_details?: {
        reasoning_tokens?: number;
    };
}
/**
 * Non-2xx error body. LongCat documents `error.message`, `error.type`, and
 * `error.code`, with `permission_error`/`insufficient_quota` on 403 rather
 * than the more common 429.
 */
export interface WireError {
    error?: {
        message?: string;
        type?: string;
        code?: string;
    };
}
