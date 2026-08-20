/**
 * The stream contract every consumer relies on: `usage` before `finish`,
 * nothing after `finish`, tool arguments raw end to end, and an empty
 * completion surfaced as a retryable error rather than a silent success.
 */

import { describe, expect, it } from 'vitest'
import { mapFinishReason, mapUsage, translate } from '../src/translate.ts'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'

/** Feed payloads through the translator, collecting every chunk. */
async function run(payloads: string[]): Promise<StreamChunk[]> {
  async function* source(): AsyncGenerator<string> {
    for (const payload of payloads) yield payload
  }
  const chunks: StreamChunk[] = []
  for await (const chunk of translate(source())) chunks.push(chunk)
  return chunks
}

/** One SSE data payload carrying a single delta. */
function delta(body: unknown): string {
  return JSON.stringify({ choices: [{ delta: body }] })
}

describe('stream ordering contract', () => {
  it('emits usage before finish, and nothing after finish', async () => {
    const chunks = await run([
      delta({ content: 'hi' }),
      JSON.stringify({ choices: [{ finish_reason: 'stop' }] }),
      JSON.stringify({ usage: { prompt_tokens: 10, completion_tokens: 2 } }),
      '[DONE]',
    ])
    const kinds = chunks.map(c => c.type)
    expect(kinds.indexOf('usage')).toBeLessThan(kinds.indexOf('finish'))
    expect(kinds.at(-1)).toBe('finish')
  })

  it('handles usage attached to the finish chunk', async () => {
    const chunks = await run([
      delta({ content: 'hi' }),
      JSON.stringify({
        choices: [{ finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 2 },
      }),
      '[DONE]',
    ])
    expect(chunks.some(c => c.type === 'usage')).toBe(true)
    expect(chunks.at(-1)?.type).toBe('finish')
  })
})

describe('reasoning blocks', () => {
  it('does not open a block for an empty first reasoning delta', async () => {
    const chunks = await run([
      delta({ reasoning_content: '' }),
      delta({ content: 'answer' }),
      '[DONE]',
    ])
    const started = chunks.filter(c => c.type === 'block-start')
    // An empty opener would emit a stray empty reasoning block on every
    // thinking response.
    expect(started.every(c => (c as { blockType: string }).blockType !== 'reasoning')).toBe(true)
  })

  it('assembles reasoning deltas into one block', async () => {
    const chunks = await run([
      delta({ reasoning_content: 'th' }),
      delta({ reasoning_content: 'ink' }),
      '[DONE]',
    ])
    const end = chunks.find(c => c.type === 'block-end') as { block: { type: string; text: string } }
    expect(end.block).toEqual({ type: 'reasoning', text: 'think' })
  })
})

describe('tool calls', () => {
  it('concatenates argument fragments into one raw JSON string', async () => {
    const chunks = await run([
      delta({ tool_calls: [{ index: 0, id: 'c1', function: { name: 'f', arguments: '{"a"' } }] }),
      delta({ tool_calls: [{ index: 0, function: { arguments: ':1}' } }] }),
      '[DONE]',
    ])
    const end = chunks.find(c => c.type === 'block-end') as {
      block: { type: string; name: string; arguments: string }
    }
    expect(end.block.type).toBe('tool-call')
    expect(end.block.arguments).toBe('{"a":1}')
    expect(typeof end.block.arguments).toBe('string')
  })

  it('keeps the name when continuation deltas repeat it as null', async () => {
    // LongCat's real wire shape: the opening delta carries id and name, and
    // every continuation repeats them as explicit null rather than omitting
    // them. Treating null as a value blanks the assembled call's name.
    const chunks = await run([
      delta({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '' } }] }),
      delta({ tool_calls: [{ index: 0, id: null, type: 'function', function: { name: null, arguments: '{"city": "Beijing"' } }] }),
      delta({ tool_calls: [{ index: 0, id: null, type: 'function', function: { name: null, arguments: '}' } }] }),
      '[DONE]',
    ])
    const end = chunks.find(c => c.type === 'block-end') as {
      block: { name: string; id: string; arguments: string }
    }
    expect(end.block.name).toBe('get_weather')
    expect(end.block.id).toBe('call_1')
    expect(end.block.arguments).toBe('{"city": "Beijing"}')
  })

  it('keeps parallel calls on separate blocks', async () => {
    const chunks = await run([
      delta({ tool_calls: [{ index: 0, id: 'a', function: { name: 'f', arguments: '{}' } }] }),
      delta({ tool_calls: [{ index: 1, id: 'b', function: { name: 'g', arguments: '{}' } }] }),
      '[DONE]',
    ])
    expect(chunks.filter(c => c.type === 'block-end')).toHaveLength(2)
  })
})

describe('degenerate completions', () => {
  it('maps a content-free stop to a retryable EMPTY_RESPONSE error', async () => {
    const chunks = await run([
      JSON.stringify({ choices: [{ finish_reason: 'stop' }] }),
      '[DONE]',
    ])
    const finish = chunks.at(-1) as { type: string; reason: { kind: string; failure?: { code: string } } }
    expect(finish.reason.kind).toBe('error')
    expect(finish.reason.failure?.code).toBe('EMPTY_RESPONSE')
  })

  it('rejects a malformed payload instead of skipping it', async () => {
    await expect(run(['{not json', '[DONE]'])).rejects.toThrow(/malformed/i)
  })

  it('throws when the payload stream ends without [DONE]', async () => {
    await expect(run([delta({ content: 'hi' })])).rejects.toThrow(/\[DONE\]/)
  })
})

describe('finish reasons', () => {
  it('maps the documented vocabulary', () => {
    expect(mapFinishReason('stop')).toEqual({ kind: 'stop' })
    expect(mapFinishReason('tool_calls')).toEqual({ kind: 'tool-calls' })
    expect(mapFinishReason('length')).toEqual({ kind: 'max-tokens' })
  })

  it('surfaces unknown reasons as structured errors', () => {
    const reason = mapFinishReason('content_filter') as { kind: string; failure: { code: string } }
    expect(reason.kind).toBe('error')
    expect(reason.failure.code).toBe('CONTENT_FILTER')
  })
})

describe('usage accounting', () => {
  it('subtracts cache hits so counts stay disjoint', () => {
    const usage = mapUsage({
      prompt_tokens: 100,
      completion_tokens: 20,
      prompt_tokens_details: { cached_tokens: 30 },
    })
    // Billed input is the sum of the parts; inputTokens is uncached only.
    expect(usage.inputTokens).toBe(70)
    expect(usage.cacheReadTokens).toBe(30)
  })

  it('omits cache fields when the wire reports none', () => {
    const usage = mapUsage({ prompt_tokens: 10, completion_tokens: 2 })
    expect(usage).not.toHaveProperty('cacheReadTokens')
    expect(usage.inputTokens).toBe(10)
  })

  it('reports reasoning tokens as informational detail', () => {
    const usage = mapUsage({
      prompt_tokens: 10,
      completion_tokens: 50,
      completion_tokens_details: { reasoning_tokens: 40 },
    })
    // Already inside outputTokens; totals must not add it again.
    expect(usage.outputTokens).toBe(50)
    expect(usage.reasoningTokens).toBe(40)
  })
})
