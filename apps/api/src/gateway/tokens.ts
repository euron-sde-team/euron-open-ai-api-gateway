/**
 * Token estimates for admission (reservations and the TPM limit), never for billing when
 * the provider reports usage. The estimate is deliberately generous: about four
 * characters a token for text, a fixed allowance per image, and a few tokens of overhead
 * per message. When a provider returns no usage at all (a stream cut short, a provider
 * that omits it), the same estimate is billed and the request row is flagged `estimated`.
 */

const IMAGE_TOKENS = 1_200;
const PER_MESSAGE = 4;

export function estimateTextTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

type Part = { type?: string; text?: string; image_url?: unknown; source?: unknown };

function partTokens(part: unknown): number {
  if (typeof part === "string") return estimateTextTokens(part);
  if (!part || typeof part !== "object") return 0;
  const p = part as Part;
  if (p.type === "image_url" || p.type === "image" || p.type === "input_image") return IMAGE_TOKENS;
  if (typeof p.text === "string") return estimateTextTokens(p.text);
  return estimateTextTokens(JSON.stringify(part));
}

function contentTokens(content: unknown): number {
  if (typeof content === "string") return estimateTextTokens(content);
  if (Array.isArray(content)) return content.reduce((n: number, p) => n + partTokens(p), 0);
  if (content && typeof content === "object") return estimateTextTokens(JSON.stringify(content));
  return 0;
}

/** Input tokens of an OpenAI chat request or an Anthropic messages request. */
export function estimateChatInput(body: { messages?: unknown[]; system?: unknown; tools?: unknown[] }): number {
  let total = 0;
  for (const m of body.messages ?? []) {
    const msg = (m ?? {}) as { content?: unknown; tool_calls?: unknown };
    total += PER_MESSAGE + contentTokens(msg.content);
    if (msg.tool_calls) total += estimateTextTokens(JSON.stringify(msg.tool_calls));
  }
  if (body.system) total += contentTokens(body.system);
  if (body.tools?.length) total += estimateTextTokens(JSON.stringify(body.tools));
  return total + 3;
}

/** Input tokens of an embeddings request: a string, an array of strings, or token arrays. */
export function estimateEmbeddingInput(input: unknown): number {
  if (typeof input === "string") return estimateTextTokens(input);
  if (Array.isArray(input)) {
    if (input.every((x) => typeof x === "number")) return input.length;
    return input.reduce((n: number, x) => n + (Array.isArray(x) ? x.length : typeof x === "string" ? estimateTextTokens(x) : 0), 0);
  }
  return 0;
}
