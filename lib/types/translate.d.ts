/**
 * Translate LongCat SSE payloads into the harness `StreamChunk` protocol,
 * keeping one stateful block per text / reasoning / tool-call index.
 *
 * The finish reason and the latest usage are both deferred to `[DONE]`. That
 * covers the two shapes usage arrives in — attached to the finish chunk, or
 * as a trailing usage-only chunk — while guaranteeing the contract every
 * consumer relies on: `usage` precedes `finish`, and nothing follows it.
 *
 * @module dsh-llm-longcat/translate
 */
import type { FinishReason, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm';
import type { WireUsage } from './types.ts';
/**
 * Map the wire finish_reason vocabulary to the harness FinishReason.
 * @param reason - the wire `finish_reason` string.
 * @returns the mapped reason; unrecognized values become `{kind: 'error'}` carrying the uppercased value as `code`.
 */
export declare function mapFinishReason(reason: string): FinishReason;
/**
 * Map wire usage onto the harness's DISJOINT count convention.
 *
 * LongCat bills cache hits at a separate rate, and where it reports them
 * under `prompt_tokens_details.cached_tokens` the `prompt_tokens` total is
 * inclusive — so hits are subtracted back out of `inputTokens`. Reasoning
 * tokens are informational detail already inside `outputTokens` and are never
 * added again.
 * @param usage - wire usage from the finish chunk or the trailing usage-only chunk.
 * @returns disjoint harness counts; cache/reasoning fields present only when the wire reported them.
 */
export declare function mapUsage(usage: WireUsage): TokenUsage;
/**
 * Consume SSE data payloads (ending with `[DONE]`) and yield StreamChunks.
 * @param payloads - SSE data payloads from {@link parseSse}, `[DONE]`-terminated.
 * @returns deltas as they arrive; `block-end`s, `usage`, and `finish` are all deferred to the `[DONE]` sentinel.
 *   A `stop` (or absent) finish that opened no blocks is a degenerate completion and maps to an
 *   `EMPTY_RESPONSE` error finish, which the shipped retry policy treats as retryable.
 */
export declare function translate(payloads: AsyncIterable<string>): AsyncGenerator<StreamChunk>;
