/* global process, Buffer, URL, URLSearchParams, console, setTimeout, fetch, AbortSignal */
/**
 * Deterministic stand-ins for every third party the gateway talks to, in one
 * dependency-free Node process (node:http, node:crypto). Development, CI and the
 * integration tests run the gateway's real upstream calls and payment clients against
 * it: only the base URL differs from production.
 *
 *   OpenAI-compatible  GET  /v1/models
 *                      POST /v1/chat/completions (streaming and not, usage on request)
 *                      POST /v1/embeddings, /v1/images/generations, /v1/audio/speech,
 *                           /v1/audio/transcriptions (multipart)
 *   Anthropic          GET  /anthropic/v1/models, POST /anthropic/v1/messages (streaming and not)
 *   Stripe             POST /stripe/v1/checkout/sessions; GET /stripe/checkout/<id> is a
 *                      hosted-checkout stand-in: Pay settles the session, sends the signed
 *                      checkout.session.completed webhook to STUBS_API_URL and redirects
 *                      to the session's success_url (Cancel goes to cancel_url)
 *   Razorpay           POST /razorpay/v1/orders, GET /razorpay/v1/payments/<id>,
 *                      POST /razorpay/v1/payments/<id>/capture
 *
 * Usage is deterministic so tests can assert exact prices: prompt tokens are the
 * characters of every message / 4 rounded up, plus 4 per message; the reply is
 * "Stub reply to: <the last user text, first 80 characters>" and its tokens are its
 * characters / 4 rounded up.
 *
 * Failure switches, by upstream model name: "fail-500" answers 500, "fail-503" 503,
 * "fail-429" 429, "fail-401" 401, "slow-<ms>" waits before answering. By content:
 * "STUB_CUT" anywhere in the last user message ends a stream half way, without usage.
 *
 * Test helpers (never in production): GET /__/requests (newest first), POST /__/reset,
 * POST /__/stripe/pay { sessionId } and POST /__/razorpay/pay { orderId } settle a
 * checkout and return what the gateway's webhook or checkout.js would receive, signed
 * with STRIPE_WEBHOOK_SECRET / RAZORPAY_KEY_SECRET / RAZORPAY_WEBHOOK_SECRET.
 *
 *   PORT=5149 node server.mjs
 */
import { createHmac, randomBytes } from "node:crypto";
import http from "node:http";
import { pathToFileURL } from "node:url";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── HTTP helpers ──────────────────────────────────────────────────────────────

