/* global fetch, TextDecoder, FormData, Blob, Buffer, URLSearchParams */
import { createHmac } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { failureFor, parseMultipart, promptTokens, replyTo, startStubs, tokens } from "../server.mjs";

describe("the deterministic model", () => {
  it("counts tokens as characters / 4, plus 4 per message", () => {
    expect(tokens("abcd")).toBe(1);
    expect(tokens("abcde")).toBe(2);
    expect(promptTokens([{ role: "user", content: "abcdefgh" }])).toBe(6);
    expect(promptTokens([{ role: "user", content: [{ type: "text", text: "abcd" }] }], "abcd")).toBe(6);
    expect(replyTo("x".repeat(200))).toHaveLength("Stub reply to: ".length + 80);
  });

  it("reads failure switches from the model name", () => {
    expect(failureFor("fail-503")).toBe(503);
    expect(failureFor("stub-chat")).toBeNull();
  });

  it("parses a multipart body", () => {
    const body = Buffer.from('--b\r\nContent-Disposition: form-data; name="model"\r\n\r\nstub-whisper\r\n--b\r\nContent-Disposition: form-data; name="file"; filename="a.mp3"\r\nContent-Type: audio/mpeg\r\n\r\n12345\r\n--b--\r\n', "latin1");
    expect(parseMultipart(body, "multipart/form-data; boundary=b")).toEqual({ fields: { model: "stub-whisper" }, fileBytes: 5 });
  });
});

