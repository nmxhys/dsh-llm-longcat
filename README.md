# dsh-longcat

LongCat provider for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

Adds **LongCat-2.0** as a model provider: 1M context, thinking mode, tool calling.

## Install

```sh
dsh plugin --profile default add github:YOUR_GITHUB_USER/dsh-longcat
export LONGCAT_API_KEY=...   # create one at https://longcat.chat/platform/api_keys
```

Installing a bundle lets the package's install scripts run on your machine,
outside the sandbox the agent runs under. Pin a commit so a later push cannot
change what executes:

```sh
dsh plugin --profile default add github:YOUR_GITHUB_USER/dsh-longcat#COMMIT_SHA
```

Then pick **LongCat-2.0** in the model selector. The key may also be stored
through the Web UI's Models page instead of the environment; either way it is
resolved per request through the credential seam, and no secret is written into
any config file.

## Why this is configuration, not an adapter

LongCat's chat endpoint is OpenAI-compatible, and its reasoning parameter is
DeepSeek's `thinking: {type: enabled|disabled}` object rather than OpenAI's
`reasoning_effort` string. DeepSeek Harness already ships an adapter that
speaks both — `@deepseek-ai/dsh-llm-pi-ai` — so this bundle declares a route on
it instead of implementing the `LlmAdapter` contract again.

That is deliberate. A hand-written adapter would have to re-implement SSE
framing, the `usage`-before-`finish` ordering rule, idle-timeout handling,
retry-policy registration, and app-attribution headers — all of which the
shipped adapter already does and tests. The one thing configuration cannot fix
is a genuinely different wire protocol, and LongCat does not have one.

Two switches carry the whole integration:

| Setting | Why |
|---|---|
| `compat.thinkingFormat: deepseek` | pi-ai infers the reasoning dialect from the endpoint URL. `api.longcat.chat` tells it nothing, so without this it speaks the OpenAI dialect and **thinking silently never turns on**. |
| `compat.supportsReasoningEffort: false` | LongCat's `supported_parameters` lists `thinking` but not `reasoning_effort`. This keeps the unsupported field off the wire. |

## What gets sent

`reasoningEfforts` declares a binary switch, because that is what LongCat
exposes. The resulting request bodies:

| Selected effort | Wire body |
|---|---|
| `high` | `{"thinking": {"type": "enabled"}}` |
| `off` | `{"thinking": {"type": "disabled"}}` |
| *(none named)* | `{"thinking": {"type": "disabled"}}` |

`off` is spelled as a valueless key so that selecting it sends an explicit
`disabled` rather than omitting the parameter — omitting it would hand the
decision to LongCat's server-side default, which is not what "off" should mean.

No request carries `reasoning_effort` at any level. `tests/wire.test.js`
asserts each of these bodies.

## Model facts

From `GET /openai/v1/models/LongCat-2.0`, which is the only documented endpoint
that reports capabilities:

| | |
|---|---|
| Context | 1,048,576 tokens (1M) |
| Max output | 131,072 (documented cap on the chat endpoint) |
| Modality | text → text (**no image input**) |
| Tool calling | yes (`tools`, `tool_choice`) |
| Reasoning | yes (`thinking`) |

Note that tool calling is **not** mentioned on the chat-completions doc page;
it is only visible in `supported_parameters` on the model-detail endpoint. The
e2e script exercises it directly rather than trusting either page.

## Configuration

Override anything in `$DSH_HOME/settings.yaml` without touching the bundle —
settings win over the bundle's patch layer, and changes apply to the next
request without a restart:

```yaml
llm-pi-ai:
  providers:
    longcat:
      # Point at a gateway instead of the public endpoint.
      baseURL: https://your-gateway.example/openai/v1
      # Read the key from a different variable.
      apiKeyEnv: MY_LONGCAT_KEY
      # Bound how long one idle provider read may block (default 5 min).
      streamIdleTimeoutMs: 300000
```

Careful with `models`: declaring that key **replaces** the bundle's model list
rather than extending it, so every model you want served must appear in it. To
adjust a single field, use `modelOverrides` keyed by model id instead.

## Tests

```sh
npm test          # offline; asserts the exact wire bodies the config produces
npm run test:e2e  # real API, needs LONGCAT_API_KEY, spends a few hundred tokens
```

The unit tests deliberately re-derive the request body from the shipped
`cordis.patch.yml` rather than from a copy of the values, so editing the patch
is what makes them fail. They cover the config; the e2e script covers the
assumption that LongCat accepts it, including streaming, `[DONE]` framing, tool
calls, and the model catalog.

## Limitations

- **No image input.** LongCat-2.0 is text-only, so the harness refuses an
  attached image before sending, naming the model. Do not add
  `input: [text, image]` — it would state a claim the endpoint does not honor
  and turn a clear client-side refusal into a provider error.
- **Reasoning is binary.** There is no low/medium/high gradient to map; only
  on and off are representable.
- **`reasoning_effort` is unsupported** and intentionally never sent.

## License

MIT
