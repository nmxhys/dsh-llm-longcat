# dsh-llm-longcat

LongCat adapter for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) LLM seam.

Adds **LongCat-2.0** as a model provider: 1M context, thinking mode, tool calling.

## Features

- **Thinking mode** — recognizes LongCat's `reasoning_content` field and translates it into harness `ReasoningBlock`s
- **Tool calling** — full function-calling support, with `arguments` kept a raw JSON string end to end
- **Multi-turn** — replays `reasoning_content` on tool-call turns, as thinking-mode passback requires
- **Streaming** — SSE with the `usage`-before-`finish` ordering the harness relies on
- **Credential seam** — the key resolves per request from `ctx.credentials` or the environment; no secret in any config file

## Supported models

| Model | Context | Max output | Notes |
|---|---|---|---|
| `LongCat-2.0` | 1,048,576 | 131,072 | text-only; thinking + tool calling |

Facts from `GET /openai/v1/models/LongCat-2.0`, the only documented endpoint that
reports `supported_parameters`. Tool calling is **not** mentioned on the
chat-completions doc page and is only visible there.

## Install

```sh
dsh plugin --profile default add github:ffyuuu/dsh-llm-longcat
export LONGCAT_API_KEY=...   # create one at https://longcat.chat/platform/api_keys
```

Installing a bundle lets the package's install scripts run on your machine,
outside the sandbox the agent runs under. Pin a commit so a later push cannot
change what executes:

```sh
dsh plugin --profile default add github:ffyuuu/dsh-llm-longcat#3dcb3b1b5870ba52baab053453bdbb28826e5f13
```

Then pick **LongCat-2.0** in the model selector. The key may also be stored
through the Web UI's Models page instead of the environment.

### If `dsh` itself will not install

At the time of writing, installing the harness can fail before any plugin is
reached, with either `ETARGET … dsh-typert-protocol@^0.1.0-rc.8` or an npm
heap exhaustion. That is an upstream packaging state, not this plugin:
`@deepseek-ai/dsh` published `0.1.0-rc.8` while several packages it depends on
stopped at `0.1.0-rc.7`, and because the manifests use caret ranges,
`^0.1.0-rc.7` still resolves up into the missing `rc.8`. npm then backtracks
over an unsatisfiable graph until it runs out of memory.

Pinning every `@deepseek-ai/*` package to an exact `0.1.0-rc.7` through npm
`overrides` avoids the drift. Nothing in this plugin needs changing either
way — it declares `>=0.1.0-rc.7` and works against whichever of those the
host ends up with.

## Config

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
    streamIdleTimeoutMs: 300000  # optional; five-minute default
    retryPolicy:                 # optional; omission uses bounded normal defaults
      mode: normal
      maxRetries: 3
    models:
      - id: LongCat-2.0
        contextWindow: 1048576
```

A `llm-longcat:` section in `$DSH_HOME/settings.yaml` overrides any field
without a restart: base URL, catalog, request defaults, and idle budget all
take effect on the next request, while an in-flight stream keeps the facts it
started with.

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

A completed stream that opened no content blocks becomes a `finish` error with
`EMPTY_RESPONSE`, which the shipped retry policy treats as retryable.

## Tests

```sh
npm run typecheck   # against the published @deepseek-ai/dsh-llm types
npm test            # 30 unit tests over serialize + translate
npm run build       # emits lib/ and lib/types/
npm run test:e2e    # real API, needs LONGCAT_API_KEY, spends a few hundred tokens
```

`test:e2e` drives the built adapter's own serialize → SSE → translate pipeline
against `api.longcat.chat`, so it verifies what the plugin actually sends
rather than a hand-written approximation. It is what caught the null-name
delta bug.

## Limitations

- **No image input.** LongCat-2.0 reports `modality: text->text`, so image
  content is refused before sending, naming the model.
- **No stop sequences.** `stop` is absent from `supported_parameters`; passing
  one fails with `UNSUPPORTED_OPTION` rather than silently running past it.
- **Reasoning is binary** — no low/medium/high gradient exists to map.

## License

MIT
