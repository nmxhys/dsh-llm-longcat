/**
 * dsh-longcat — LongCat provider bundle for DeepSeek Harness.
 *
 * The provider route itself is declared in `cordis.patch.yml`, which
 * configures the shipped `@deepseek-ai/dsh-llm-pi-ai` adapter. LongCat's chat
 * endpoint is OpenAI-compatible and speaks the DeepSeek reasoning dialect, so
 * no wire adapter is needed — writing one would duplicate SSE framing, retry,
 * and the whole `LlmAdapter` contract for no gain.
 *
 * This module exists so the bundle has a loadable plugin entry: it verifies
 * the credential is reachable at boot and says so once, rather than letting
 * the first request fail with MISSING_CREDENTIAL and no hint about which
 * variable to set.
 *
 * @module dsh-longcat
 */

export const name = 'longcat'

/** Environment variable the patch's `apiKeyEnv` reference points at. */
const API_KEY_ENV = 'LONGCAT_API_KEY'

/** Where users create a key. */
const CONSOLE_URL = 'https://longcat.chat/platform/api_keys'

export function apply(ctx) {
  // The credential seam resolves the key per request; this is only a boot-time
  // courtesy check. A miss is not fatal — the key may be stored through the
  // Web Models page after startup, and the route stays browsable either way.
  const credentials = ctx.get?.('credentials')
  if (credentials === undefined && process.env[API_KEY_ENV] === undefined) {
    ctx.logger?.warn?.(
      `longcat: no ${API_KEY_ENV} in the environment and no credentials service mounted; `
      + `export ${API_KEY_ENV} or store the key through the Models page (${CONSOLE_URL})`,
    )
  }
}