function readBody(req, limit = 30_000_000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("body too large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

function sse(res) {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  return {
    data: (obj) => res.write(`data: ${typeof obj === "string" ? obj : JSON.stringify(obj)}\n\n`),
    event: (name, obj) => res.write(`event: ${name}\ndata: ${JSON.stringify(obj)}\n\n`),
    end: () => res.end(),
  };
}

const id = (prefix) => `${prefix}${randomBytes(12).toString("hex")}`;

// ─── The deterministic model ───────────────────────────────────────────────────

export const tokens = (text) => Math.ceil(String(text ?? "").length / 4);

function contentText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((p) => (typeof p === "string" ? p : (p?.text ?? ""))).join(" ");
  return "";
}

/** Prompt tokens of an OpenAI or Anthropic message list (plus an Anthropic system prompt). */
export function promptTokens(messages, system) {
  let n = 0;
  for (const m of messages ?? []) n += 4 + tokens(contentText(m.content));
  if (system) n += tokens(contentText(system));
  return n;
}

export function lastUserText(messages) {
  const users = (messages ?? []).filter((m) => m.role === "user");
  return contentText(users[users.length - 1]?.content);
}

export const replyTo = (text) => `Stub reply to: ${String(text).slice(0, 80)}`;

/** Split a reply into stream deltas of about 12 characters. */
function pieces(text) {
  const out = [];
  for (let i = 0; i < text.length; i += 12) out.push(text.slice(i, i + 12));
  return out;
}

/** The failure switch for an upstream model name, or null. */
export function failureFor(model) {
  const m = /^fail-(\d{3})$/.exec(String(model ?? ""));
  return m ? Number(m[1]) : null;
}

async function maybeSlow(model) {
  const m = /^slow-(\d+)$/.exec(String(model ?? ""));
  if (m) await sleep(Math.min(Number(m[1]), 60_000));
}

// ─── OpenAI-compatible ─────────────────────────────────────────────────────────

async function chat(res, body) {
  const fail = failureFor(body.model);
  if (fail) return send(res, fail, { error: { message: `stub ${fail}`, type: "server_error" } });
  await maybeSlow(body.model);
  const prompt = promptTokens(body.messages);
  const user = lastUserText(body.messages);
  const wantsTool = Array.isArray(body.tools) && body.tools.length && /STUB_TOOL/.test(user);
  const reply = wantsTool ? "" : replyTo(user);
  const completion = wantsTool ? 12 : tokens(reply);
  const usage = { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion };
  const created = Math.floor(Date.now() / 1000);
  const chatId = id("chatcmpl-stub");
  const toolCalls = wantsTool ? [{ id: id("call_"), type: "function", function: { name: body.tools[0].function?.name ?? "tool", arguments: '{"q":"stub"}' } }] : undefined;
  if (!body.stream) {
    return send(res, 200, {
      id: chatId,
      object: "chat.completion",
      created,
      model: body.model,
      choices: [{ index: 0, message: { role: "assistant", content: wantsTool ? null : reply, ...(toolCalls ? { tool_calls: toolCalls } : {}) }, finish_reason: wantsTool ? "tool_calls" : "stop" }],
      usage,
    });
  }
  const s = sse(res);
  const chunk = (delta, finish = null) => ({ id: chatId, object: "chat.completion.chunk", created, model: body.model, choices: [{ index: 0, delta, finish_reason: finish }] });
  s.data(chunk({ role: "assistant", content: "" }));
  const parts = pieces(reply);
  const cut = /STUB_CUT/.test(user);
  for (const [i, p] of parts.entries()) {
    if (cut && i >= Math.floor(parts.length / 2)) return res.destroy();
    s.data(chunk({ content: p }));
    await sleep(2);
  }
  if (toolCalls) s.data(chunk({ tool_calls: [{ index: 0, ...toolCalls[0] }] }));
  s.data(chunk({}, wantsTool ? "tool_calls" : "stop"));
  if (body.stream_options?.include_usage) s.data({ id: chatId, object: "chat.completion.chunk", created, model: body.model, choices: [], usage });
  s.data("[DONE]");
  s.end();
}

function embeddings(res, body) {
  const fail = failureFor(body.model);
  if (fail) return send(res, fail, { error: { message: `stub ${fail}` } });
  const inputs = Array.isArray(body.input) ? body.input : [body.input];
  const n = inputs.reduce((sum, x) => sum + (typeof x === "string" ? tokens(x) : Array.isArray(x) ? x.length : 1), 0);
  const vector = (seed) => Array.from({ length: 8 }, (_, i) => Number(Math.sin(seed + i).toFixed(6)));
  return send(res, 200, { object: "list", model: body.model, data: inputs.map((x, i) => ({ object: "embedding", index: i, embedding: vector(String(x).length + i) })), usage: { prompt_tokens: n, total_tokens: n } });
}

// A 1x1 transparent PNG.
const PIXEL = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

function images(res, body) {
  const fail = failureFor(body.model);
  if (fail) return send(res, fail, { error: { message: `stub ${fail}` } });
  const n = Math.max(1, Math.min(10, Number(body.n ?? 1)));
  return send(res, 200, { created: Math.floor(Date.now() / 1000), data: Array.from({ length: n }, () => ({ b64_json: PIXEL, revised_prompt: String(body.prompt ?? "").slice(0, 200) })) });
}

function speech(res, body) {
  const fail = failureFor(body.model);
  if (fail) return send(res, fail, { error: { message: `stub ${fail}` } });
  // Not real audio: 16 bytes per input character, enough to check sizes and content types.
  res.writeHead(200, { "Content-Type": "audio/mpeg" });
  res.end(Buffer.alloc(String(body.input ?? "").length * 16, 0x55));
}

/** The text fields of a multipart body and the size of its `file` part. Good enough for a stub. */
export function parseMultipart(buf, contentType) {
  const boundary = /boundary=(?:"([^"]+)"|([^;]+))/.exec(contentType ?? "");
  const fields = {};
  let fileBytes = 0;
  if (!boundary) return { fields, fileBytes };
  const sep = `--${boundary[1] ?? boundary[2]}`;
  for (const part of buf.toString("latin1").split(sep)) {
    const head = part.indexOf("\r\n\r\n");
    if (head < 0) continue;
    const headers = part.slice(0, head);
    const value = part.slice(head + 4).replace(/\r\n$/, "");
    const name = /name="([^"]+)"/.exec(headers)?.[1];
    if (!name) continue;
    if (/filename=/.test(headers)) fileBytes = Buffer.byteLength(value, "latin1");
    else fields[name] = value;
  }
  return { fields, fileBytes };
}

