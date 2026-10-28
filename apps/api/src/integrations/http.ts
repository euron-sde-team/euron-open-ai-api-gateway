/**
 * Shared plumbing for provider calls: timeouts that combine with a caller's abort
 * signal, a Server-Sent Events reader, and one classification of provider failures.
 *
 * Provider error bodies are logged (truncated, with anything key-shaped masked) and never
 * returned to a user: the legacy chat passed raw provider text through, which leaked
 * model names, quota details and sometimes request ids of the operator's account.
 */
import { logger } from "../core/logger";

export type ProviderFailure = "AUTH" | "RATE_LIMITED" | "CONTEXT_TOO_LONG" | "BAD_REQUEST" | "CONTENT_FILTER" | "UNAVAILABLE" | "TIMEOUT";

export class ProviderError extends Error {
  constructor(
    readonly failure: ProviderFailure,
    readonly provider: string,
    readonly status: number | null = null,
  ) {
    super(`${provider}: ${failure}${status ? ` (${status})` : ""}`);
    this.name = "ProviderError";
  }
}

/** An AbortSignal that fires on the caller's signal or after `ms`, whichever is first. */
export function withTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal {
  const timeout = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/** Mask anything that looks like a key or bearer token before it reaches a log line. */
export function maskSecrets(text: string): string {
  return text
    .replace(/(sk|rk|pk)-[A-Za-z0-9_-]{8,}/g, "$1-[masked]")
    .replace(/AIza[0-9A-Za-z_-]{20,}/g, "AIza[masked]")
    .replace(/(bearer\s+)[A-Za-z0-9._-]{8,}/gi, "$1[masked]");
}

const CONTEXT_HINTS = /context(_| )length|maximum context|too many tokens|prompt is too long|input is too long|exceeds the (model'?s )?(maximum|context)/i;
const FILTER_HINTS = /content[_ ]?(policy|filter|management)|safety|blocked|moderation/i;

/** Turn a non-2xx provider response into a ProviderError, logging a masked excerpt. */
export async function failFromResponse(provider: string, res: Response): Promise<never> {
  const body = await res.text().catch(() => "");
  const excerpt = maskSecrets(body.slice(0, 600));
  logger.warn({ provider, status: res.status, body: excerpt }, "provider call failed");
  if (res.status === 401 || res.status === 403) throw new ProviderError("AUTH", provider, res.status);
  if (res.status === 429) throw new ProviderError("RATE_LIMITED", provider, res.status);
  if (res.status === 400 || res.status === 413 || res.status === 422) {
    if (CONTEXT_HINTS.test(body)) throw new ProviderError("CONTEXT_TOO_LONG", provider, res.status);
    if (FILTER_HINTS.test(body)) throw new ProviderError("CONTENT_FILTER", provider, res.status);
    throw new ProviderError("BAD_REQUEST", provider, res.status);
  }
  throw new ProviderError("UNAVAILABLE", provider, res.status);
}

/** fetch with provider failure mapping for network errors and timeouts. */
export async function providerFetch(provider: string, url: string, init: RequestInit): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (err) {
    const reason = (init.signal as AbortSignal | null | undefined)?.reason as { name?: string } | undefined;
    if (reason?.name === "TimeoutError" || (err as Error).name === "TimeoutError") throw new ProviderError("TIMEOUT", provider);
    // The caller cancelled (the user pressed stop): not a provider failure.
    if ((err as Error).name === "AbortError") throw err;
    logger.warn({ provider, err: (err as Error).message }, "provider unreachable");
    throw new ProviderError("UNAVAILABLE", provider);
  }
  if (!res.ok) await failFromResponse(provider, res);
  return res;
}

export interface SseEvent {
  event: string | null;
  data: string;
}

/**
 * Parse a text/event-stream body. Handles events split across network chunks, CRLF
 * line endings, multi-line data fields and comments.
 */
export async function* readSse(body: ReadableStream<Uint8Array> | null): AsyncGenerator<SseEvent> {
  if (!body) return;
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let buffer = "";
  let event: string | null = null;
  let data: string[] = [];
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.search(/\r?\n/)) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(buffer[nl] === "\r" ? nl + 2 : nl + 1);
        if (line === "") {
          if (data.length) yield { event, data: data.join("\n") };
          event = null;
          data = [];
        } else if (line.startsWith(":")) {
          // comment / keep-alive
        } else {
          const colon = line.indexOf(":");
          const field = colon < 0 ? line : line.slice(0, colon);
          const val = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
          if (field === "data") data.push(val);
          else if (field === "event") event = val;
        }
      }
    }
    if (data.length) yield { event, data: data.join("\n") };
  } finally {
    reader.releaseLock();
  }
}
