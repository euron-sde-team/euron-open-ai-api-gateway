import { describe, expect, test } from "vitest";
import { failFromResponse, maskSecrets, ProviderError, readSse, type SseEvent } from "../../src/integrations/http";

function streamOf(chunks: (string | Uint8Array)[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(c) {
      for (const ch of chunks) c.enqueue(typeof ch === "string" ? enc.encode(ch) : ch);
      c.close();
    },
  });
}

async function collect(chunks: (string | Uint8Array)[]): Promise<SseEvent[]> {
  const out: SseEvent[] = [];
  for await (const ev of readSse(streamOf(chunks))) out.push(ev);
  return out;
}

describe("readSse", () => {
  test("plain events, with and without an event name", async () => {
    expect(await collect(["data: one\n\nevent: delta\ndata: two\n\n"])).toEqual([
      { event: null, data: "one" },
      { event: "delta", data: "two" },
    ]);
  });

  test("events split at any byte across network chunks", async () => {
    const whole = 'event: message_start\ndata: {"a":1}\n\ndata: [DONE]\n\n';
    for (let i = 1; i < whole.length; i++) {
      expect(await collect([whole.slice(0, i), whole.slice(i)]), `split at ${i}`).toEqual([
        { event: "message_start", data: '{"a":1}' },
        { event: null, data: "[DONE]" },
      ]);
    }
  });

  test("a multi-byte character split across chunks decodes intact", async () => {
    const bytes = new TextEncoder().encode("data: café ☃\n\n");
    expect(await collect([bytes.subarray(0, 10), bytes.subarray(10)])).toEqual([{ event: null, data: "café ☃" }]);
  });

  test("CRLF line endings", async () => {
    expect(await collect(["event: x\r\ndata: a\r\n\r\ndata: b\r\n\r\n"])).toEqual([
      { event: "x", data: "a" },
      { event: null, data: "b" },
    ]);
  });

  test("multi-line data joins with newlines; only one leading space is stripped", async () => {
    expect(await collect(["data: line one\ndata:line two\ndata:   indented\n\n"])).toEqual([{ event: null, data: "line one\nline two\n  indented" }]);
  });

  test("comments and keep-alives are skipped; unknown fields ignored; empty events dropped", async () => {
    expect(await collect([": keep-alive\n\nid: 7\nretry: 2000\ndata: real\n\n\n\n"])).toEqual([{ event: null, data: "real" }]);
  });

  test("a final event without a trailing blank line is still delivered; an unterminated line is not (as the SSE spec says)", async () => {
    expect(await collect(["data: last\n"])).toEqual([{ event: null, data: "last" }]);
    expect(await collect(["data: one\n\ndata: cut"])).toEqual([{ event: null, data: "one" }]);
  });

  test("a null body yields nothing", async () => {
    const out: SseEvent[] = [];
    for await (const ev of readSse(null)) out.push(ev);
    expect(out).toEqual([]);
  });
});

describe("maskSecrets", () => {
  test("masks OpenAI-style, Google and bearer keys, keeps the rest", () => {
    const text = "key sk-proj-abcdefghijklmnop and rk-123456789 and AIzaSyA1234567890abcdefghijk and Bearer eyJhbGciOi.payload.sig here";
    const masked = maskSecrets(text);
    expect(masked).not.toMatch(/abcdefghijklmnop|123456789|AIzaSyA1234567890|eyJhbGciOi/);
    expect(masked).toContain("sk-[masked]");
    expect(masked).toContain("rk-[masked]");
    expect(masked).toContain("AIza[masked]");
    expect(masked).toContain("Bearer [masked]");
    expect(masked.startsWith("key ")).toBe(true);
  });

  test("short look-alikes are not touched", () => {
    expect(maskSecrets("task-1 sk-abc pk")).toBe("task-1 sk-abc pk");
  });
});

describe("failFromResponse", () => {
  const fail = async (status: number, body: unknown) => {
    const res = new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
    return (await failFromResponse("prov", res).catch((e: unknown) => e)) as ProviderError;
  };

  test("401 and 403 are AUTH", async () => {
    expect((await fail(401, { error: { message: "Incorrect API key provided: sk-not-real" } })).failure).toBe("AUTH");
    expect((await fail(403, "forbidden")).failure).toBe("AUTH");
  });

  test("429 is RATE_LIMITED", async () => {
    const e = await fail(429, { error: { message: "Rate limit reached for org-xyz" } });
    expect(e).toBeInstanceOf(ProviderError);
    expect(e.failure).toBe("RATE_LIMITED");
    expect(e.status).toBe(429);
    expect(e.provider).toBe("prov");
  });

  test("400 about the context window is CONTEXT_TOO_LONG, in any provider's wording", async () => {
    expect((await fail(400, { error: { message: "This model's maximum context length is 8192 tokens", code: "context_length_exceeded" } })).failure).toBe("CONTEXT_TOO_LONG");
    expect((await fail(400, { error: { message: "prompt is too long: 210000 tokens > 200000 maximum" } })).failure).toBe("CONTEXT_TOO_LONG");
    expect((await fail(413, "input is too long")).failure).toBe("CONTEXT_TOO_LONG");
  });

  test("400 from a safety system is CONTENT_FILTER", async () => {
    expect((await fail(400, { error: { code: "content_policy_violation", message: "rejected by the safety system" } })).failure).toBe("CONTENT_FILTER");
    expect((await fail(422, "Request blocked by moderation")).failure).toBe("CONTENT_FILTER");
  });

  test("any other 400 is BAD_REQUEST; 500s and others are UNAVAILABLE", async () => {
    expect((await fail(400, { error: { message: "Unknown model: gpt-x" } })).failure).toBe("BAD_REQUEST");
    expect((await fail(500, { error: { message: "stub failure" } })).failure).toBe("UNAVAILABLE");
    expect((await fail(503, "")).failure).toBe("UNAVAILABLE");
  });

  test("the error message carries no provider text, only the provider, failure and status", async () => {
    const e = await fail(401, { error: { message: "Incorrect API key provided: sk-live-secret-abcdef" } });
    expect(e.message).toBe("prov: AUTH (401)");
    expect(e.message).not.toMatch(/Incorrect|sk-live/);
  });
});
