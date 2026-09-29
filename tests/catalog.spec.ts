/**
 * The shipped catalog and the capability metadata the host acts on: an
 * image-capable route must advertise the `image` modality or the harness
 * substitutes placeholder text and a user's screenshot never reaches the
 * model, while a text-only route must not advertise it.
 */

import { describe, expect, it } from 'vitest'
import { Config, LongCatAdapter, PUBLIC_BASE_URL, resolveAdapterOptions } from '../src/index.ts'
import type { LongCatConnectionOptions } from '../src/index.ts'

function connection(patch: Partial<LongCatConnectionOptions> = {}): LongCatConnectionOptions {
  return { ...resolveAdapterOptions({}), ...patch }
}

function adapterFor(options: LongCatConnectionOptions): LongCatAdapter {
  return new LongCatAdapter({ options: () => options, resolveApiKey: () => Promise.resolve('key') })
}

describe('shipped catalog', () => {
  it('ships LongCat-2.5-Preview as an image-capable model and LongCat-2.0 as text-only', () => {
    const { models } = resolveAdapterOptions({})
    expect(models.map(model => model.id)).toEqual(['LongCat-2.5-Preview', 'LongCat-2.0'])
    expect(models[0]?.inputModalities).toEqual(['text', 'image'])
    expect(models[1]?.inputModalities).toEqual(['text'])
  })

  it('carries the live 1M context and the documented output cap', () => {
    for (const model of resolveAdapterOptions({}).models) {
      expect(model.contextWindow).toBe(1_048_576)
      expect(model.maxTokens).toBe(131_072)
    }
  })

  it('resolves the public endpoint and the default credential reference', () => {
    const resolved = resolveAdapterOptions({})
    expect(resolved.baseURL).toBe(PUBLIC_BASE_URL)
    expect(resolved.apiKeyEnv).toBe('LONGCAT_API_KEY')
    expect(resolved.maxRequestImageBytes).toBe(20 * 1024 * 1024)
  })

  it('rejects a text-only model that declares image request limits', () => {
    expect(() => resolveAdapterOptions({
      models: [{ id: 'x', inputModalities: ['text'], imageMaxBytes: 1024 }],
    })).toThrow(/cannot declare image request limits/)
  })

  it('rejects duplicate ids, empty modality lists, and unknown modalities', () => {
    expect(() => resolveAdapterOptions({ models: [{ id: 'x' }, { id: 'x' }] }))
      .toThrow(/duplicate catalog model/)
    expect(() => resolveAdapterOptions({ models: [{ id: 'x', inputModalities: [] }] }))
      .toThrow(/must not be empty/)
    expect(() => resolveAdapterOptions({ models: [{ id: 'x', inputModalities: ['audio'] as never }] }))
      .toThrow(/must contain only "text" and "image"/)
  })

  it('rejects non-positive image bounds', () => {
    expect(() => resolveAdapterOptions({ maxRequestImageBytes: 0 })).toThrow(/positive safe integer/)
    expect(() => resolveAdapterOptions({ maxImagesPerRequest: -1 })).toThrow(/positive safe integer/)
  })
})

describe('resolved model capabilities', () => {
  it('advertises the image modality for the multi-modal model', async () => {
    const info = await adapterFor(connection()).resolveModel('longcat', 'LongCat-2.5-Preview')
    expect(info.inputModalities).toContain('image')
    expect(info.context?.contextWindow).toBe(1_048_576)
    expect(info.defaultMaxTokens).toBe(131_072)
    expect(info.reasoning?.efforts.map(effort => effort.id)).toEqual(['off', 'high'])
  })

  it('advertises text-only for LongCat-2.0 and for an uncatalogued id', async () => {
    const adapter = adapterFor(connection())
    expect((await adapter.resolveModel('longcat', 'LongCat-2.0')).inputModalities).toEqual(['text'])
    expect((await adapter.resolveModel('longcat', 'not-in-catalog')).inputModalities).toEqual(['text'])
  })

  it('lists every configured model, because GUI selection requires membership', async () => {
    const models = await adapterFor(connection()).listModels('longcat')
    expect(models.map(model => model.id)).toEqual(['LongCat-2.5-Preview', 'LongCat-2.0'])
    expect(models[0]?.inputModalities).toEqual(['text', 'image'])
  })

  it('narrows the offered efforts to off when the deployment disables thinking', async () => {
    const info = await adapterFor(connection({ defaults: { thinking: 'disabled' } }))
      .resolveModel('longcat', 'LongCat-2.5-Preview')
    expect(info.reasoning?.efforts.map(effort => effort.id)).toEqual(['off'])
  })
})

describe('config schema', () => {
  it('resolves a volatile credential reference and the shipped catalog by default', () => {
    const config = Config({})
    expect(config.apiKeyEnv.get()).toBe('LONGCAT_API_KEY')
    expect(config.models?.get().map(model => model.id)).toEqual(['LongCat-2.5-Preview', 'LongCat-2.0'])
    expect(config.maxRequestImageBytes).toBe(20 * 1024 * 1024)
  })

  it('keeps thinking and effort defaults unset so the adapter decides per request', () => {
    const config = Config({})
    expect(config.thinking).toBeUndefined()
    expect(config.reasoningEffort).toBeUndefined()
  })
})
