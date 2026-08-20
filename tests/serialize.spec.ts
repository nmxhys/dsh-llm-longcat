/**
 * Serialization is where this adapter differs from its DeepSeek sibling: the
 * thinking switch is binary and `reasoning_effort` must never reach the wire.
 * These tests pin that boundary, plus the two history rules that only bite
 * later (assistant `content` is never null; reasoning replays on tool-call
 * turns only).
 */

import { describe, expect, it } from 'vitest'
import { serializeRequest, serializeMessages } from '../src/serialize.ts'
import type { GenerateOptions, Message } from '@deepseek-ai/dsh-llm'

/** Minimal well-formed request; individual tests override what they exercise. */
function options(patch: Partial<GenerateOptions> = {}): GenerateOptions {
  return {
    provider: 'longcat',
    model: 'LongCat-2.0',
    messages: [],
    ...patch,
  } as GenerateOptions
}

/** A harness message literal, cast once so tests stay readable. */
function message(role: Message['role'], content: unknown[]): Message {
  return { id: 'm1', role, content, source: { kind: 'user' } } as unknown as Message
}

describe('thinking switch', () => {
  it('enables thinking for the high effort', () => {
    const body = serializeRequest(options({ reasoningEffort: 'high' } as Partial<GenerateOptions>))
    expect(body.thinking).toEqual({ type: 'enabled' })
  })

  it('disables thinking explicitly for off, rather than omitting the field', () => {
    const body = serializeRequest(options({ reasoningEffort: 'off' } as Partial<GenerateOptions>))
    // Omitting `thinking` would hand the decision to LongCat's server-side
    // default, which is not what selecting Off means.
    expect(body.thinking).toEqual({ type: 'disabled' })
  })

  it('never serializes reasoning_effort at any level', () => {
    for (const effort of ['off', 'high', undefined]) {
      const body = serializeRequest(
        options(effort === undefined ? {} : { reasoningEffort: effort } as Partial<GenerateOptions>),
        { thinking: 'enabled', reasoningEffort: 'high' },
      )
      expect(body).not.toHaveProperty('reasoning_effort')
    }
  })

  it('rejects gradient efforts LongCat cannot express', () => {
    for (const effort of ['low', 'medium', 'max', 'minimal', 'xhigh']) {
      expect(() => serializeRequest(options({ reasoningEffort: effort } as Partial<GenerateOptions>)))
        .toThrow(/does not support reasoning effort/)
    }
  })

  it('forces thinking off for session titles', () => {
    const body = serializeRequest(
      options({ purpose: 'session-title' } as Partial<GenerateOptions>),
      { thinking: 'enabled', reasoningEffort: 'high' },
    )
    // A title's bounded output must be visible text, not reasoning.
    expect(body.thinking).toEqual({ type: 'disabled' })
  })

  it('refuses a per-request attempt to re-enable a deployment-disabled thinking', () => {
    expect(() => serializeRequest(
      options({ reasoningEffort: 'high' } as Partial<GenerateOptions>),
      { thinking: 'disabled' },
    )).toThrow(/thinking disabled/)
  })

  it('honours a deployment default of off', () => {
    const body = serializeRequest(options(), { reasoningEffort: 'off' })
    expect(body.thinking).toEqual({ type: 'disabled' })
  })
})

describe('request shape', () => {
  it('always streams with usage reporting on', () => {
    const body = serializeRequest(options())
    expect(body.stream).toBe(true)
    expect(body.stream_options).toEqual({ include_usage: true })
  })

  it('omits optional sampling fields rather than sending null', () => {
    const body = serializeRequest(options())
    expect(body).not.toHaveProperty('temperature')
    expect(body).not.toHaveProperty('max_tokens')
    expect(body).not.toHaveProperty('tools')
  })

  it('places the system prompt first', () => {
    const body = serializeRequest(options({ system: 'be brief' } as Partial<GenerateOptions>))
    expect(body.messages[0]).toEqual({ role: 'system', content: 'be brief' })
  })
})

describe('message history', () => {
  it('sends "" — never null — for a reasoning-only assistant turn', () => {
    const wire = serializeMessages([message('assistant', [{ type: 'reasoning', text: 'hmm' }])])
    // The message is durable session history; a null here would make every
    // later turn of the session replay a body the endpoint can reject.
    expect(wire[0]).toMatchObject({ role: 'assistant', content: '' })
    expect(wire[0]).not.toHaveProperty('reasoning_content')
  })

  it('replays reasoning only on tool-call turns', () => {
    const withTool = serializeMessages([message('assistant', [
      { type: 'reasoning', text: 'think' },
      { type: 'tool-call', id: 'c1', name: 'f', arguments: '{}' },
    ])])
    expect(withTool[0]).toMatchObject({ reasoning_content: 'think' })

    const withoutTool = serializeMessages([message('assistant', [
      { type: 'reasoning', text: 'think' },
      { type: 'text', text: 'answer' },
    ])])
    expect(withoutTool[0]).not.toHaveProperty('reasoning_content')
  })

  it('expands tool results into their own role:tool messages', () => {
    const wire = serializeMessages([message('user', [
      { type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'out' }] },
    ])])
    expect(wire).toEqual([{ role: 'tool', tool_call_id: 'c1', content: 'out' }])
  })

  it('gives empty tool output a placeholder body', () => {
    const wire = serializeMessages([message('user', [
      { type: 'tool-result', toolCallId: 'c1', content: [] },
    ])])
    expect(wire[0]).toMatchObject({ content: '(no output)' })
  })

  it('keeps tool-call arguments a raw JSON string', () => {
    const wire = serializeMessages([message('assistant', [
      { type: 'tool-call', id: 'c1', name: 'get_weather', arguments: '{"city":"Beijing"}' },
    ])])
    const call = (wire[0] as { tool_calls: { function: { arguments: unknown } }[] }).tool_calls[0]
    expect(typeof call?.function.arguments).toBe('string')
  })
})
