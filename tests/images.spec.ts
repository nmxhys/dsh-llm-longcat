/**
 * Request-image preparation is the one place this adapter spends provider
 * bytes on the user's behalf, so the suite pins the three decisions it makes:
 * an offloaded occurrence becomes text and is never read, a retained one is
 * read once at its route target, and a payload the route cannot send fails
 * with the exact count the harness needs to advance its offload.
 */

import { describe, expect, it } from 'vitest'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, ImageBlock, RequestMessage } from '@deepseek-ai/dsh-llm'
import type { AttachmentStore, ImageAttachmentRef, ImageRequestTarget, RequestImageAttachment } from '@deepseek-ai/dsh-attachment'
import { DEFAULT_IMAGE_MAX_BYTES, DEFAULT_IMAGE_PIXEL_BUDGET, imageRequestTarget, prepareImages } from '../src/images.ts'
import type { LongCatImageRequestOptions } from '../src/images.ts'

const IMAGE_MODEL = { inputModalities: ['text', 'image'] as const }
const TEXT_MODEL = { inputModalities: ['text'] as const }

function imageRef(patch: Partial<ImageAttachmentRef> = {}): ImageAttachmentRef {
  return {
    attachmentId: 'sha256:img' as ImageAttachmentRef['attachmentId'],
    mediaType: 'image/png',
    bytes: 4_096,
    width: 4_000,
    height: 3_000,
    ...patch,
  }
}

/** Attachment store stub: no filesystem, exact target capture. */
function stubStore(): { store: AttachmentStore; targets: ImageRequestTarget[]; reads: number } {
  const targets: ImageRequestTarget[] = []
  const state = {
    reads: 0,
    targets,
    store: {
      async readImageRequest(ref: ImageAttachmentRef, target: ImageRequestTarget): Promise<RequestImageAttachment> {
        state.reads += 1
        targets.push(target)
        return {
          variantId: 'variant' as RequestImageAttachment['variantId'],
          attachment: ref,
          data: new Uint8Array(ref.bytes),
          mediaType: ref.mediaType,
          bytes: ref.bytes,
          width: target.width,
          height: target.height,
          depth: 'uchar',
          space: 'srgb',
          hasAlpha: false,
        }
      },
    } as unknown as AttachmentStore,
  }
  return state
}

const access = () => ({ readonlyPath: '/tmp/normalized.png' })

function userWith(block: ImageBlock): RequestMessage {
  return createUserMessage({ content: [block], source: { kind: 'user' } })
}

function requestOptions(patch: Partial<LongCatImageRequestOptions> = {}): LongCatImageRequestOptions {
  return { model: IMAGE_MODEL, attachments: stubStore().store, access, maxRequestImageBytes: 20 * 1024 * 1024, ...patch }
}

describe('imageRequestTarget', () => {
  it('bounds large sources by the model pixel budget and keeps the byte target', () => {
    const target = imageRequestTarget({ imageMaxPixels: 1000 * 1000 }, imageRef())
    expect(target.width * target.height).toBeLessThanOrEqual(1_000_000)
    expect(target.maxBytes).toBe(DEFAULT_IMAGE_MAX_BYTES)
  })

  it('never enlarges a small source and defaults the pixel budget', () => {
    const target = imageRequestTarget({}, imageRef({ width: 320, height: 200 }))
    expect(target).toMatchObject({ width: 320, height: 200, maxBytes: DEFAULT_IMAGE_MAX_BYTES })
    expect(imageRequestTarget({}, imageRef()).width * imageRequestTarget({}, imageRef()).height)
      .toBeLessThanOrEqual(DEFAULT_IMAGE_PIXEL_BUDGET)
  })
})

