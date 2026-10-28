import { Writable } from "node:stream";
import pino from "pino";
import { describe, expect, test } from "vitest";
import { REDACT } from "../../src/core/logger";

function capture() {
  const lines: Record<string, unknown>[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      lines.push(JSON.parse(String(chunk)));
      cb();
    },
  });
  return { log: pino({ redact: REDACT }, stream), lines };
}

describe("logger redaction", () => {
  test("masks secrets at the top level and up to three levels deep, keeps everything else", () => {
    const { log, lines } = capture();
    log.info(
      {
        password: "top",
        req: { body: { password: "in-body", login: "alice", totp: "123456" }, headers: { authorization: "Bearer x", cookie: "gw_refresh=y", host: "api" } },
        job: { data: { user: { token: "deep", id: "u1" } } },
        err: { config: { data: { refreshToken: "nested" } } },
      },
      "hello",
    );
    const line = lines[0] as any;
    expect(line.password).toBe("[redacted]");
    expect(line.req.body).toEqual({ password: "[redacted]", login: "alice", totp: "[redacted]" });
    expect(line.req.headers).toMatchObject({ authorization: "[redacted]", cookie: "[redacted]", host: "api" });
    expect(line.job.data.user).toEqual({ token: "[redacted]", id: "u1" });
    expect(line.err.config.data.refreshToken).toBe("[redacted]");
    expect(JSON.stringify(line)).not.toMatch(/in-body|deep|nested|Bearer x|gw_refresh=y/);
  });

  test("conversation content and provider keys never reach a log line, at any depth up to three levels", () => {
    const { log, lines } = capture();
    log.info(
      {
        content: "my private question",
        job: { data: { prompt: "draw my house", apiKey: "sk-live-1" } },
        req: { body: { messages: [{ role: "user", content: "secret text" }], input: "moderated text", model: "stub-chat" } },
        err: { config: { headers: { "x-api-key": "k-2", "x-goog-api-key": "k-3" } } },
        provider: { api_key: "k-4" },
      },
      "turn",
    );
    const line = lines[0] as any;
    expect(line.content).toBe("[redacted]");
    expect(line.job.data).toEqual({ prompt: "[redacted]", apiKey: "[redacted]" });
    expect(line.req.body).toEqual({ messages: "[redacted]", input: "[redacted]", model: "stub-chat" });
    expect(line.err.config.headers).toEqual({ "x-api-key": "[redacted]", "x-goog-api-key": "[redacted]" });
    expect(line.provider.api_key).toBe("[redacted]");
    expect(JSON.stringify(line)).not.toMatch(/private question|draw my house|sk-live-1|secret text|moderated text|k-2|k-3|k-4/);
  });
});
