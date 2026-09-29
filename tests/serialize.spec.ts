/**
 * The 0.2.0 message model and the image path are what this suite pins:
 * serialization is where the adapter differs from its DeepSeek sibling — the
 * thinking switch is binary and `reasoning_effort` must never reach the wire —
 * and images must either travel as a handle plus inline bytes or fail loudly,
 * never flatten to nothing.
 */

import { describe, expect, it } from 'vitest'
import { createAssistantMessage, createMessage, createToolResultMessage, createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions } from '@deepseek-ai/dsh-llm'
import type { ImageAttachmentRef, RequestImageAttachment } from '@deepseek-ai/dsh-attachment'
import { serializeMessages, serializeRequest } from '../src/serialize.ts'
import type { ImageSerializationContext } from '../src/serialize.ts'
import type { WireContentPart } from '../src/types.ts'

/** Minimal well-formed request; individual tests override what they exercise. */
function options(patch: Partial<GenerateOptions> = {}): GenerateOptions {
  return {
    provider: 'longcat',
    model: 'LongCat-2.5-Preview',
    messages: [],
    ...patch,
  } as GenerateOptions
}

const user = (content: ContentBlock[]) => createUserMessage({ content, source: { kind: 'user' } })
const assistant = (content: ContentBlock[]) => createAssistantMessage({
  content,
  source: { provider: 'longcat', model: 'LongCat-2.5-Preview' },
})
const tool = (callId: string, content: ContentBlock[], isError = false) => createToolResultMessage({
  callId: ToolCallId(callId),
  content,
  isError,
})
const system = (text: string) => createMessage({
  role: 'system',
  source: { kind: 'system-prompt' },
  content: [{ type: 'text', text }],
})

/** One durable image reference as the attachment service reports it. */
function imageRef(patch: Partial<ImageAttachmentRef> = {}): ImageAttachmentRef {
  return {
    attachmentId: 'sha256:abc' as ImageAttachmentRef['attachmentId'],
    mediaType: 'image/png',
    bytes: 1_024,
    width: 640,
    height: 480,
    ...patch,
  }
}

/** A prepared request version standing in for the attachment service output. */
function versionOf(ref: ImageAttachmentRef, patch: Partial<RequestImageAttachment> = {}): RequestImageAttachment {
  return {
    variantId: 'variant' as RequestImageAttachment['variantId'],
    attachment: ref,
    data: new Uint8Array([137, 80, 78, 71]),
    mediaType: ref.mediaType,
    bytes: ref.bytes,
    width: ref.width,
    height: ref.height,
    depth: 'uchar',
    space: 'srgb',
    hasAlpha: false,
    ...patch,
  }
}

function imageContext(version: RequestImageAttachment): ImageSerializationContext {
  return {
    versions: new Map([[version.attachment.attachmentId, version]]),
    access: () => ({ readonlyPath: '/tmp/normalized.png' }),
  }
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

  it('places a one-shot system prompt first', () => {
    const body = serializeRequest(options({ system: 'be brief' } as Partial<GenerateOptions>))
    expect(body.messages[0]).toEqual({ role: 'system', content: 'be brief' })
  })

  it('maps a loop-built in-history system message to the system slot', () => {
    const body = serializeRequest(options({ messages: [system('be brief'), user([{ type: 'text', text: 'hi' }])] } as Partial<GenerateOptions>))
    expect(body.messages[0]).toEqual({ role: 'system', content: 'be brief' })
    expect(body.messages[1]).toEqual({ role: 'user', content: 'hi' })
  })
})

