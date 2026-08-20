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

import { contentHasImage, LlmError } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions, Message } from '@deepseek-ai/dsh-llm'
import type { WireMessage, WireRequest, WireTool } from './types.ts'

/** Adapter-level request defaults (from plugin config). */
export interface RequestDefaults {
  thinking?: 'enabled' | 'disabled' | undefined
  /**
   * Deployment default effort. LongCat's thinking switch is binary, so only
   * `off` and `high` are meaningful; the adapter maps both onto the
   * `thinking` object and never emits a `reasoning_effort` string.
   */
  reasoningEffort?: 'off' | 'high' | undefined
}

/**
 * The selectable efforts this adapter offers.
 *
 * LongCat's `supported_parameters` lists `thinking` but not
 * `reasoning_effort`, so there is no gradient to expose. Offering `low`/`max`
 * would advertise controls that collapse onto the same two wire bodies —
 * a selector that lies about what it does.
 */
export type LongCatEffort = 'off' | 'high'

/** Validate the requested effort against the binary switch LongCat actually exposes. */
function longCatEffort(effort: NonNullable<GenerateOptions['reasoningEffort']>): LongCatEffort {
  if (effort === 'off' || effort === 'high') return effort as LongCatEffort
  throw new LlmError(
    `LongCat does not support reasoning effort "${effort}"; its thinking switch is binary (off | high)`,
    'UNSUPPORTED_REASONING_EFFORT',
  )
}

/**
 * Resolve the one `thinking` object a request carries.
 *
 * Every path returns an explicit `enabled` or `disabled` rather than omitting
 * the field: omission would hand the decision to LongCat's server-side
 * default, which is not what selecting Off should mean.
 * @param options - the harness request.
 * @param defaults - adapter-level thinking defaults.
 * @returns the resolved wire toggle.
 */
function resolveThinking(
  options: GenerateOptions,
  defaults: RequestDefaults,
): 'enabled' | 'disabled' {
  // A title's bounded output must be visible text, never spent on reasoning.
  if (options.purpose === 'session-title') return 'disabled'

  const requested = options.reasoningEffort === undefined
    ? undefined
    : longCatEffort(options.reasoningEffort)

  // A deployment that locks thinking off refuses a per-request attempt to
  // turn it back on, before any network I/O.
  if (defaults.thinking === 'disabled') {
    if (requested !== undefined && requested !== 'off') {
      throw new LlmError(
        `LongCat deployment has thinking disabled and cannot serve reasoning effort "${requested}"`,
        'UNSUPPORTED_REASONING_EFFORT',
      )
    }
    return 'disabled'
  }

  if (requested !== undefined) return requested === 'off' ? 'disabled' : 'enabled'
  if (defaults.reasoningEffort !== undefined) {
    return defaults.reasoningEffort === 'off' ? 'disabled' : 'enabled'
  }
  return defaults.thinking ?? 'enabled'
}

/** Join the text blocks of a message (used for user/tool-result content). */
function flattenText(blocks: readonly ContentBlock[]): string {
  return blocks
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')
}

/** Reject image content before any text-flattening path can silently erase it. */
function assertTextOnly(blocks: readonly ContentBlock[]): void {
  if (contentHasImage(blocks)) {
    throw new LlmError(
      'LongCat-2.0 is text-only (modality text->text) and does not accept image content.',
      'UNSUPPORTED_CONTENT',
    )
  }
}

/** Serialize one assistant message (text + reasoning + tool calls). */
function serializeAssistant(message: Message): WireMessage {
  const text = flattenText(message.content)
  const reasoning = message.content
    .filter(block => block.type === 'reasoning')
    .map(block => block.text)
    .join('')
  const toolCalls = message.content
    .filter(block => block.type === 'tool-call')
    .map(block => ({
      id: block.id,
      type: 'function' as const,
      function: { name: block.name, arguments: block.arguments },
    }))

  return {
    role: 'assistant',
    // Always a string, never null — a reasoning-only turn is durable history,
    // and a null there would make every later turn replay a rejectable body.
    content: text,
    // Passback is required on tool-call turns and ignored on plain ones, so
    // it is dropped there to avoid paying for those tokens again.
    ...toolCalls.length > 0 && reasoning.length > 0 ? { reasoning_content: reasoning } : {},
    ...toolCalls.length > 0 ? { tool_calls: toolCalls } : {},
  }
}

/**
 * Serialize the conversation. `tool-result` blocks become standalone
 * `{role: 'tool'}` messages; the harness carries each tool result inside a
 * user-role message, so a mixed message contributes its text first and its
 * tool results as separate wire messages after.
 * @param messages - the harness conversation, in order.
 * @returns the wire messages; order preserved, each tool result expanded into its own entry.
 */
export function serializeMessages(messages: readonly Message[]): WireMessage[] {
  const wire: WireMessage[] = []
  for (const message of messages) {
    assertTextOnly(message.content)
    if (message.role === 'system') {
      wire.push({ role: 'system', content: flattenText(message.content) })
      continue
    }
    if (message.role === 'assistant') {
      wire.push(serializeAssistant(message))
      continue
    }
    const toolResults = message.content.filter(block => block.type === 'tool-result')
    const text = flattenText(message.content)
    if (text.length > 0 || toolResults.length === 0) {
      wire.push({ role: 'user', content: text })
    }
    for (const result of toolResults) {
      wire.push({
        role: 'tool',
        tool_call_id: result.toolCallId,
        // Empty tool output still needs some content on the wire.
        content: flattenText(result.content) || '(no output)',
      })
    }
  }
  return wire
}

/**
 * Build the full wire request. Always streaming with usage reporting on;
 * optional fields are omitted rather than sent as null so provider defaults
 * apply.
 * @param options - the harness request (model, history, system, tools, sampling).
 * @param defaults - adapter-level thinking defaults.
 * @returns the chat-completions request body.
 */
export function serializeRequest(
  options: GenerateOptions,
  defaults: RequestDefaults = {},
): WireRequest {
  const messages: WireMessage[] = []
  if (options.system !== undefined) {
    messages.push({ role: 'system', content: options.system })
  }
  messages.push(...serializeMessages(options.messages))

  const tools: WireTool[] | undefined = options.tools?.map(tool => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }))

  return {
    model: options.model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    thinking: { type: resolveThinking(options, defaults) },
    ...tools !== undefined && tools.length > 0 ? { tools } : {},
    ...options.temperature !== undefined ? { temperature: options.temperature } : {},
    ...options.maxTokens === undefined ? {} : { max_tokens: options.maxTokens },
  }
}
