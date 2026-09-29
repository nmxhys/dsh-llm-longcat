/**
 * Serialize harness messages into LongCat chat completions. User text is
 * joined; images become a text handle plus an inline `data:` image part;
 * assistant text becomes `content`, tool calls become `tool_calls`, and tool
 * results become their own `role: 'tool'` messages. Assistant reasoning is
 * replayed as `reasoning_content` only on tool-call turns.
 *
 * In-history tool changes (`developer` messages) never reach this adapter: the
 * runtime projects them away for a route that declares no `toolUpdate` mode, so
 * seeing one here is a contract violation and fails loud. The same goes for a
 * `tool-addition` / `tool-removal` block anywhere else.
 *
 * Images are rejected whenever the route cannot send them: an image arriving
 * without prepared request bytes, or without a catalog model declaring the
 * `image` modality, is a misdispatch rather than something to flatten silently.
 *
 * @module dsh-llm-longcat/serialize
 */
import type { GenerateOptions, ImageAttachmentAccessResolver, RequestMessage, RequestUserInput } from '@deepseek-ai/dsh-llm';
import type { ImageAttachmentRef, RequestImageAttachment } from '@deepseek-ai/dsh-attachment';
import type { WireMessage, WireRequest } from './types.ts';
/** Adapter-level request defaults (from plugin config). */
export interface RequestDefaults {
    thinking?: 'enabled' | 'disabled' | undefined;
    /**
     * Deployment default effort. LongCat's thinking switch is binary, so only
     * `off` and `high` are meaningful; the adapter maps both onto the
     * `thinking` object and never emits a `reasoning_effort` string.
     */
    reasoningEffort?: 'off' | 'high' | undefined;
}
/**
 * The requested efforts this adapter offers.
 *
 * LongCat's `supported_parameters` lists `thinking` but not
 * `reasoning_effort`, so there is no gradient to expose. Offering `low`/`max`
 * would advertise controls that collapse onto the same two wire bodies —
 * a selector that lies about what it does.
 */
export type LongCatEffort = 'off' | 'high';
/** The exact request bytes and access plane one serialization inlines. */
export interface ImageSerializationContext {
    /** Request versions keyed by durable attachment id, from `prepareImages`. */
    versions: ReadonlyMap<ImageAttachmentRef['attachmentId'], RequestImageAttachment>;
    /** Resolve execution-world access for the text handle that precedes each image. */
    access: ImageAttachmentAccessResolver;
}
/**
 * Serialize the conversation.
 *
 * `system`, `user`, `assistant`, and `tool` messages map one-to-one onto the
 * wire; a tool result is a first-class message now, so it needs no expansion.
 * Empty tool output still gets a body, because the wire requires one.
 * @param messages - the harness request history, in order.
 * @param images - prepared request images; omission is the text-only path.
 * @returns the wire messages, order preserved.
 * @throws {LlmError} `UNSUPPORTED_CONTENT` for a `developer` message: the
 *   runtime strips in-history tool changes for a route without a `toolUpdate`
 *   mode, so one arriving here means the projection contract was broken.
 */
export declare function serializeMessages(messages: readonly (RequestMessage | RequestUserInput)[], images?: ImageSerializationContext): WireMessage[];
/**
 * Build the full wire request. Always streaming with usage reporting on;
 * optional fields are omitted rather than sent as null so provider defaults
 * apply.
 * @param options - the harness request (model, history, system, tools, sampling).
 * @param defaults - adapter-level thinking defaults.
 * @param images - prepared request images; omission is the text-only path.
 * @returns the chat-completions request body.
 */
export declare function serializeRequest(options: GenerateOptions, defaults?: RequestDefaults, images?: ImageSerializationContext): WireRequest;
