/**
 * What this bundle actually promises is a *wire request LongCat accepts*, so
 * that is what these tests check. They reimplement the two upstream decisions
 * that stand between `cordis.patch.yml` and the HTTP body:
 *
 *   1. `dsh-llm-pi-ai` turns a `reasoningEfforts` declaration into pi-ai's
 *      `thinkingLevelMap` (undeclared levels pinned to null).
 *   2. pi-ai's `streamSimple` collapses the `off` level to "no effort", and
 *      its `openai-completions` API serializes the `deepseek` thinkingFormat.
 *
 * Mirroring upstream logic in a test is normally a smell, but here the whole
 * bundle is a claim about that logic: if pi-ai changes how the deepseek
 * dialect serializes, these tests still pass while the bundle breaks. They are
 * a guard on *our config*, not on pi-ai — the e2e script in this directory is
 * what proves the real endpoint agrees.
 *
 * Run: node --test tests/
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const patchPath = join(here, '..', 'cordis.patch.yml')

/** Every thinking level pi-ai knows, in the order dsh-llm-pi-ai iterates them. */
const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

/**
 * Minimal YAML reader for this file's fixed shape.
 *
 * The bundle has no dependencies and no build step, and pulling js-yaml in
 * just for tests would make `npm test` need an install. The patch is a small
 * file we control, so a scanner for the handful of constructs it uses is
 * enough — and it keeps the test honest about reading the shipped file rather
 * than a copy of the values.
 */
function readPatch(text) {
  const model = {}
  const compat = {}
  const provider = {}
  const efforts = {}
  let section = null

  for (const raw of text.split('\n')) {
    const line = raw.replace(/#.*$/, '').trimEnd()
    if (line.trim() === '') continue
    const indent = line.length - line.trimStart().length
    const body = line.trim()

    if (body === 'compat:') { section = 'compat'; continue }
    if (body === 'reasoningEfforts:') { section = 'efforts'; continue }
    if (body === 'models:') { section = 'model'; continue }

    const kv = body.match(/^-?\s*([A-Za-z0-9_'"-]+):\s*(.*)$/)
    if (kv === null) continue
    const key = kv[1].replace(/^['"]|['"]$/g, '')
    const rawValue = kv[2].trim()
    const value = rawValue === ''
      ? null
      : rawValue === 'true'
        ? true
        : rawValue === 'false'
          ? false
          : /^\d+$/.test(rawValue)
            ? Number(rawValue)
            : rawValue.replace(/^['"]|['"]$/g, '')

    // reasoningEfforts entries sit deeper than the model keys that follow them.
    if (section === 'efforts' && indent >= 18) { efforts[key] = value; continue }
    if (section === 'efforts') section = 'model'
    if (section === 'compat' && indent >= 14) { compat[key] = value; continue }
    if (section === 'compat') section = null
    if (section === 'model') { model[key] = value; continue }
    provider[key] = value
  }
  return { provider, compat, model, efforts }
}

const patch = readPatch(readFileSync(patchPath, 'utf8'))

/** dsh-llm-pi-ai: a declaration becomes a map with undeclared levels pinned null. */
function toThinkingLevelMap(declared) {
  const map = {}
  for (const level of THINKING_LEVELS) {
    const wire = declared[level]
    if (wire === undefined) map[level] = null
    else if (wire !== null) map[level] = wire
  }
  return map
}

/**
 * pi-ai `streamSimple` + `openai-completions` deepseek dialect: the request
 * body fields this bundle is responsible for.
 */
function wireBody(map, compat, selectedLevel) {
  // streamSimple: the `off` level means "send no effort".
  const reasoningEffort = selectedLevel === 'off' ? undefined : selectedLevel
  const params = {}
  const model = { reasoning: true, thinkingLevelMap: map }
  if (compat.thinkingFormat === 'deepseek' && model.reasoning) {
    if (reasoningEffort) params.thinking = { type: 'enabled' }
    else if (model.thinkingLevelMap.off !== null) params.thinking = { type: 'disabled' }
    if (reasoningEffort && compat.supportsReasoningEffort) {
      params.reasoning_effort = map[reasoningEffort] ?? reasoningEffort
    }
  }
  return params
}

test('route targets the OpenAI-compatible LongCat endpoint', () => {
  assert.equal(patch.provider.baseURL, 'https://api.longcat.chat/openai/v1')
  assert.equal(patch.provider.api, 'openai-completions')
})

test('credential is a reference, never a literal key', () => {
  assert.equal(patch.provider.apiKeyEnv, 'LONGCAT_API_KEY')
  const text = readFileSync(patchPath, 'utf8')
  // A real LongCat key would appear as an `ak_...`-style literal; nothing in
  // this file may look like one.
  assert.equal(/['"]?ak[_-][A-Za-z0-9]{8,}/.test(text), false, 'patch must not embed a key')
})

test('model advertises the documented capacity', () => {
  assert.equal(patch.model.id, 'LongCat-2.0')
  // context_length from GET /openai/v1/models/LongCat-2.0
  assert.equal(patch.model.contextWindow, 1048576)
  // Documented chat-endpoint cap: max_tokens <= 131072
  assert.equal(patch.model.maxTokens, 131072)
  assert.ok(patch.model.maxTokens <= patch.model.contextWindow)
})

test('reasoning dialect is deepseek and effort strings stay off the wire', () => {
  // pi-ai guesses the dialect from the URL; api.longcat.chat reveals nothing,
  // so an explicit switch is the only thing that makes thinking work at all.
  assert.equal(patch.compat.thinkingFormat, 'deepseek')
  // LongCat's supported_parameters lists `thinking` but not `reasoning_effort`.
  assert.equal(patch.compat.supportsReasoningEffort, false)
})

test('declared levels are exactly the binary switch LongCat exposes', () => {
  assert.deepEqual(Object.keys(patch.efforts).sort(), ['high', 'off'])
  // Valueless `off` is the spelling that makes Off selectable; only `off` may
  // omit its wire value, and at least one level beyond `off` must exist or
  // dsh-llm-pi-ai refuses the profile.
  assert.equal(patch.efforts.off, null)
  assert.equal(patch.efforts.high, 'high')
})

test('serializes exactly the three bodies LongCat documents', () => {
  const map = toThinkingLevelMap(patch.efforts)
  const compat = patch.compat

  assert.deepEqual(
    wireBody(map, compat, 'high'),
    { thinking: { type: 'enabled' } },
    'selecting high must enable thinking',
  )
  assert.deepEqual(
    wireBody(map, compat, 'off'),
    { thinking: { type: 'disabled' } },
    'selecting off must explicitly disable thinking, not fall through to the server default',
  )
  assert.deepEqual(
    wireBody(map, compat, undefined),
    { thinking: { type: 'disabled' } },
    'naming no effort must still be explicit',
  )
})

test('no request ever carries an unsupported reasoning_effort', () => {
  const map = toThinkingLevelMap(patch.efforts)
  for (const level of [...THINKING_LEVELS, undefined]) {
    const body = wireBody(map, patch.compat, level)
    assert.equal(
      Object.hasOwn(body, 'reasoning_effort'),
      false,
      `level ${String(level)} leaked reasoning_effort, which LongCat does not accept`,
    )
  }
})

test('bundle manifest points at the shipped patch', () => {
  const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'))
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml')
  assert.ok(pkg.files.includes('cordis.patch.yml'), 'patch must be published')
  assert.ok(pkg.keywords.includes('dsh-plugin'), 'topic keyword aids discovery')
})
