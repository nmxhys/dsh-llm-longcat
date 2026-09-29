/**
 * Deterministic request-image preparation for the LongCat route.
 *
 * Every durable attachment is re-encoded once into the exact bytes the wire
 * carries: the route's pixel budget bounds the request version's dimensions
 * and its byte target bounds the encoded size, so the same history always
 * produces the same request. Occurrences the durable surface marks offloaded
 * become placeholder text naming the image and its read-only path; retained
 * occurrences whose accumulated base64 payload still exceeds the route budget
 * fail with `IMAGE_OFFLOAD_REQUIRED` naming how many more oldest occurrences
 * must be offloaded, instead of dropping bytes on the adapter's own authority.
 *
 * @module dsh-llm-longcat/images
 */
import { IMAGE_OFFLOAD_REQUIRED_CODE, LlmError, offloadedImageText, projectOffloadedImages, requiredImageOffload, } from '@deepseek-ai/dsh-llm';
import { requestImageDimensions } from '@deepseek-ai/dsh-attachment';
/** Default bound on the accumulated base64 payload of one request's images. */
export const DEFAULT_MAX_REQUEST_IMAGE_BYTES = 20 * 1024 * 1024;
/** Default total-pixel budget for one request image; larger sources are downscaled proportionally. */
export const DEFAULT_IMAGE_PIXEL_BUDGET = 2048 * 2048;
/** Default encoded-byte target for one request image; the smallest quality-ladder output is kept when no quality fits. */
export const DEFAULT_IMAGE_MAX_BYTES = 1024 * 1024;
/** Deterministic request target for one source image under its route policy. */
export function imageRequestTarget(model, ref) {
    return {
        ...requestImageDimensions(ref.width, ref.height, model.imageMaxPixels ?? DEFAULT_IMAGE_PIXEL_BUDGET),
        maxBytes: model.imageMaxBytes ?? DEFAULT_IMAGE_MAX_BYTES,
    };
}
function imageBlocks(messages) {
    const blocks = [];
    for (const message of messages) {
        for (const block of message.content) {
            if (block.type === 'image' && block.offloaded !== true)
                blocks.push(block);
        }
    }
    return blocks;
}
/**
 * Prepare one request's images for the wire.
 *
 * Offloaded occurrences are replaced by deterministic placeholder text first —
 * that projection is a durable surface fact every route sends. A route without
 * the image modality, a request that carries no attachment provider, an image
 * outside a user or tool message, or a payload beyond the route budget all
 * fail before any network I/O.
 * @param history - the assembled request history; never mutated.
 * @param options - route image policy, attachment plane, and request bounds.
 * @returns the history to serialize and the request bytes to inline.
 * @throws {LlmError} `UNSUPPORTED_CONTENT` for an image this route cannot send,
 *   `IMAGE_OFFLOAD_REQUIRED` (carrying `offloadImages`) when retained
 *   occurrences still exceed the budget.
 */
export async function prepareImages(history, options) {
    // Only a durable offload decision rewrites history; every other request keeps
    // the exact list it was handed.
    const offloaded = history.some(message => message.content.some(block => block.type === 'image' && block.offloaded === true));
    const messages = offloaded
        ? projectOffloadedImages(history, ref => offloadedImageText(ref, options.access(ref)))
        : history;
    if (!messages.some(message => message.content.some(block => block.type === 'image'))) {
        return { messages, versions: new Map() };
    }
    if (options.model?.inputModalities?.includes('image') !== true) {
        throw new LlmError('LongCat image input requires a catalog model that declares the image modality', 'UNSUPPORTED_CONTENT');
    }
    const attachments = options.attachments;
    if (attachments === undefined) {
        throw new LlmError('LongCat image input requires the mounted attachment service', 'UNSUPPORTED_CONTENT');
    }
    for (const message of messages) {
        if (message.role === 'user' || message.role === 'tool')
            continue;
        if (message.content.some(block => block.type === 'image')) {
            throw new LlmError(`LongCat can carry an image only in a user message or tool result, not in a ${message.role} message`, 'UNSUPPORTED_CONTENT');
        }
    }
    const model = options.model;
    const versions = new Map();
    for (const block of imageBlocks(messages)) {
        const ref = block.attachment;
        if (versions.has(ref.attachmentId))
            continue;
        versions.set(ref.attachmentId, await attachments.readImageRequest(ref, imageRequestTarget(model, ref), options.signal));
    }
    // The bound is checked at the exact bytes the wire carries: base64 of the
    // request version, one expansion per occurrence.
    const offloadImages = requiredImageOffload(messages, {
        representation: 'base64',
        maxBytes: options.maxRequestImageBytes,
        ...options.maxImagesPerRequest === undefined ? {} : { maxImages: options.maxImagesPerRequest },
    }, block => versions.get(block.attachment.attachmentId)?.bytes ?? block.attachment.bytes);
    if (offloadImages > 0) {
        throw new LlmError(`LongCat request images exceed the route budget; ${offloadImages} more oldest occurrence(s) must be offloaded.`, IMAGE_OFFLOAD_REQUIRED_CODE, { offloadImages });
    }
    return { messages, versions };
}
