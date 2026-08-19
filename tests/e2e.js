/**
 * Real-API check against LongCat. The unit tests prove the bundle produces the
 * body we intend; only this proves LongCat accepts it.
 *
 * It sends the exact bodies `cordis.patch.yml` causes — thinking enabled,
 * thinking disabled, and a tool-calling round — and reports what came back.
 * Nothing here is mocked and nothing is asserted against a fixture: a change
 * in LongCat's behavior should show up as a visible difference, not a green
 * test.
 *
 * Usage:  LONGCAT_API_KEY=... node tests/e2e.js
 *
 * Costs real tokens (a few hundred). Not part of `npm test`.
 */

const API_KEY = process.env.LONGCAT_API_KEY
const BASE_URL = process.env.LONGCAT_BASE_URL ?? 'https://api.longcat.chat/openai/v1'
const MODEL = process.env.LONGCAT_MODEL ?? 'LongCat-2.0'

if (!API_KEY) {
  console.error('LONGCAT_API_KEY is not set. Create a key at https://longcat.chat/platform/api_keys')
  process.exit(2)
}

/**
 * @param {object} body - request body to POST to /chat/completions.
 * @returns {Promise<{status: number, json: any}>} status and parsed payload.
 */
async function post(body) {
  const response = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })
  const text = await response.text()
  let json
  try {
    json = JSON.parse(text)
  } catch {
    json = { _raw: text.slice(0, 400) }
  }
  return { status: response.status, json }
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

console.log(`endpoint ${BASE_URL}`)
console.log(`model    ${MODEL}\n`)

// 1. Thinking enabled — the body the bundle sends when `high` is selected.
{
  const { status, json } = await post({
    model: MODEL,
    messages: [{ role: 'user', content: 'What is 17 * 23? Think it through.' }],
    max_tokens: 512,
    thinking: { type: 'enabled' },
  })
  const message = json?.choices?.[0]?.message
  report('thinking:enabled accepted', status === 200, `HTTP ${status}`)
  report(
    'reasoning_content present',
    typeof message?.reasoning_content === 'string' && message.reasoning_content.length > 0,
    'the adapter maps this field to reasoning blocks',
  )
  const reasoningTokens = json?.usage?.completion_tokens_details?.reasoning_tokens
  report('reasoning_tokens reported', typeof reasoningTokens === 'number', `got ${reasoningTokens}`)
}

// 2. Thinking disabled — the body sent for `off`, and when no effort is named.
{
  const { status, json } = await post({
    model: MODEL,
    messages: [{ role: 'user', content: 'Reply with the single word: ok' }],
    max_tokens: 64,
    thinking: { type: 'disabled' },
  })
  const message = json?.choices?.[0]?.message
  report('thinking:disabled accepted', status === 200, `HTTP ${status}`)
  report(
    'no reasoning returned when disabled',
    !message?.reasoning_content,
    'a non-empty value here would mean Off does not actually disable thinking',
  )
}

// 3. Tool calling. The chat docs omit it, but the model-detail endpoint lists
//    `tools` and `tool_choice` in supported_parameters — the harness needs it
//    for every agent loop, so it is worth confirming directly.
{
  const { status, json } = await post({
    model: MODEL,
    messages: [{ role: 'user', content: "What is the weather in Beijing? Use the tool." }],
    max_tokens: 256,
    tools: [{
      type: 'function',
      function: {
        name: 'get_weather',
        description: 'Get current weather for a city',
        parameters: {
          type: 'object',
          properties: { city: { type: 'string', description: 'City name' } },
          required: ['city'],
        },
      },
    }],
  })
  const toolCalls = json?.choices?.[0]?.message?.tool_calls
  report('tools parameter accepted', status === 200, `HTTP ${status}`)
  report(
    'model emits tool_calls',
    Array.isArray(toolCalls) && toolCalls.length > 0,
    toolCalls ? `called ${toolCalls[0]?.function?.name}` : 'no tool_calls in response',
  )
  if (Array.isArray(toolCalls) && toolCalls.length > 0) {
    report(
      'tool_calls arguments are a JSON string',
      typeof toolCalls[0]?.function?.arguments === 'string',
      'the adapter contract requires raw JSON strings end to end',
    )
  }
}

// 4. Streaming — every harness request streams, so a non-streaming-only
//    endpoint would break the bundle regardless of the body being valid.
{
  const response = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: 'user', content: 'Count: 1 2 3' }],
      max_tokens: 64,
      stream: true,
    }),
  })
  const text = await response.text()
  report('stream:true accepted', response.status === 200, `HTTP ${response.status}`)
  report('SSE frames delivered', text.includes('data:'), `${text.length} bytes`)
  report('stream terminates with [DONE]', text.includes('[DONE]'),
    'the adapter needs this marker to order usage before finish')
}

// 5. Model catalog — what the Web UI's "Fetch available models" button calls.
{
  const response = await fetch(`${BASE_URL}/models`, {
    headers: { 'Authorization': `Bearer ${API_KEY}` },
  })
  const json = await response.json().catch(() => null)
  const ids = json?.data?.map(m => m.id) ?? []
  report('GET /models works', response.status === 200, `HTTP ${response.status}`)
  report(`configured model ${MODEL} is listed`, ids.includes(MODEL), `listed: ${ids.join(', ') || 'none'}`)
}

console.log(`\n${failures === 0 ? 'all checks passed' : `${failures} check(s) failed`}`)
process.exit(failures === 0 ? 0 : 1)
