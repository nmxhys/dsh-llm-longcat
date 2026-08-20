/**
 * Serialize harness messages into LongCat chat completions. User text is
 * joined; assistant text becomes `content`, tool calls become `tool_calls`,
 * and tool results become separate `role: 'tool'` messages. Assistant
 * reasoning is replayed as `reasoning_content` only on tool-call turns.
 * Image blocks are rejected explicitly: LongCat-2.0 reports
 * `modality: text->text`, so flattening would silently erase them.
 *
 * @module dsh-llm-longcat/serialize
 */
import type { GenerateOptions, Message } from '@deepseek-ai/dsh-llm';
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
 * The selectable efforts this adapter offers.
 *
 * LongCat's `supported_parameters` lists `thinking` but not
 * `reasoning_effort`, so there is no gradient to expose. Offering `low`/`max`
 * would advertise controls that collapse onto the same two wire bodies —
 * a selector that lies about what it does.
 */
export type LongCatEffort = 'off' | 'high';
/**
 * Serialize the conversation. `tool-result` blocks become standalone
 * `{role: 'tool'}` messages; the harness carries each tool result inside a
 * user-role message, so a mixed message contributes its text first and its
 * tool results as separate wire messages after.
 * @param messages - the harness conversation, in order.
 * @returns the wire messages; order preserved, each tool result expanded into its own entry.
 */
export declare function serializeMessages(messages: readonly Message[]): WireMessage[];
/**
 * Build the full wire request. Always streaming with usage reporting on;
 * optional fields are omitted rather than sent as null so provider defaults
 * apply.
 * @param options - the harness request (model, history, system, tools, sampling).
 * @param defaults - adapter-level thinking defaults.
 * @returns the chat-completions request body.
 */
export declare function serializeRequest(options: GenerateOptions, defaults?: RequestDefaults): WireRequest;