describe('message history', () => {
  it('sends "" — never null — for a reasoning-only assistant turn', () => {
    const wire = serializeMessages([assistant([{ type: 'reasoning', text: 'hmm' }])])
    // The message is durable session history; a null here would make every
    // later turn of the session replay a body the endpoint can reject.
    expect(wire[0]).toMatchObject({ role: 'assistant', content: '' })
    expect(wire[0]).not.toHaveProperty('reasoning_content')
  })

  it('replays reasoning only on tool-call turns', () => {
    const withTool = serializeMessages([assistant([
      { type: 'reasoning', text: 'think' },
      { type: 'tool-call', id: ToolCallId('c1'), name: 'f', arguments: '{}' },
    ])])
    expect(withTool[0]).toMatchObject({ reasoning_content: 'think' })

    const withoutTool = serializeMessages([assistant([
      { type: 'reasoning', text: 'think' },
      { type: 'text', text: 'answer' },
    ])])
    expect(withoutTool[0]).not.toHaveProperty('reasoning_content')
  })

  it('serializes a tool result as its own role:tool message', () => {
    const wire = serializeMessages([tool('c1', [{ type: 'text', text: 'out' }])])
    expect(wire).toEqual([{ role: 'tool', tool_call_id: 'c1', content: 'out' }])
  })

  it('gives empty tool output a placeholder body', () => {
    const wire = serializeMessages([tool('c1', [])])
    expect(wire[0]).toMatchObject({ content: '(no output)' })
  })

  it('keeps tool-call arguments a raw JSON string', () => {
    const wire = serializeMessages([assistant([
      { type: 'tool-call', id: ToolCallId('c1'), name: 'get_weather', arguments: '{"city":"Beijing"}' },
    ])])
    const call = (wire[0] as { tool_calls: { function: { arguments: unknown } }[] }).tool_calls[0]
    expect(typeof call?.function.arguments).toBe('string')
  })

  it('refuses a developer message instead of dropping in-history tool changes', () => {
    const developer = createMessage({
      role: 'developer',
      source: { kind: 'user' },
      content: [{ type: 'tool-addition', toolName: 'later' }],
    })
    expect(() => serializeMessages([developer])).toThrow(/in-history tool changes/)
  })
})

describe('images', () => {
  it('sends a text handle plus inline bytes for a user image', () => {
    const ref = imageRef()
    const wire = serializeMessages(
      [user([{ type: 'text', text: 'what is this?' }, { type: 'image', attachment: ref }])],
      imageContext(versionOf(ref)),
    )
    const content = wire[0]?.content
    expect(Array.isArray(content)).toBe(true)
    const parts = content as WireContentPart[]
    expect(parts[0]).toEqual({ type: 'text', text: 'what is this?' })
    expect(parts[1]?.type).toBe('text')
    // The handle names the durable image and its read-only copy path.
    expect(JSON.stringify(parts[1])).toContain('/tmp/normalized.png')
    expect(parts[2]).toEqual({
      type: 'image_url',
      image_url: { url: 'data:image/png;base64,iVBORw==' },
    })
  })

  it('keeps a text-only turn a bare string', () => {
    const wire = serializeMessages([user([{ type: 'text', text: 'hi' }])])
    expect(wire[0]?.content).toBe('hi')
  })

  it('carries an image inside a tool result too', () => {
    const ref = imageRef()
    const wire = serializeMessages(
      [tool('c1', [{ type: 'image', attachment: ref }])],
      imageContext(versionOf(ref)),
    )
    expect(wire[0]?.role).toBe('tool')
    expect(Array.isArray(wire[0]?.content)).toBe(true)
  })

  it('refuses an image with no prepared request bytes', () => {
    // A text-only route substitutes placeholder text before dispatch, so an
    // image arriving here is a misdispatch, not something to flatten.
    expect(() => serializeMessages([user([{ type: 'image', attachment: imageRef() }])]))
      .toThrow(/without a prepared request image/)
  })

  it('refuses an image the wire would otherwise drop from assistant history', () => {
    expect(() => serializeMessages([assistant([{ type: 'image', attachment: imageRef() }])]))
      .toThrow(/only in a user message or tool result/)
  })

  it('refuses a tool-change block outside a developer message', () => {
    expect(() => serializeMessages([user([{ type: 'tool-removal', toolName: 'x' }])]))
      .toThrow(/cannot serialize a tool-removal block/)
  })
})
