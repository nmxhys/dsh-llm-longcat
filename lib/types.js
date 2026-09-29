/**
 * LongCat chat-completions wire format (OpenAI-compatible). Types only.
 *
 * Source of truth: the official API docs at
 * https://longcat.chat/platform/docs/zh/api/chat and the model-detail
 * endpoint `GET /openai/v1/models/{model}`, which is the only documented
 * place that reports `supported_parameters` and `architecture`. Verified
 * against live streams from `api.longcat.chat` (2026-09).
 *
 * The docs describe `content` as a plain-text string, but `LongCat-2.5-Preview`
 * reports `modality: text+image->text` and its endpoint accepts the standard
 * OpenAI content-part array carrying `image_url` data URLs — verified live by
 * reading rendered digits out of generated images.
 *
 * @module dsh-llm-longcat/types
 */
export {};
