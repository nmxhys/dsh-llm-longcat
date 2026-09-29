/**
 * Real-API check driving the built adapter's own serialize → SSE → translate
 * pipeline against LongCat.
 *
 * The unit tests prove those layers behave as intended in isolation; this
 * proves LongCat accepts what they produce and that the stream contract holds
 * end to end on real traffic. The image section drives the real adapter (image
 * preparation included) against a synthetic attachment, so the multimodal wire
 * body is verified rather than asserted. It imports from `lib/`, so run
 * `npm run build` first.
 *
 * Usage:  LONGCAT_API_KEY=... npm run test:e2e
 *
 * Costs real tokens (a few hundred, plus one image request). Not part of
 * `npm test`.
 */

import { deflateSync } from 'node:zlib'
import { LongCatAdapter } from '../lib/adapter.js'
import { resolveAdapterOptions } from '../lib/index.js'
import { serializeRequest } from '../lib/serialize.js'
import { parseSse } from '../lib/sse.js'
import { translate } from '../lib/translate.js'

const API_KEY = process.env.LONGCAT_API_KEY
const BASE_URL = process.env.LONGCAT_BASE_URL ?? 'https://api.longcat.chat/openai/v1'
const MODEL = process.env.LONGCAT_MODEL ?? 'LongCat-2.0'
const VISION_MODEL = process.env.LONGCAT_VISION_MODEL ?? 'LongCat-2.5-Preview'

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

/** CRC32 table for PNG chunk framing. */
const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) crc = (CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)) >>> 0
  return (crc ^ 0xffffffff) >>> 0
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}

/** Black rectangles forming a digit, in unit coordinates. */
const DIGIT_RECTS = {
  7: [[0.15, 0.15, 0.7, 0.12], [0.55, 0.15, 0.13, 0.7]],
  3: [[0.2, 0.15, 0.55, 0.1], [0.6, 0.15, 0.15, 0.7], [0.2, 0.45, 0.5, 0.1], [0.2, 0.75, 0.55, 0.1]],
}

/**
 * Render one digit as a white RGB PNG with black strokes — greppable evidence
 * that the model actually received image bytes.
 * @param {number} size - square edge length in pixels.
 * @param {number[][]} rects - filled rectangles in unit coordinates.
 * @returns {Buffer} the encoded PNG.
 */
function digitPng(size, rects) {
  const inside = (x, y) => rects.some(([rx, ry, rw, rh]) =>
    x >= rx * size && x < (rx + rw) * size && y >= ry * size && y < (ry + rh) * size)
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  const rows = []
  for (let y = 0; y < size; y += 1) {
    const row = Buffer.alloc(1 + size * 3)
    for (let x = 0; x < size; x += 1) {
      const value = inside(x, y) ? 0 : 255
      const offset = 1 + x * 3
      row[offset] = value
      row[offset + 1] = value
      row[offset + 2] = value
    }
    rows.push(row)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(Buffer.concat(rows))),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

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
  report(`${VISION_MODEL} is listed`, ids.includes(VISION_MODEL), `listed: ${ids.join(', ') || 'none'}`)
}

// 6. Capabilities the catalog depends on, straight from the model endpoint.
{
  const response = await fetch(`${BASE_URL}/models/${VISION_MODEL}`, {
    headers: { 'Authorization': `Bearer ${API_KEY}` },
  })
  const json = await response.json().catch(() => null)
  const modalities = json?.architecture?.input_modalities ?? []
  report('model detail reports the image modality', modalities.includes('image'),
    `input_modalities: ${modalities.join(', ') || 'none'}`)
  report('model detail confirms the 1M context', json?.context_length === 1_048_576,
    `context_length: ${json?.context_length}`)
}

// 7. Image input through the real adapter: preparation, serialization, stream.
{
  // A synthetic attachment plane keeps the check hermetic: the harness
  // normally derives these bytes through ctx.attachments.
  const digit = process.env.LONGCAT_E2E_DIGIT ?? '7'
  const png = digitPng(320, DIGIT_RECTS[digit] ?? DIGIT_RECTS['7'])
  const ref = {
    attachmentId: 'sha256:e2e-synthetic',
    mediaType: 'image/png',
    bytes: png.length,
    width: 320,
    height: 320,
  }
  const store = {
    readImageRequest: async () => ({
      variantId: 'e2e-variant',
      attachment: ref,
      data: png,
      mediaType: 'image/png',
      bytes: png.length,
      width: 320,
      height: 320,
      depth: 'uchar',
      space: 'srgb',
      hasAlpha: false,
    }),
  }
  const adapter = new LongCatAdapter({
    options: () => resolveAdapterOptions({ baseURL: BASE_URL, apiKeyEnv: 'LONGCAT_API_KEY' }),
    resolveApiKey: () => Promise.resolve(API_KEY),
    resolveAttachments: () => store,
  })
  const messages = [{
    id: 'm-image',
    role: 'user',
    source: { kind: 'user' },
    content: [
      { type: 'text', text: 'What single digit is drawn in black on this white image? Reply with only the digit.' },
      { type: 'image', attachment: ref },
    ],
  }]
  const chunks = []
  let failure
  try {
    for await (const chunk of adapter.stream({
      provider: 'longcat',
      model: VISION_MODEL,
      messages,
      maxTokens: 32,
      reasoningEffort: 'off',
    })) chunks.push(chunk)
  } catch (error) {
    failure = error
  }
  report('image request accepted by the adapter path', failure === undefined,
    failure === undefined ? '' : String(failure?.message ?? failure))
  const text = chunks
    .filter(chunk => chunk.type === 'text-delta')
    .map(chunk => chunk.text)
    .join('')
  report('the model read the image', text.includes(digit), `answered ${JSON.stringify(text.trim())}`)
  const reason = chunks.at(-1)?.reason
  report('image finish is a non-error terminal state',
    reason?.kind === 'stop' || reason?.kind === 'max-tokens',
    JSON.stringify(reason))
}

console.log(`\n${failures === 0 ? 'all checks passed' : `${failures} check(s) failed`}`)
process.exit(failures === 0 ? 0 : 1)
