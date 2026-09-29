/**
 * Serialize harness messages into LongCat chat completions. User text is
 * joined; images become a text handle plus an inline `data:` image part;
 * assistant text becomes `content`, tool calls become `tool_calls`, and tool
 * results become their own `role: 'tool'` messages. Assistant reasoning is
 * replayed as `reasoning_content` only on tool-call turns.
 *
 * In-history tool changes (`developer` messages) never reach this adapter: the
 * runtime projects them away for a route that declares no `toolUpdate` mode, so
 * seeing one here is a contract violation and fails loud. The same goes for a
 * `tool-addition` / `tool-removal` block anywhere else.
 *
 * Images are rejected whenever the route cannot send them: an image arriving
 * without prepared request bytes, or without a catalog model declaring the
 * `image` modality, is a misdispatch rather than something to flatten silently.
 *
 * @module dsh-llm-longcat/serialize
 */
import { LlmError, requestImageHandleText } from '@deepseek-ai/dsh-llm';
/** Validate the requested effort against the binary switch LongCat actually exposes. */
function longCatEffort(effort) {
    if (effort === 'off' || effort === 'high')
        return effort;
    throw new LlmError(`LongCat does not support reasoning effort "${effort}"; its thinking switch is binary (off | high)`, 'UNSUPPORTED_REASONING_EFFORT');
}
/**
 * Resolve the one `thinking` object a request carries.
 *
 * Every path returns an explicit `enabled` or `disabled` rather than omitting
 * the field: omission would hand the decision to LongCat's server-side
 * default, which is not what selecting Off should mean.
 * @param options - the harness request.
 * @param defaults - adapter-level thinking defaults.
 * @returns the resolved wire toggle.
 */
function resolveThinking(options, defaults) {
    // A title's bounded output must be visible text, never spent on reasoning.
    if (options.purpose === 'session-title')
        return 'disabled';
    const requested = options.reasoningEffort === undefined
        ? undefined
        : longCatEffort(options.reasoningEffort);
    // A deployment that locks thinking off refuses a per-request attempt to
    // turn it back on, before any network I/O.
    if (defaults.thinking === 'disabled') {
        if (requested !== undefined && requested !== 'off') {
            throw new LlmError(`LongCat deployment has thinking disabled and cannot serve reasoning effort "${requested}"`, 'UNSUPPORTED_REASONING_EFFORT');
        }
        return 'disabled';
    }
    if (requested !== undefined)
        return requested === 'off' ? 'disabled' : 'enabled';
    if (defaults.reasoningEffort !== undefined) {
        return defaults.reasoningEffort === 'off' ? 'disabled' : 'enabled';
    }
    return defaults.thinking ?? 'enabled';
}
/** Join the text blocks of a message. */
function flattenText(blocks) {
    return blocks
        .filter(block => block.type === 'text')
        .map(block => block.text)
        .join('');
}
/**
 * Convert one message's blocks into wire content: a bare string when the turn
 * is text-only, otherwise the content-part array LongCat accepts for images.
 *
 * Each image contributes its deterministic text handle first — the model-facing
 * name, dimensions, and read-only copy path — then the inline bytes.
 * @param blocks - the message's model-facing blocks.
 * @param images - prepared request versions, or `undefined` on a text-only path.
 * @returns the wire content for this message.
 * @throws {LlmError} `UNSUPPORTED_CONTENT` for an image the route cannot send or
 *   a block that is not message vocabulary; `INVALID_REQUEST` when an image
 *   arrives without its prepared request bytes.
 */
