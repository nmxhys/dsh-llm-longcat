# dsh-llm-longcat

LongCat adapter for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) LLM seam.

Adds **LongCat-2.5-Preview** (text + image) and **LongCat-2.0** (text) as model
providers: 1M context, thinking mode, tool calling.

## Features

- **Thinking mode** — recognizes LongCat's `reasoning_content` field and translates it into harness `ReasoningBlock`s
- **Tool calling** — full function-calling support, with `arguments` kept a raw JSON string end to end
- **Images** — deterministic request-image preparation with inline `data:` parts, durable offload placeholders, and the harness's `IMAGE_OFFLOAD_REQUIRED` budget contract
- **Multi-turn** — replays `reasoning_content` on tool-call turns, as thinking-mode passback requires
- **Streaming** — SSE with the `usage`-before-`finish` ordering the harness relies on
- **Credential seam** — the key resolves per request from `ctx.credentials` or the environment; no secret in any config file

## Supported models

| Model | Input | Context | Max output | Notes |
|---|---|---|---|---|
| `LongCat-2.5-Preview` | text + image | 1,048,576 | 131,072 | native multi-modal; thinking + tool calling |
| `LongCat-2.0` | text | 1,048,576 | 131,072 | text-only; thinking + tool calling |

Facts from `GET /openai/v1/models/{model}`, the only documented endpoint that
reports `supported_parameters` and `architecture`. Tool calling and image input
are **not** mentioned on the chat-completions doc page and are only visible
there; both were verified against live traffic (see [Images](#images)).

Prices (per 1M tokens, ¥): uncached input 2, cached input 0.04, output 8. The
harness has no spend or cost seam — no consumer reports money — so these are
documentation, not configuration; the LongCat platform's billing records are
authoritative.

## Install

```sh
dsh plugin --profile default add github:ffyuuu/dsh-llm-longcat
export LONGCAT_API_KEY=...   # create one at https://longcat.chat/platform/api_keys
```

Installing a bundle lets the package's install scripts run on your machine,
outside the sandbox the agent runs under. Pin a commit so a later push cannot
change what executes:

```sh
dsh plugin --profile default add github:ffyuuu/dsh-llm-longcat#<commit-sha>
```

Then pick **LongCat-2.5-Preview** or **LongCat-2.0** in the model selector. The
key may also be stored through the Web UI's Models page instead of the
environment.

### Harness compatibility

This adapter tracks the DeepSeek Harness `@deepseek-ai` release line it was
written against; peer dependencies require `>=0.2.0-rc.1`. That line made tool
results first-class `role: 'tool'` messages (the `tool-result` content block is
gone), introduced `developer` messages for in-history tool changes, added
`ImageBlock.offloaded` with the `IMAGE_OFFLOAD_REQUIRED` contract, and replaced
the optional settings section with a config form projected from the plugin's own
`Config` schema. Earlier lines fail in different ways:

| Host line | Failure |
|---|---|
| `0.2.0-rc.1`+ | works (this build) |
| `0.1.3-alpha.1` … `0.1.7` | `role: 'tool'` messages rejected; no image pipeline |
| `rc.2` and older | plugin load fails: `does not provide an export named 'CallId'` |

Upgrade the harness rather than pinning this plugin back.

### If `dsh` itself will not install

At the time of writing, installing the harness can fail before any plugin is
reached, with either `ETARGET … dsh-typert-protocol@^0.1.0-rc.8` or an npm
heap exhaustion. That is an upstream packaging state, not this plugin:
`@deepseek-ai/dsh` published `0.1.0-rc.8` while several packages it depends on
stopped at `0.1.0-rc.7`, and because the manifests use caret ranges,
`^0.1.0-rc.7` still resolves up into the missing `rc.8`. npm then backtracks
over an unsatisfiable graph until it runs out of memory.

Pinning every `@deepseek-ai/*` package to an exact `0.1.0-rc.7` through npm
`overrides` avoids the drift. That packaging state predates the current lines;
the peer floors already assert the newer API.

## Config

Configuration lives in the profile's patch layer (`$DSH_HOME/profiles/<name>/cordis.patch.yml`)
or in the harness settings form, which projects this plugin's `Config` schema.
The bundle ships these defaults:

```yaml
- id: llm-longcat
  name: dsh-llm-longcat
  config:
    apiKeyEnv: LONGCAT_API_KEY   # default; resolved per request, never a literal key
    baseURL: https://api.longcat.chat/openai/v1  # optional; $LONGCAT_BASE_URL then the public API
    thinking: enabled            # optional deployment policy; `disabled` locks every request to off
    reasoningEffort: high        # optional; off | high — LongCat's switch is binary
    maxTokens: 131072            # optional per-request output cap
    defaultContextWindow: 1048576
    maxRequestImageBytes: 20971520  # optional; accumulated base64 image bound (20 MiB)
    maxImagesPerRequest: 100     # optional; omission leaves the image count unbounded
    streamIdleTimeoutMs: 300000  # optional; five-minute default
    retryPolicy:                 # optional; omission uses bounded normal defaults
      mode: normal
      maxRetries: 3
    models:
      - id: LongCat-2.5-Preview
        contextWindow: 1048576
        inputModalities: [text, image]
        imageMaxPixels: 4194304  # optional per-image pixel budget (2048×2048)
        imageMaxBytes: 1048576   # optional per-image encoded-byte target (1 MiB)
```

`apiKeyEnv`, `models`, and `retryPolicy` are volatile: editing the credential
reference, the catalog, or the retry policy updates the running route in place,
so an added model or a changed policy reaches the very next request. Every other
field is re-resolved when the entry is re-applied. Either way an in-flight
stream keeps the facts it started with.

## Images

`LongCat-2.5-Preview` accepts images; `LongCat-2.0` does not, and the catalog
says so through `inputModalities`, which is what the host reads before it
durably accepts an upload or substitutes placeholder text.

- Every request image is re-encoded once into deterministic request bytes: the
  route's pixel budget bounds its dimensions, its byte target bounds the
  encoding, and the same history always produces the same request.
- The wire carries the standard OpenAI content parts — a text handle naming the
  image (with its read-only copy path) followed by an inline
  `{"type":"image_url","image_url":{"url":"data:image/png;base64,…"}}` part.
  LongCat's chat docs document `content` as a plain string only; the accepted
  part array is visible in `architecture.input_modalities` and was verified by
  reading rendered digits out of generated images over live traffic (the e2e
  suite does exactly that).
- An occurrence the session marked offloaded becomes placeholder text and is
  never read. When retained occurrences still exceed `maxRequestImageBytes` or
  `maxImagesPerRequest`, the request fails with `IMAGE_OFFLOAD_REQUIRED` naming
  how many more of the oldest occurrences must be offloaded — the harness
  advances its offload and retries, rather than this adapter dropping bytes.
- No `imageRequestPricing` is declared: LongCat reports image tokens inside
  `prompt_tokens` while `prompt_tokens_details.image_tokens` stays 0, so there
  is no provider-published visual-token rule to price exactly. The token meter's
  neutral heuristic stands, and provider usage remains the anchor.

## Reasoning is binary, deliberately

LongCat controls thinking with `thinking: {type: enabled|disabled}` and does
**not** accept OpenAI's top-level `reasoning_effort` — its
`supported_parameters` lists the former and omits the latter. There is
therefore no low/medium/high gradient to map, and this adapter offers exactly
two levels rather than advertising controls that would collapse onto the same
two request bodies:

| Selected effort | Wire body |
|---|---|
| `high` ("Thinking") | `{"thinking": {"type": "enabled"}}` |
| `off` | `{"thinking": {"type": "disabled"}}` |
| *(none named)* | resolves from config; still explicit |

`off` serializes an explicit `disabled` rather than omitting the field —
omitting it would hand the decision to LongCat's server-side default, which is
not what selecting Off should mean. Requesting `low`, `medium`, or `max` fails
with `UNSUPPORTED_REASONING_EFFORT` before any network I/O.

## Wire-format notes

- **Tool-call deltas repeat `id` and `name` as explicit `null`.** LongCat sends
  them on the opening delta and then `null` (not omitted) on every
  continuation, so a naive `!== undefined` guard blanks the assembled call's
  name. Verified on live traffic; pinned by a regression test.
- Streaming only, with `stream_options.include_usage` always on. Usage may
  arrive attached to the finish chunk or as a trailing usage-only chunk; both
  are deferred to `[DONE]` so `usage` always precedes `finish`.
- The first thinking-mode delta can be an empty string — it must not open a
  reasoning block.
- **Reasoning passback**: on assistant turns that carried tool calls,
  `reasoning_content` is serialized back into history; on tool-call-free turns
  it is dropped (ignored anyway — saves tokens).
- Assistant `content` is always a string, never null: the message is durable
  session history, and a null there would make later turns replay a body the
  endpoint can reject.
- Cache accounting: `prompt_tokens_details.cached_tokens` maps to
  `cacheReadTokens` and is subtracted out of `inputTokens` to keep the
  harness's disjoint-count convention.

## Errors

Non-2xx responses throw `LlmError` with stable codes. LongCat documents a
dedicated **402** for exhausted token quota and puts `insufficient_quota` on
**403**, where most OpenAI-compatible providers use 429 — both are classified
as `QUOTA` before the auth and rate-limit buckets, so a depleted balance is
never reported as a bad key or retried as a transient rate limit.

| Condition | Code |
|---|---|
| 402, or quota detail at any status | `QUOTA_EXCEEDED` |
| 401 / 403 | `AUTH` |
| 429 | `RATE_LIMIT` |
| 400 with context-overflow detail | `CONTEXT_WINDOW_EXCEEDED` |
| other 400 | `INVALID_REQUEST` |
| 5xx | `SERVER` |
| no `[DONE]` / bad JSON | `STREAM_CLOSED` / `MALFORMED_RESPONSE` |
| images beyond the route budget | `IMAGE_OFFLOAD_REQUIRED` (+ `offloadImages`) |
| image on a text-only or unattached route | `UNSUPPORTED_CONTENT` |

A completed stream that opened no content blocks becomes a `finish` error with
`EMPTY_RESPONSE`, which the shipped retry policy treats as retryable.

## Tests

```sh
npm run typecheck   # against the @deepseek-ai packages of the target harness line
npm test            # 66 unit tests over serialize + images + catalog + entry + translate
npm run build       # emits lib/ and lib/types/
npm run test:e2e    # real API, needs LONGCAT_API_KEY, spends a few hundred tokens
```

`test:e2e` drives the built adapter's own image-preparation → serialize → SSE →
translate pipeline against `api.longcat.chat`, so it verifies what the plugin
actually sends rather than a hand-written approximation: it caught the null-name
delta bug, and its image check renders a digit and requires the model to read it
back.

## Limitations

- **`LongCat-2.0` has no image input.** It reports `modality: text->text`, so its
  catalog entry advertises text-only; the host then substitutes placeholder text
  instead of routing an image to it. Use `LongCat-2.5-Preview` for images.
- **No stop sequences.** `stop` is absent from `supported_parameters`; passing
  one fails with `UNSUPPORTED_OPTION` rather than silently running past it.
- **Reasoning is binary** — no low/medium/high gradient exists to map.
- **No spend reporting.** The harness has no cost seam, so the published prices
  cannot drive a total; see [Supported models](#supported-models).

## License

MIT
