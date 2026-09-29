/**
 * The plugin entry is the one seam no other suite exercises: the harness calls
 * `apply(ctx, config)` with a loader-resolved config, and the route only works
 * if the directory entry, the adapter registration, and the volatile-update
 * listener are all wired. A fake context pins that contract without booting a
 * harness.
 */

import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { RetryPolicyConfig } from '@deepseek-ai/dsh-llm'
import { LongCatAdapter } from '../src/adapter.ts'
import { Config, apply } from '../src/index.ts'
import type { Config as LongCatConfig } from '../src/index.ts'

interface Recorded {
  directory: { provider: string; displayName: string; settingsNs: string; settingsPath: string[] }[]
  registered: string[]
  replaced: string[][]
  listeners: Map<string, () => void>
  warnings: unknown[]
}

/** Minimal context surface the plugin entry touches. */
function fakeContext(entryId: string | undefined): { ctx: Context; recorded: Recorded } {
  const recorded: Recorded = { directory: [], registered: [], replaced: [], listeners: new Map(), warnings: [] }
  const ctx = {
    logger: { warn: (...args: unknown[]) => recorded.warnings.push(args), error: () => {} },
    fiber: entryId === undefined ? {} : { entry: { options: { id: entryId } } },
    llm: {
      registerConfigurableProviders: (entries: Recorded['directory']) => {
        recorded.directory.push(...entries)
        return Object.assign(() => {}, { replace: () => {} })
      },
      registerAdapter: (providers: string[]) => {
        recorded.registered.push(...providers)
        return Object.assign(() => {}, { replace: (next: string[]) => recorded.replaced.push(next) })
      },
    },
    get: () => undefined,
    on: (event: string, listener: () => void) => { recorded.listeners.set(event, listener) },
  } as unknown as Context
  return { ctx, recorded }
}

function liveConfig(): LongCatConfig {
  return Config({}) as unknown as LongCatConfig
}

describe('plugin entry', () => {
  it('registers the longcat route and its adapter', () => {
    const { ctx, recorded } = fakeContext('llm-longcat')
    apply(ctx, liveConfig())
    expect(recorded.registered).toEqual(['longcat'])
    expect(recorded.directory).toEqual([
      { provider: 'longcat', displayName: 'LongCat', settingsNs: 'llm-longcat', settingsPath: [] },
    ])
  })

  it('keys the settings form by the composition entry id, falling back to the plugin name', () => {
    const named = fakeContext('longcat-alt')
    apply(named.ctx, liveConfig())
    expect(named.recorded.directory[0]?.settingsNs).toBe('longcat-alt')

    const anonymous = fakeContext(undefined)
    apply(anonymous.ctx, liveConfig())
    expect(anonymous.recorded.directory[0]?.settingsNs).toBe('llm-longcat')
  })

  it('subscribes the retry-policy refresh to volatile config updates only', () => {
    const { ctx, recorded } = fakeContext('llm-longcat')
    apply(ctx, liveConfig())
    expect([...recorded.listeners.keys()]).toEqual(['loader/volatile-update'])

    // An unchanged policy is not a reason to touch the registry.
    recorded.listeners.get('loader/volatile-update')?.()
    expect(recorded.replaced).toEqual([])
  })

  it('re-registers the route in place when the volatile retry policy changes', () => {
    const { ctx, recorded } = fakeContext('llm-longcat')
    // The registry captures the policy at registration, so a live change must
    // reach it through `replace` — the one fact per-request resolution cannot refresh.
    let policy: RetryPolicyConfig = { mode: 'normal', maxRetries: 3 }
    const config = {
      ...liveConfig(),
      retryPolicy: { get: () => policy },
    } as unknown as LongCatConfig
    apply(ctx, config)

    recorded.listeners.get('loader/volatile-update')?.()
    expect(recorded.replaced).toEqual([])

    policy = { mode: 'always' }
    recorded.listeners.get('loader/volatile-update')?.()
    expect(recorded.replaced).toEqual([['longcat']])
  })

  it('registers an adapter that serves the shipped catalog', async () => {
    const { ctx, recorded } = fakeContext('llm-longcat')
    let adapter: LongCatAdapter | undefined
    const capturing = {
      ...ctx,
      llm: {
        registerConfigurableProviders: () => Object.assign(() => {}, { replace: () => {} }),
        registerAdapter: (_providers: string[], instance: LongCatAdapter) => {
          adapter = instance
          return Object.assign(() => {}, { replace: () => {} })
        },
      },
    } as unknown as Context
    apply(capturing, liveConfig())
    expect(recorded.registered).toEqual([])

    const models = await adapter?.listModels('longcat')
    expect(models?.map(model => model.id)).toEqual(['LongCat-2.5-Preview', 'LongCat-2.0'])
    expect((await adapter?.resolveModel('longcat', 'LongCat-2.5-Preview'))?.inputModalities)
      .toEqual(['text', 'image'])
  })

  it('fails loudly when the bundle config is outside every schema bound', () => {
    const { ctx } = fakeContext('llm-longcat')
    const broken = { ...liveConfig(), streamIdleTimeoutMs: -1 } as LongCatConfig
    expect(() => apply(ctx, broken)).toThrow(/streamIdleTimeoutMs must be a positive finite number/)
  })
})