describe('prepareImages', () => {
  it('passes a text-only request through without reading anything', async () => {
    const state = stubStore()
    const messages = [createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } })]
    const prepared = await prepareImages(messages, requestOptions({ attachments: state.store }))
    expect(prepared.messages).toBe(messages)
    expect(prepared.versions.size).toBe(0)
    expect(state.reads).toBe(0)
  })

  it('reads one request version per durable attachment at the route target', async () => {
    const state = stubStore()
    const ref = imageRef()
    const prepared = await prepareImages(
      [userWith({ type: 'image', attachment: ref })],
      requestOptions({
        attachments: state.store,
        model: { inputModalities: ['text', 'image'], imageMaxPixels: 512 * 512, imageMaxBytes: 64 * 1024 },
      }),
    )
    expect(state.reads).toBe(1)
    expect(state.targets[0]?.maxBytes).toBe(64 * 1024)
    // The budget is a total-pixel bound, so the aspect ratio is preserved.
    const version = prepared.versions.get(ref.attachmentId)
    expect((version?.width ?? 0) * (version?.height ?? 0)).toBeLessThanOrEqual(512 * 512)
    expect(version?.width).toBeLessThan(ref.width)
  })

  it('turns an offloaded occurrence into placeholder text without reading it', async () => {
    const state = stubStore()
    const prepared = await prepareImages(
      [userWith({ type: 'image', attachment: imageRef(), offloaded: true })],
      requestOptions({ attachments: state.store }),
    )
    expect(state.reads).toBe(0)
    const content = prepared.messages[0]?.content as ContentBlock[]
    expect(content[0]?.type).toBe('text')
    expect((content[0] as { text: string }).text).toContain('/tmp/normalized.png')
    expect(content[0]?.type).not.toBe('image')
  })

  it('refuses an image when the catalog model declares no image modality', async () => {
    await expect(prepareImages(
      [userWith({ type: 'image', attachment: imageRef() })],
      requestOptions({ model: TEXT_MODEL }),
    )).rejects.toThrow(/declares the image modality/)
  })

  it('refuses an image when no attachment service is mounted', async () => {
    await expect(prepareImages(
      [userWith({ type: 'image', attachment: imageRef() })],
      requestOptions({ attachments: undefined }),
    )).rejects.toThrow(/mounted attachment service/)
  })

  it('refuses an image outside a user message or tool result', async () => {
    const assistant: RequestMessage = createAssistantMessage({
      content: [{ type: 'image', attachment: imageRef() }],
      source: { provider: 'longcat', model: 'LongCat-2.5-Preview' },
    })
    await expect(prepareImages([assistant], requestOptions())).rejects.toThrow(/user message or tool result/)
  })

  it('fails with IMAGE_OFFLOAD_REQUIRED naming how many occurrences to offload', async () => {
    const big = imageRef({ attachmentId: 'sha256:big' as ImageAttachmentRef['attachmentId'], bytes: 8 * 1024 * 1024 })
    const small = imageRef({ attachmentId: 'sha256:small' as ImageAttachmentRef['attachmentId'], bytes: 16 })
    const messages = [userWith({ type: 'image', attachment: big }), userWith({ type: 'image', attachment: small })]
    let caught: unknown
    try {
      await prepareImages(messages, requestOptions({ maxRequestImageBytes: 32 }))
    } catch (error) {
      caught = error
    }
    // The oldest occurrence is the one the harness must offload first.
    expect(caught).toMatchObject({ code: 'IMAGE_OFFLOAD_REQUIRED', failure: { offloadImages: 1 } })
    expect((caught as Error).message).toMatch(/must be offloaded/)
  })

  it('honours an image-count bound', async () => {
    const messages = [
      userWith({ type: 'image', attachment: imageRef({ attachmentId: 'sha256:a' as ImageAttachmentRef['attachmentId'], bytes: 8 }) }),
      userWith({ type: 'image', attachment: imageRef({ attachmentId: 'sha256:b' as ImageAttachmentRef['attachmentId'], bytes: 8 }) }),
    ]
    await expect(prepareImages(messages, requestOptions({ maxImagesPerRequest: 1 })))
      .rejects.toMatchObject({ code: 'IMAGE_OFFLOAD_REQUIRED' })
  })
})