function transcription(res, raw, contentType) {
  const { fields, fileBytes } = parseMultipart(raw, contentType);
  const fail = failureFor(fields.model);
  if (fail) return send(res, fail, { error: { message: `stub ${fail}` } });
  // One minute per 100 KB of audio, so a test file of known size has a known duration.
  const duration = Math.round((fileBytes / 100_000) * 60 * 100) / 100;
  const text = `Stub transcript of ${fileBytes} bytes.`;
  if (fields.response_format === "text") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    return res.end(text);
  }
  return send(res, 200, { text, language: fields.language || "en", duration, segments: [] });
}

// ─── Anthropic ─────────────────────────────────────────────────────────────────

async function anthropicMessages(res, body) {
  const fail = failureFor(body.model);
  if (fail) return send(res, fail, { type: "error", error: { type: "api_error", message: `stub ${fail}` } });
  await maybeSlow(body.model);
  const input = promptTokens(body.messages, body.system);
  const user = lastUserText(body.messages);
  const reply = replyTo(user);
  const output = tokens(reply);
  const msgId = id("msg_stub");
  if (!body.stream) {
    return send(res, 200, { id: msgId, type: "message", role: "assistant", model: body.model, content: [{ type: "text", text: reply }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: input, output_tokens: output } });
  }
  const s = sse(res);
  s.event("message_start", { type: "message_start", message: { id: msgId, type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, usage: { input_tokens: input, output_tokens: 1 } } });
  s.event("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
  const parts = pieces(reply);
  const cut = /STUB_CUT/.test(user);
  for (const [i, p] of parts.entries()) {
    if (cut && i >= Math.floor(parts.length / 2)) return res.destroy();
    s.event("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: p } });
    await sleep(2);
  }
  s.event("content_block_stop", { type: "content_block_stop", index: 0 });
  s.event("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: output } });
  s.event("message_stop", { type: "message_stop" });
  s.end();
}

// ─── Payments ──────────────────────────────────────────────────────────────────

const hmac = (secret, payload) => createHmac("sha256", secret).update(payload).digest("hex");

/** Mark a Checkout Session paid and build the signed checkout.session.completed event. */
function payStripeSession(session, secret) {
  Object.assign(session, { payment_status: "paid", status: "complete", payment_intent: id("pi_stub") });
  const event = JSON.stringify({ id: id("evt_stub"), type: "checkout.session.completed", data: { object: session } });
  const t = Math.floor(Date.now() / 1000);
  return { body: event, signature: `t=${t},v1=${hmac(secret, `${t}.${event}`)}` };
}

const esc = (v) => String(v).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

function checkoutPage(session) {
  const amount = new Intl.NumberFormat("en-US", { style: "currency", currency: session.currency.toUpperCase() }).format(session.amount_total / 100);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Test checkout</title>
<style>body{font:15px system-ui,sans-serif;background:#f6f7f9;color:#111827;display:grid;place-items:center;min-height:100vh;margin:0}main{background:#fff;border:1px solid #e5e7eb;border-radius:14px;padding:32px;width:340px}h1{font-size:18px;margin:0 0 4px}p{color:#4b5563;margin:0 0 20px}strong{font-size:28px;display:block;margin:8px 0 24px}button{width:100%;padding:11px;border-radius:8px;border:0;font:600 15px system-ui;cursor:pointer}.pay{background:#111827;color:#fff;margin-bottom:8px}.cancel{background:#f3f4f6;color:#111827}</style></head>
<body><main><h1>Test checkout</h1><p>A local stand-in for Stripe Checkout. Nothing is charged.</p><strong>${esc(amount)}</strong>
<form method="post" action="/stripe/checkout/${esc(session.id)}/pay"><button class="pay" type="submit" data-testid="stub-pay">Pay ${esc(amount)}</button></form>
<form method="post" action="/stripe/checkout/${esc(session.id)}/cancel"><button class="cancel" type="submit">Cancel</button></form></main></body></html>`;
}

// ─── The server ────────────────────────────────────────────────────────────────

export function createStubs(options = {}) {
  const config = {
    publicUrl: options.publicUrl ?? process.env.STUBS_PUBLIC_URL ?? `http://localhost:${options.port ?? process.env.PORT ?? 5149}`,
    webUrl: options.webUrl ?? process.env.APP_WEB_URL ?? "http://localhost:3560",
    stripeWebhookSecret: options.stripeWebhookSecret ?? process.env.STRIPE_WEBHOOK_SECRET ?? "whsec_stub",
    razorpayKeySecret: options.razorpayKeySecret ?? process.env.RAZORPAY_KEY_SECRET ?? "rzp_secret_stub",
    razorpayWebhookSecret: options.razorpayWebhookSecret ?? process.env.RAZORPAY_WEBHOOK_SECRET ?? "rzp_whsec_stub",
    apiUrl: (options.apiUrl ?? process.env.STUBS_API_URL ?? "http://localhost:5056").replace(/\/$/, ""),
  };
  const state = { requests: [], sessions: new Map(), orders: new Map(), payments: new Map() };

  async function handler(req, res) {
    try {
      const url = new URL(req.url ?? "/", "http://stubs");
      const p = url.pathname;
      const raw = req.method === "GET" ? Buffer.alloc(0) : await readBody(req);
      const type = String(req.headers["content-type"] ?? "");
      let body = {};
      if (type.includes("application/json") && raw.length) body = JSON.parse(raw.toString("utf8"));
      else if (type.includes("application/x-www-form-urlencoded")) body = Object.fromEntries(new URLSearchParams(raw.toString("utf8")));
      if (!p.startsWith("/__/")) {
        state.requests.unshift({ method: req.method, path: p, headers: { authorization: req.headers.authorization ? "present" : null, "x-api-key": req.headers["x-api-key"] ? "present" : null, "anthropic-version": req.headers["anthropic-version"] ?? null }, body: type.includes("multipart") ? { multipart: true, bytes: raw.length } : body, at: new Date().toISOString() });
        state.requests.length = Math.min(state.requests.length, 500);
      }

      if (p === "/health") return send(res, 200, { ok: true });
      if (p === "/__/requests") return send(res, 200, state.requests);
      if (p === "/__/reset" && req.method === "POST") {
        state.requests.length = 0;
        return send(res, 200, { ok: true });
      }

      // OpenAI-compatible. A missing bearer is a 401, as upstream.
      if (p.startsWith("/v1/")) {
        if (!String(req.headers.authorization ?? "").startsWith("Bearer ")) return send(res, 401, { error: { message: "missing key" } });
        if (p === "/v1/models" && req.method === "GET") return send(res, 200, { object: "list", data: [{ id: "stub-chat", object: "model" }] });
        if (p === "/v1/chat/completions" && req.method === "POST") return chat(res, body);
        if (p === "/v1/embeddings" && req.method === "POST") return embeddings(res, body);
        if (p === "/v1/images/generations" && req.method === "POST") return images(res, body);
        if (p === "/v1/audio/speech" && req.method === "POST") return speech(res, body);
        if (p === "/v1/audio/transcriptions" && req.method === "POST") return transcription(res, raw, type);
      }

      if (p.startsWith("/anthropic/v1/")) {
        if (!req.headers["x-api-key"]) return send(res, 401, { type: "error", error: { type: "authentication_error", message: "missing x-api-key" } });
        if (!req.headers["anthropic-version"]) return send(res, 400, { type: "error", error: { type: "invalid_request_error", message: "anthropic-version header is required" } });
        if (p === "/anthropic/v1/models" && req.method === "GET") return send(res, 200, { data: [{ id: "stub-claude", type: "model" }] });
        if (p === "/anthropic/v1/messages" && req.method === "POST") return anthropicMessages(res, body);
      }

      // Stripe: Checkout Sessions. The form body arrives flattened ("line_items[0][price_data][unit_amount]").
      if (p === "/stripe/v1/checkout/sessions" && req.method === "POST") {
        const session = {
          id: id("cs_test_stub"),
          object: "checkout.session",
          amount_total: Number(body["line_items[0][price_data][unit_amount]"] ?? 0),
          currency: String(body["line_items[0][price_data][currency]"] ?? "usd"),
          client_reference_id: body.client_reference_id ?? null,
          metadata: { topup_id: body["metadata[topup_id]"] ?? null },
          payment_status: "unpaid",
          status: "open",
          success_url: body.success_url ?? null,
          cancel_url: body.cancel_url ?? null,
        };
        session.url = `${config.publicUrl}/stripe/checkout/${session.id}`;
        state.sessions.set(session.id, session);
        return send(res, 200, session);
      }

      // The hosted Checkout page stand-in.
      const page = /^\/stripe\/checkout\/([\w]+)(\/pay|\/cancel)?$/.exec(p);
      if (page) {
        const session = state.sessions.get(page[1]);
        if (!session) return send(res, 404, { error: { message: "no such checkout session" } });
        if (!page[2] && req.method === "GET") {
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          return res.end(checkoutPage(session));
        }
        if (page[2] === "/cancel" && req.method === "POST") {
          res.writeHead(303, { Location: session.cancel_url ?? config.webUrl });
          return res.end();
        }
        if (page[2] === "/pay" && req.method === "POST") {
          if (session.status !== "complete") {
            const event = payStripeSession(session, config.stripeWebhookSecret);
            try {
              await fetch(`${config.apiUrl}/api/webhooks/stripe`, { method: "POST", headers: { "Content-Type": "application/json", "Stripe-Signature": event.signature }, body: event.body, signal: AbortSignal.timeout(10_000) });
            } catch (err) {
              // eslint-disable-next-line no-console
              console.error(`stubs: webhook delivery to ${config.apiUrl} failed: ${err?.message ?? err}`);
            }
          }
          res.writeHead(303, { Location: session.success_url ?? config.webUrl });
          return res.end();
        }
      }

      // Razorpay: Orders and Payments.
      if (p === "/razorpay/v1/orders" && req.method === "POST") {
        const order = { id: id("order_stub"), entity: "order", amount: Number(body.amount ?? 0), currency: String(body.currency ?? "INR"), receipt: body.receipt ?? null, notes: body.notes ?? {}, status: "created" };
        state.orders.set(order.id, order);
        return send(res, 200, order);
      }
      const pay = /^\/razorpay\/v1\/payments\/([\w]+)(\/capture)?$/.exec(p);
      if (pay) {
        const payment = state.payments.get(pay[1]);
        if (!payment) return send(res, 404, { error: { description: "no such payment" } });
        if (pay[2] && req.method === "POST") payment.status = "captured";
        return send(res, 200, payment);
      }

      // Test helpers: settle a checkout the way the gateway would see it.
      if (p === "/__/stripe/pay" && req.method === "POST") {
        const session = state.sessions.get(body.sessionId);
        if (!session) return send(res, 404, { error: "no such session" });
        return send(res, 200, payStripeSession(session, config.stripeWebhookSecret));
      }
      if (p === "/__/razorpay/pay" && req.method === "POST") {
        const order = state.orders.get(body.orderId);
        if (!order) return send(res, 404, { error: "no such order" });
        const payment = { id: id("pay_stub"), entity: "payment", order_id: order.id, amount: Number(body.amount ?? order.amount), currency: order.currency, status: body.authorizeOnly ? "authorized" : "captured" };
        state.payments.set(payment.id, payment);
        order.status = "paid";
        const event = JSON.stringify({ event: "payment.captured", payload: { payment: { entity: payment } } });
        return send(res, 200, {
          paymentId: payment.id,
          signature: hmac(config.razorpayKeySecret, `${order.id}|${payment.id}`),
          webhook: { body: event, signature: hmac(config.razorpayWebhookSecret, event), eventId: id("evt_stub") },
        });
      }

      return send(res, 404, { error: { message: `no stub for ${req.method} ${p}` } });
    } catch (err) {
      if (!res.headersSent) send(res, 500, { error: { message: String(err?.message ?? err) } });
    }
  }

  return { handler, config, state };
}

/** Tests: listen on an ephemeral port. Returns the base URL and a close function. */
export async function startStubs(options = {}) {
  const stubs = createStubs({ ...options, port: options.port ?? 0 });
  const server = http.createServer((req, res) => void stubs.handler(req, res));
  await new Promise((resolve) => server.listen(options.port ?? 0, options.host ?? "127.0.0.1", resolve));
  const address = server.address();
  const url = `http://${options.host ?? "127.0.0.1"}:${address.port}`;
  if (!options.publicUrl) stubs.config.publicUrl = url;
  return { ...stubs, url, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const stubs = createStubs();
  const port = Number(process.env.PORT ?? 5149);
  // eslint-disable-next-line no-console
  http.createServer((req, res) => void stubs.handler(req, res)).listen(port, "0.0.0.0", () => console.log(`stubs listening on ${port}`));
}
