/**
 * Real-API check driving the built adapter's own serialize → SSE → translate
 * pipeline against LongCat.
 *
 * The unit tests prove those layers behave as intended in isolation; this
 * proves LongCat accepts what they produce and that the stream contract holds
 * end to end on real traffic. It imports from `lib/`, so run `npm run build`
 * first.
 *
 * Usage:  LONGCAT_API_KEY=... npm run test:e2e
 *
 * Costs real tokens (a few hundred). Not part of `npm test`.
 */

import { serializeRequest } from '../lib/serialize.js'
import { parseSse } from '../lib/sse.js'
import { translate } from '../lib/translate.js'

const API_KEY = process.env.LONGCAT_API_KEY
const BASE_URL = process.env.LONGCAT_BASE_URL ?? 'https://api.longcat.chat/openai/v1'
const MODEL = process.env.LONGCAT_MODEL ?? 'LongCat-2.0'

if (!API_KEY) {
  console.error('LONGCAT_API_KEY is not set. Create a key at https://longcat.chat/platform/api_keys')
  process.exit(2)
}

let failures = 0

/**
 * @param {string} label - what is being checked.
 * @param {boolean} ok - whether it held.
 * @param {string} [detail] - extra context printed under the line.
 */
function report(label, ok, detail) {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}`)
  if (detail) console.log(`        ${detail}`)
  if (!ok) failures += 1
}

/**
 * Drive one request through the adapter's real serialize/parse/translate path.
 * @param {object} options - harness-shaped GenerateOptions.
 * @param {object} [defaults] - adapter request defaults.
 * @returns {Promise<{status: number, chunks: object[], body: object}>} the outcome.
 */
async function call(options, defaults = {}) {
  const body = serializeRequest({ model: MODEL, provider: 'longcat', ...options }, defaults)
  const response = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'authorization': `Bearer ${API_KEY}`,
      'content-type': 'application/json',
      'accept': 'text/event-stream',
    },
    body: JSON.stringify(body),
  })
  if (!response.ok || !response.body) {
    return { status: response.status, chunks: [], body }
  }
  const chunks = []
  for await (const chunk of translate(parseSse(response.body))) chunks.push(chunk)
  return { status: response.status, chunks, body }
}

const userMessage = text => ({
  id: 'm1',
  role: 'user',
  content: [{ type: 'text', text }],
  source: { kind: 'user' },
})

console.log(`endpoint ${BASE_URL}`)
console.log(`model    ${MODEL}\n`)

// 1. Thinking enabled — reasoning must reach the harness as reasoning blocks.
{
  const { status, chunks, body } = await call(
    { messages: [userMessage('What is 17 * 23? Think it through.')], maxTokens: 512 },
    { thinking: 'enabled', reasoningEffort: 'high' },
  )
  report('thinking:enabled accepted', status === 200, `HTTP ${status}`)
  report('serialized the binary switch', body.thinking?.type === 'enabled',
    JSON.stringify(body.thinking))
  const reasoning = chunks.filter(c => c.type === 'reasoning-delta')
  report('reasoning blocks produced', reasoning.length > 0, `${reasoning.length} deltas`)
  const usage = chunks.find(c => c.type === 'usage')
  report('usage reported', usage !== undefined,
    usage ? JSON.stringify(usage.usage) : 'none')
}

// 2. Thinking disabled — Off must genuinely mean off.
{
  const { status, chunks, body } = await call(
    { messages: [userMessage('Reply with the single word: ok')], maxTokens: 64, reasoningEffort: 'off' },
  )
  report('thinking:disabled accepted', status === 200, `HTTP ${status}`)
  report('serialized an explicit disable', body.thinking?.type === 'disabled',
    'omitting the field would fall through to the server default')
  const reasoning = chunks.filter(c => c.type === 'reasoning-delta')
  report('no reasoning when disabled', reasoning.length === 0, `${reasoning.length} deltas`)
}

// 3. Tool calling — absent from the chat docs, present in supported_parameters.
{
  const { status, chunks } = await call({
    messages: [userMessage('What is the weather in Beijing? Use the tool.')],
    maxTokens: 256,
    tools: [{
      name: 'get_weather',
      description: 'Get current weather for a city',
      parameters: {
        type: 'object',
        properties: { city: { type: 'string', description: 'City name' } },
        required: ['city'],
      },
    }],
  })
  report('tools accepted', status === 200, `HTTP ${status}`)
  const calls = chunks.filter(c => c.type === 'block-end' && c.block?.type === 'tool-call')
  report('tool call assembled', calls.length > 0,
    calls.length ? `called ${calls[0].block.name}` : 'none')
  if (calls.length > 0) {
    const args = calls[0].block.arguments
    report('arguments stay a raw JSON string', typeof args === 'string', JSON.stringify(args))
    let parsed = false
    try { JSON.parse(args); parsed = true } catch { /* reported below */ }
    report('arguments parse as JSON', parsed)
  }
}

// 4. The ordering contract, on real traffic.
{
  const { chunks } = await call({ messages: [userMessage('Count: 1 2 3')], maxTokens: 64 })
  const kinds = chunks.map(c => c.type)
  const usageAt = kinds.indexOf('usage')
  const finishAt = kinds.indexOf('finish')
  report('usage precedes finish', usageAt >= 0 && usageAt < finishAt, kinds.join(' '))
  report('nothing follows finish', finishAt === kinds.length - 1)
  // A small budget legitimately truncates, so `max-tokens` is as valid an
  // outcome as `stop`. What must not appear is an error finish — in
  // particular the EMPTY_RESPONSE the translator synthesizes for a
  // content-free completion.
  const reason = chunks.at(-1)?.reason
  report('finish is a non-error terminal state',
    reason?.kind === 'stop' || reason?.kind === 'max-tokens',
    JSON.stringify(reason))
}

// 5. Model catalog — what the Web UI's model fetch calls.
{
  const response = await fetch(`${BASE_URL}/models`, {
    headers: { 'Authorization': `Bearer ${API_KEY}` },
  })
  const json = await response.json().catch(() => null)
  const ids = json?.data?.map(m => m.id) ?? []
  report('GET /models works', response.status === 200, `HTTP ${response.status}`)
  report(`${MODEL} is listed`, ids.includes(MODEL), `listed: ${ids.join(', ') || 'none'}`)
}

console.log(`\n${failures === 0 ? 'all checks passed' : `${failures} check(s) failed`}`)
process.exit(failures === 0 ? 0 : 1)