function wireContent(blocks, images) {
    const parts = [];
    for (const block of blocks) {
        switch (block.type) {
            case 'text':
                if (block.text.length > 0)
                    parts.push({ type: 'text', text: block.text });
                break;
            case 'image': {
                if (images === undefined) {
                    throw new LlmError('LongCat received image content without a prepared request image;'
                        + ' a text-only route substitutes placeholder text before dispatch', 'UNSUPPORTED_CONTENT');
                }
                const version = images.versions.get(block.attachment.attachmentId);
                if (version === undefined) {
                    throw new LlmError('LongCat request image is missing its prepared bytes', 'INVALID_REQUEST');
                }
                parts.push({
                    type: 'text',
                    text: requestImageHandleText(block.attachment, version, images.access(block.attachment)),
                });
                parts.push({
                    type: 'image_url',
                    image_url: { url: `data:${version.mediaType};base64,${Buffer.from(version.data).toString('base64')}` },
                });
                break;
            }
            default:
                // tool-addition / tool-removal / file / tool-call / reasoning never
                // belong in a user, tool, or system content slot.
                throw new LlmError(`LongCat cannot serialize a ${block.type} block as message content`, 'UNSUPPORTED_CONTENT');
        }
    }
    return parts.every(part => part.type === 'text') ? parts.map(part => part.text).join('') : parts;
}
/** Serialize one assistant message (text + reasoning + tool calls). */
function serializeAssistant(message) {
    const text = flattenText(message.content);
    const reasoning = message.content
        .filter(block => block.type === 'reasoning')
        .map(block => block.text)
        .join('');
    const toolCalls = message.content
        .filter(block => block.type === 'tool-call')
        .map(block => ({
        id: block.id,
        type: 'function',
        function: { name: block.name, arguments: block.arguments },
    }));
    return {
        role: 'assistant',
        // Always a string, never null — a reasoning-only turn is durable history,
        // and a null there would make every later turn replay a rejectable body.
        content: text,
        // Passback is required on tool-call turns and ignored on plain ones, so
        // it is dropped there to avoid paying for those tokens again.
        ...toolCalls.length > 0 && reasoning.length > 0 ? { reasoning_content: reasoning } : {},
        ...toolCalls.length > 0 ? { tool_calls: toolCalls } : {},
    };
}
/**
 * Serialize the conversation.
 *
 * `system`, `user`, `assistant`, and `tool` messages map one-to-one onto the
 * wire; a tool result is a first-class message now, so it needs no expansion.
 * Empty tool output still gets a body, because the wire requires one.
 * @param messages - the harness request history, in order.
 * @param images - prepared request images; omission is the text-only path.
 * @returns the wire messages, order preserved.
 * @throws {LlmError} `UNSUPPORTED_CONTENT` for a `developer` message: the
 *   runtime strips in-history tool changes for a route without a `toolUpdate`
 *   mode, so one arriving here means the projection contract was broken.
 */
export function serializeMessages(messages, images) {
    const wire = [];
    for (const message of messages) {
        switch (message.role) {
            case 'developer':
                throw new LlmError('LongCat does not support in-history tool changes; the runtime projects developer messages away for this route', 'UNSUPPORTED_CONTENT');
            case 'system':
            case 'assistant': {
                // flattenText drops everything but text, so an image in a role the wire
                // cannot carry must fail here rather than disappear.
                if (message.content.some(block => block.type === 'image')) {
                    throw new LlmError(`LongCat can carry an image only in a user message or tool result, not in a ${message.role} message`, 'UNSUPPORTED_CONTENT');
                }
                wire.push(message.role === 'system'
                    ? { role: 'system', content: flattenText(message.content) }
                    : serializeAssistant(message));
                break;
            }
            case 'tool':
                wire.push({
                    role: 'tool',
                    tool_call_id: message.toolCallId,
                    content: wireContent(message.content, images) || '(no output)',
                });
                break;
            case 'user':
                wire.push({ role: 'user', content: wireContent(message.content, images) });
                break;
            /* v8 ignore next 2 -- MessageRoleMap is closed; this guards a widened future role */
            default:
                break;
        }
    }
    return wire;
}
/**
 * Build the full wire request. Always streaming with usage reporting on;
 * optional fields are omitted rather than sent as null so provider defaults
 * apply.
 * @param options - the harness request (model, history, system, tools, sampling).
 * @param defaults - adapter-level thinking defaults.
 * @param images - prepared request images; omission is the text-only path.
 * @returns the chat-completions request body.
 */
export function serializeRequest(options, defaults = {}, images) {
    const messages = [];
    // `system` serves one-shot callers; a loop-built request carries the prompt
    // as a leading system message instead, which the history loop maps.
    if (options.system !== undefined) {
        messages.push({ role: 'system', content: options.system });
    }
    messages.push(...serializeMessages(options.messages, images));
    const tools = options.tools?.map((tool) => ({
        type: 'function',
        function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
        },
    }));
    return {
        model: options.model,
        messages,
        stream: true,
        stream_options: { include_usage: true },
        thinking: { type: resolveThinking(options, defaults) },
        ...tools !== undefined && tools.length > 0 ? { tools } : {},
        ...options.temperature !== undefined ? { temperature: options.temperature } : {},
        ...options.maxTokens === undefined ? {} : { max_tokens: options.maxTokens },
    };
}