describe("the server", () => {
  let stubs;
  beforeAll(async () => {
    stubs = await startStubs({ stripeWebhookSecret: "whsec_t", razorpayKeySecret: "rk_t", razorpayWebhookSecret: "rw_t" });
  });
  afterAll(async () => stubs.close());
  beforeEach(async () => void (await fetch(`${stubs.url}/__/reset`, { method: "POST" })));

  const auth = { Authorization: "Bearer sk-stub", "Content-Type": "application/json" };

  it("answers chat with exact usage, and streams with usage when asked", async () => {
    const messages = [{ role: "user", content: "hello there" }];
    const res = await fetch(`${stubs.url}/v1/chat/completions`, { method: "POST", headers: auth, body: JSON.stringify({ model: "stub-chat", messages }) });
    const body = await res.json();
    expect(body.choices[0].message.content).toBe("Stub reply to: hello there");
    expect(body.usage).toEqual({ prompt_tokens: 7, completion_tokens: tokens("Stub reply to: hello there"), total_tokens: 7 + tokens("Stub reply to: hello there") });

    const streamed = await fetch(`${stubs.url}/v1/chat/completions`, { method: "POST", headers: auth, body: JSON.stringify({ model: "stub-chat", messages, stream: true, stream_options: { include_usage: true } }) });
    const text = await streamed.text();
    expect(text).toContain('"usage":{"prompt_tokens":7');
    expect(text.trim().endsWith("data: [DONE]")).toBe(true);
  });

  it("refuses calls without a key and fails on demand", async () => {
    expect((await fetch(`${stubs.url}/v1/models`)).status).toBe(401);
    const res = await fetch(`${stubs.url}/v1/chat/completions`, { method: "POST", headers: auth, body: JSON.stringify({ model: "fail-503", messages: [{ role: "user", content: "x" }] }) });
    expect(res.status).toBe(503);
  });

  it("speaks the Anthropic Messages format, streaming and not", async () => {
    const headers = { "x-api-key": "sk-ant-stub", "anthropic-version": "2023-06-01", "Content-Type": "application/json" };
    const res = await fetch(`${stubs.url}/anthropic/v1/messages`, { method: "POST", headers, body: JSON.stringify({ model: "stub-claude", max_tokens: 50, messages: [{ role: "user", content: "hi" }] }) });
    const body = await res.json();
    expect(body.content[0].text).toBe("Stub reply to: hi");
    expect(body.usage.input_tokens).toBe(5);
    const s = await fetch(`${stubs.url}/anthropic/v1/messages`, { method: "POST", headers, body: JSON.stringify({ model: "stub-claude", max_tokens: 50, stream: true, messages: [{ role: "user", content: "hi" }] }) });
    const text = await s.text();
    expect(text).toContain("event: message_start");
    expect(text).toContain("event: message_stop");
  });

  it("transcribes with a duration from the file size", async () => {
    const form = new FormData();
    form.append("model", "stub-whisper");
    form.append("response_format", "verbose_json");
    form.append("file", new Blob([new Uint8Array(100_000)], { type: "audio/mpeg" }), "a.mp3");
    const res = await fetch(`${stubs.url}/v1/audio/transcriptions`, { method: "POST", headers: { Authorization: "Bearer x" }, body: form });
    expect((await res.json()).duration).toBe(60);
  });

  it("settles a Stripe checkout with a signed event", async () => {
    const form = new URLSearchParams({ "line_items[0][price_data][unit_amount]": "1000", "line_items[0][price_data][currency]": "usd", "metadata[topup_id]": "t1" });
    const session = await (await fetch(`${stubs.url}/stripe/v1/checkout/sessions`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: form })).json();
    expect(session.url).toContain(session.id);
    const paid = await (await fetch(`${stubs.url}/__/stripe/pay`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sessionId: session.id }) })).json();
    const [t, v1] = paid.signature.split(",").map((x) => x.split("=")[1]);
    expect(v1).toBe(createHmac("sha256", "whsec_t").update(`${t}.${paid.body}`).digest("hex"));
    expect(JSON.parse(paid.body).data.object.amount_total).toBe(1000);
  });

  it("serves a hosted checkout page that delivers the signed webhook and redirects", async () => {
    const received = [];
    const http = await import("node:http");
    const api = http.createServer((req, res) => {
      let data = "";
      req.on("data", (c) => (data += c));
      req.on("end", () => {
        received.push({ path: req.url, signature: req.headers["stripe-signature"], body: data });
        res.end("{}");
      });
    });
    await new Promise((r) => api.listen(0, "127.0.0.1", r));
    stubs.config.apiUrl = `http://127.0.0.1:${api.address().port}`;
    const form = new URLSearchParams({ "line_items[0][price_data][unit_amount]": "2500", "line_items[0][price_data][currency]": "usd", success_url: "http://localhost:3560/billing?topup=t9", cancel_url: "http://localhost:3560/billing?cancelled=1" });
    const session = await (await fetch(`${stubs.url}/stripe/v1/checkout/sessions`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: form })).json();
    const page = await fetch(session.url);
    expect(await page.text()).toContain("Pay $25.00");
    const paid = await fetch(`${session.url}/pay`, { method: "POST", redirect: "manual" });
    expect(paid.status).toBe(303);
    expect(paid.headers.get("location")).toBe("http://localhost:3560/billing?topup=t9");
    expect(received).toHaveLength(1);
    expect(received[0].path).toBe("/api/webhooks/stripe");
    const [t, v1] = received[0].signature.split(",").map((x) => x.split("=")[1]);
    expect(v1).toBe(createHmac("sha256", "whsec_t").update(`${t}.${received[0].body}`).digest("hex"));
    const cancel = await fetch(`${session.url}/cancel`, { method: "POST", redirect: "manual" });
    expect(cancel.headers.get("location")).toBe("http://localhost:3560/billing?cancelled=1");
    await new Promise((r) => api.close(r));
  });

  it("settles a Razorpay order with checkout.js and webhook signatures", async () => {
    const order = await (await fetch(`${stubs.url}/razorpay/v1/orders`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ amount: 50000, currency: "INR" }) })).json();
    const paid = await (await fetch(`${stubs.url}/__/razorpay/pay`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ orderId: order.id }) })).json();
    expect(paid.signature).toBe(createHmac("sha256", "rk_t").update(`${order.id}|${paid.paymentId}`).digest("hex"));
    expect(paid.webhook.signature).toBe(createHmac("sha256", "rw_t").update(paid.webhook.body).digest("hex"));
    const payment = await (await fetch(`${stubs.url}/razorpay/v1/payments/${paid.paymentId}`)).json();
    expect(payment).toMatchObject({ status: "captured", amount: 50000, order_id: order.id });
  });

  it("records requests without secrets", async () => {
    await fetch(`${stubs.url}/v1/embeddings`, { method: "POST", headers: auth, body: JSON.stringify({ model: "stub-embed", input: ["a", "b"] }) });
    const [last] = await (await fetch(`${stubs.url}/__/requests`)).json();
    expect(last.headers.authorization).toBe("present");
    expect(JSON.stringify(last)).not.toContain("sk-stub");
    void TextDecoder;
  });
});
