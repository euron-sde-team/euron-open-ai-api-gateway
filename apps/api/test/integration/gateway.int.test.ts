/**
 * The data plane end to end against the stubs: auth, resolution, pricing and settlement,
 * streaming, translation, failover, the breaker, and the endpoints billed per unit.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { newId } from "../../src/core/ids";
import { db } from "../../src/db/kysely";
import { clearCatalogCache } from "../../src/gateway/catalog";
import { createKey, createUser, gw, requestRow, priceOf, resetGatewayState, resetSettings, setSettings, sseEvents, stubRequests, walletOf } from "./harness";

const STUB_CHAT = { input: 500_000, output: 1_500_000 };
const STUB_CLAUDE = { input: 800_000, output: 4_000_000 };
const MARGIN = 2_000;
const tokens = (s: string) => Math.ceil(s.length / 4);
const reply = (s: string) => `Stub reply to: ${s.slice(0, 80)}`;

beforeAll(async () => setSettings({ defaultMarginBps: MARGIN }));
afterAll(async () => resetSettings());
beforeEach(async () => resetGatewayState());

describe("chat completions", () => {
  it("answers with the public model id and bills exactly once at cost plus margin", async () => {
    const ada = await createUser({ balanceMicros: 10_000_000 });
    const key = await createKey(ada);
    const res = await gw(key.secret).post("/v1/chat/completions").send({ model: "stub", messages: [{ role: "user", content: "hello there" }] });
    expect(res.status).toBe(200);
    expect(res.body.model).toBe("stub-chat");
    expect(res.body.choices[0].message.content).toBe(reply("hello there"));
    expect(res.headers["x-request-id"]).toMatch(/^req_/);

    const usage = { input: 7, output: tokens(reply("hello there")) };
    const price = priceOf(STUB_CHAT, usage, MARGIN);
    const row = await requestRow(res);
    expect(row).toMatchObject({ id: res.headers["x-request-id"], model_id: "stub-chat", provider_id: "stub", input_tokens: 7, output_tokens: usage.output, price_micros: price, margin_bps: MARGIN, estimated: false, attempts: 1 });
    expect(Number(row.cost_micros)).toBe(priceOf(STUB_CHAT, usage, 0));
    expect(await walletOf(ada.id)).toEqual({ balance: 10_000_000 - price, reserved: 0 });
    const ledger = await db.selectFrom("ledger").selectAll().where("ref_id", "=", row.id).execute();
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ type: "USAGE", amount_micros: -price, balance_after_micros: 10_000_000 - price });
  });

  it("streams, adds the usage chunk only when asked, and bills the reported usage", async () => {
    const ada = await createUser({ balanceMicros: 10_000_000 });
    const key = await createKey(ada);
    const messages = [{ role: "user", content: "stream please" }];
    const plain = await gw(key.secret).post("/v1/chat/completions").send({ model: "stub-chat", messages, stream: true });
    expect(plain.headers["content-type"]).toContain("text/event-stream");
    const plainEvents = sseEvents(plain.text);
    expect(plainEvents.at(-1)!.data).toBe("[DONE]");
    expect(plain.text).not.toContain('"usage"');
    const text = plainEvents
      .filter((e) => e.data !== "[DONE]")
      .map((e) => JSON.parse(e.data).choices[0]?.delta?.content ?? "")
      .join("");
    expect(text).toBe(reply("stream please"));
    expect(plainEvents.every((e) => e.data === "[DONE]" || JSON.parse(e.data).model === "stub-chat")).toBe(true);

    const withUsage = await gw(key.secret).post("/v1/chat/completions").send({ model: "stub-chat", messages, stream: true, stream_options: { include_usage: true } });
    const usageChunk = sseEvents(withUsage.text).find((e) => e.data.includes('"usage"'));
    expect(JSON.parse(usageChunk!.data).usage.prompt_tokens).toBe(8);

    const row = await requestRow(withUsage);
    expect(row).toMatchObject({ stream: true, estimated: false, input_tokens: 8 });
    expect(row.ttfb_ms).not.toBeNull();
    expect((await walletOf(ada.id)).reserved).toBe(0);
  });

  it("refuses with 402 before calling a provider when the balance is too low", async () => {
    const ada = await createUser({ balanceMicros: 10 });
    const key = await createKey(ada);
    const before = (await stubRequests()).length;
    const res = await gw(key.secret).post("/v1/chat/completions").send({ model: "stub-chat", messages: [{ role: "user", content: "hi" }] });
    expect(res.status).toBe(402);
    expect(res.body.error).toMatchObject({ type: "insufficient_balance", code: "insufficient_balance" });
    expect((await stubRequests()).length).toBe(before);
    expect(await walletOf(ada.id)).toEqual({ balance: 10, reserved: 0 });
  });

  it("never lets parallel requests spend past the balance", async () => {
    // max_tokens 1000 at $1.80/Mtok output reserves about 1 810 micros each; 5 000 covers two.
    // Six at once stays under the default tier's concurrency cap of eight.
    const ada = await createUser({ balanceMicros: 5_000 });
    const key = await createKey(ada);
    const body = { model: "stub-chat", max_tokens: 1000, messages: [{ role: "user", content: "parallel" }] };
    const results = await Promise.all(Array.from({ length: 6 }, () => gw(key.secret).post("/v1/chat/completions").send(body)));
    const ok = results.filter((r) => r.status === 200).length;
    expect(ok).toBeGreaterThanOrEqual(1);
    expect(results.filter((r) => r.status === 402).length).toBe(6 - ok);
    await Promise.all(results.filter((r) => r.status === 200).map((r) => requestRow(r)));
    const w = await walletOf(ada.id);
    expect(w.reserved).toBe(0);
    expect(w.balance).toBeGreaterThanOrEqual(0);
    const spent = await db.selectFrom("requests").select((eb) => eb.fn.sum<number>("price_micros").as("s")).where("user_id", "=", ada.id).executeTakeFirstOrThrow();
    expect(5_000 - w.balance).toBe(Number(spent.s));
  });

  it("fails over to the next route on a 503 and records both attempts", async () => {
    const ada = await createUser({ balanceMicros: 10_000_000 });
    const key = await createKey(ada);
    const res = await gw(key.secret).post("/v1/chat/completions").send({ model: "stub-failover", messages: [{ role: "user", content: "x" }] });
    expect(res.status).toBe(200);
    expect(res.body.model).toBe("stub-failover");
    const row = await requestRow(res);
    expect(row.attempts).toBe(2);
    const route = await db.selectFrom("model_routes").select("upstream_model").where("id", "=", row.route_id!).executeTakeFirstOrThrow();
    expect(route.upstream_model).toBe("stub-chat");
  });

  it("does not fail over once a stream has started, and bills an estimate for a cut stream", async () => {
    const ada = await createUser({ balanceMicros: 10_000_000 });
    const key = await createKey(ada);
    const res = await gw(key.secret).post("/v1/chat/completions").send({ model: "stub-chat", stream: true, messages: [{ role: "user", content: "please STUB_CUT this answer half way through, thanks" }] });
    expect(res.status).toBe(200);
    const row = await requestRow(res);
    expect(row).toMatchObject({ error_code: "stream_interrupted", estimated: true, attempts: 1 });
    expect(Number(row.price_micros)).toBeGreaterThan(0);
    expect((await walletOf(ada.id)).reserved).toBe(0);
  });

  it("opens the circuit after repeated failures and stops calling the provider", async () => {
    const id = `t-broken-${newId().slice(-6).toLowerCase()}`;
    await db.insertInto("models").values({ id, kind: "CHAT", display_name: "Broken", enabled: true }).execute();
    await db.insertInto("model_routes").values({ id: newId(), model_id: id, provider_id: "stub", upstream_model: "fail-500", priority: 1, input_micros_per_mtok: 1_000, output_micros_per_mtok: 1_000 }).execute();
    clearCatalogCache();
    const ada = await createUser({ balanceMicros: 10_000_000 });
    const key = await createKey(ada);
    const call = () => gw(key.secret).post("/v1/chat/completions").send({ model: id, messages: [{ role: "user", content: "x" }] });
    for (let i = 0; i < 5; i++) expect((await call()).status).toBe(502);
    const before = (await stubRequests()).length;
    const res = await call();
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe("no_route_available");
    expect((await stubRequests()).length).toBe(before);
    expect(await walletOf(ada.id)).toEqual({ balance: 10_000_000, reserved: 0 });
    await db.deleteFrom("models").where("id", "=", id).execute();
  });
});

describe("output limits", () => {
  it("never asks a provider for more output than was reserved", async () => {
    const ada = await createUser({ balanceMicros: 10_000_000 });
    const key = await createKey(ada);
    const sent = async (path: string) => (await stubRequests()).find((r) => r.path === path)!.body;
    await requestRow(await gw(key.secret).post("/v1/chat/completions").send({ model: "stub-chat", max_tokens: 999_999, messages: [{ role: "user", content: "x" }] }));
    expect((await sent("/v1/chat/completions")).max_tokens).toBe(4_096);
    await requestRow(await gw(key.secret).post("/v1/chat/completions").send({ model: "stub-chat", messages: [{ role: "user", content: "x" }] }));
    const unasked = await sent("/v1/chat/completions");
    expect(unasked.max_completion_tokens).toBe(4_096);
    expect(unasked.max_tokens).toBeUndefined();
    await requestRow(await gw(key.secret).post("/v1/chat/completions").send({ model: "stub-claude", max_completion_tokens: 999_999, messages: [{ role: "user", content: "x" }] }));
    expect((await sent("/anthropic/v1/messages")).max_tokens).toBe(4_096);
  });
});

describe("translation between the OpenAI and Anthropic formats", () => {
  it("serves an Anthropic-format model through /v1/chat/completions, streaming and not", async () => {
    const ada = await createUser({ balanceMicros: 10_000_000 });
    const key = await createKey(ada);
    const res = await gw(key.secret).post("/v1/chat/completions").send({ model: "stub-claude", messages: [{ role: "system", content: "be brief" }, { role: "user", content: "hola" }] });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ object: "chat.completion", model: "stub-claude", choices: [{ message: { role: "assistant", content: reply("hola") }, finish_reason: "stop" }] });
    const sent = (await stubRequests()).find((r) => r.path === "/anthropic/v1/messages")!;
    expect(sent.headers["anthropic-version"]).toBe("2023-06-01");
    expect(sent.body.system).toBe("be brief");
    // "be brief" is 2 tokens, "hola" 1 plus 4 for the message.
    const usage = { input: 7, output: tokens(reply("hola")) };
    expect(res.body.usage).toMatchObject({ prompt_tokens: usage.input, completion_tokens: usage.output });
    expect(Number((await requestRow(res)).price_micros)).toBe(priceOf(STUB_CLAUDE, usage, MARGIN));

    const streamed = await gw(key.secret).post("/v1/chat/completions").send({ model: "stub-claude", stream: true, stream_options: { include_usage: true }, messages: [{ role: "user", content: "hola" }] });
    const events = sseEvents(streamed.text);
    expect(events.at(-1)!.data).toBe("[DONE]");
    const text = events
      .filter((e) => e.data !== "[DONE]")
      .map((e) => JSON.parse(e.data).choices?.[0]?.delta?.content ?? "")
      .join("");
    expect(text).toBe(reply("hola"));
    expect(events.some((e) => e.data.includes('"usage"'))).toBe(true);
  });

  it("serves an OpenAI-format model through /v1/messages, and passes Anthropic models through", async () => {
    const ada = await createUser({ balanceMicros: 10_000_000 });
    const key = await createKey(ada);
    const res = await gw(key.secret, "x-api-key").post("/v1/messages").send({ model: "stub-chat", max_tokens: 100, system: "be brief", messages: [{ role: "user", content: "bonjour" }] });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ type: "message", role: "assistant", model: "stub-chat", content: [{ type: "text", text: reply("bonjour") }], stop_reason: "end_turn" });
    expect(res.body.usage.input_tokens).toBeGreaterThan(0);

    const streamed = await gw(key.secret, "x-api-key").post("/v1/messages").send({ model: "stub-chat", max_tokens: 100, stream: true, messages: [{ role: "user", content: "bonjour" }] });
    const names = sseEvents(streamed.text).map((e) => e.event);
    expect(names[0]).toBe("message_start");
    expect(names).toContain("content_block_delta");
    expect(names.at(-1)).toBe("message_stop");

    const native = await gw(key.secret, "x-api-key").post("/v1/messages").send({ model: "stub-claude", max_tokens: 100, messages: [{ role: "user", content: "hi" }] });
    expect(native.body).toMatchObject({ model: "stub-claude", usage: { input_tokens: 5 } });
  });

  it("uses the Anthropic error envelope on /v1/messages", async () => {
    const ada = await createUser({ balanceMicros: 10_000_000 });
    const key = await createKey(ada);
    const res = await gw(key.secret).post("/v1/messages").send({ model: "stub-chat", messages: [{ role: "user", content: "hi" }] });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ type: "error", error: { type: "invalid_request_error" } });
  });
});

describe("endpoints billed per unit", () => {
  it("bills embeddings by input tokens, images per image, speech per character and transcription per minute", async () => {
    const ada = await createUser({ balanceMicros: 10_000_000 });
    const key = await createKey(ada);
    const up = (m: number) => Math.ceil((m * (10_000 + MARGIN)) / 10_000);

    const emb = await gw(key.secret).post("/v1/embeddings").send({ model: "stub-embed", input: ["abcdefgh", "abcd"] });
    expect(emb.status).toBe(200);
    expect(emb.body.data).toHaveLength(2);
    expect(Number((await requestRow(emb)).price_micros)).toBe(Math.ceil((3 * up(20_000)) / 1_000_000));

    const img = await gw(key.secret).post("/v1/images/generations").send({ model: "stub-image", prompt: "a lighthouse", n: 2 });
    expect(img.status).toBe(200);
    expect(img.body.data).toHaveLength(2);
    expect(Number((await requestRow(img)).price_micros)).toBe(2 * up(40_000));

    const tts = await gw(key.secret).post("/v1/audio/speech").send({ model: "stub-tts", input: "x".repeat(1000), voice: "alloy" }).buffer(true);
    expect(tts.status).toBe(200);
    expect(tts.headers["content-type"]).toBe("audio/mpeg");
    expect(Number((await requestRow(tts)).price_micros)).toBe(Math.ceil((up(15_000_000) * 1000) / 1_000_000));

    const stt = await gw(key.secret).post("/v1/audio/transcriptions").field("model", "stub-whisper").attach("file", Buffer.alloc(200_000, 1), "clip.mp3");
    expect(stt.status).toBe(200);
    expect(stt.body).toEqual({ text: "Stub transcript of 200000 bytes." });
    const row = await requestRow(stt);
    expect(Number(row.units)).toBe(2);
    expect(Number(row.price_micros)).toBe(2 * up(6_000));
    expect((await walletOf(ada.id)).reserved).toBe(0);
  });

  it("refuses a model on the wrong endpoint and an unknown model", async () => {
    const ada = await createUser({ balanceMicros: 10_000_000 });
    const key = await createKey(ada);
    const wrong = await gw(key.secret).post("/v1/embeddings").send({ model: "stub-chat", input: "x" });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error.code).toBe("model_not_supported");
    const unknown = await gw(key.secret).post("/v1/chat/completions").send({ model: "no-such-model", messages: [{ role: "user", content: "x" }] });
    expect(unknown.status).toBe(404);
    expect(unknown.body.error.code).toBe("model_not_found");
  });
});

describe("pricing", () => {
  it("applies the margin by precedence: key, then account, then model, then the default", async () => {
    const ada = await createUser({ balanceMicros: 10_000_000, marginBps: 1_000 });
    const key = await createKey(ada);
    const body = { model: "stub-chat", messages: [{ role: "user", content: "margin" }] };
    const usage = { input: 6, output: tokens(reply("margin")) };

    const chat = (secret: string) => gw(secret).post("/v1/chat/completions").send(body);
    expect((await requestRow(await chat(key.secret))).margin_bps).toBe(1_000);

    await db.updateTable("api_keys").set({ margin_bps: 0 }).where("id", "=", key.id).execute();
    await resetGatewayState();
    const atCost = await requestRow(await chat(key.secret));
    expect(atCost.margin_bps).toBe(0);
    expect(Number(atCost.price_micros)).toBe(Number(atCost.cost_micros));

    const bob = await createUser({ balanceMicros: 10_000_000 });
    const bobKey = await createKey(bob);
    await db.updateTable("models").set({ margin_bps: 5_000 }).where("id", "=", "stub-chat").execute();
    clearCatalogCache();
    expect(Number((await requestRow(await chat(bobKey.secret))).price_micros)).toBe(priceOf(STUB_CHAT, usage, 5_000));
    await db.updateTable("models").set({ margin_bps: null }).where("id", "=", "stub-chat").execute();
    clearCatalogCache();
    expect((await requestRow(await chat(bobKey.secret))).margin_bps).toBe(MARGIN);
  });
});

describe("authentication and the models list", () => {
  it("rejects a missing or wrong key with the OpenAI envelope", async () => {
    const none = await gw("").get("/v1/models");
    expect(none.status).toBe(401);
    expect(none.body.error.type).toBe("authentication_error");
    const wrong = await gw("gw-" + "x".repeat(40)).post("/v1/chat/completions").send({ model: "stub-chat", messages: [{ role: "user", content: "x" }] });
    expect(wrong.status).toBe(401);
  });

  it("lists only the models the key may call", async () => {
    const ada = await createUser({ balanceMicros: 1_000_000 });
    const all = await createKey(ada);
    const some = await createKey(ada, { allowedModels: ["stub", "stub-embed"] });
    const everything = (await gw(all.secret).get("/v1/models")).body.data.map((m: { id: string }) => m.id);
    expect(everything).toEqual(expect.arrayContaining(["stub-chat", "stub-claude", "stub-embed", "stub-image"]));
    expect(everything).not.toContain("gpt-5.4");
    const limited = (await gw(some.secret).get("/v1/models")).body.data.map((m: { id: string }) => m.id);
    expect(limited.sort()).toEqual(["stub-chat", "stub-embed"]);
  });

  it("answers unknown /v1 paths with a 404 in the OpenAI envelope", async () => {
    const res = await gw("x").post("/v1/responses").send({});
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("unknown_url");
  });
});
