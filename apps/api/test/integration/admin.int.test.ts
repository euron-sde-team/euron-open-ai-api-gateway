/**
 * The /admin control plane: access, providers and encrypted credentials, the catalogue
 * invariants (no unpriced enabled model), margins that the next request follows, route
 * tests, health and circuits, accounts, tiers, stats and settings.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "../../src/db/kysely";
import { clearCatalogCache } from "../../src/gateway/catalog";
import { as, createKey, createUser, gw, requestRow, resetGatewayState, resetSettings, unique } from "./harness";

beforeEach(async () => resetGatewayState());
afterAll(async () => resetSettings());

const chat = { model: "stub-chat", messages: [{ role: "user", content: "hi" }], max_tokens: 20 };

describe("access", () => {
  it("is for active admins only", async () => {
    const user = await createUser();
    expect((await as(user).get("/api/admin/models")).body.code).toBe("FORBIDDEN_ADMIN");
    expect((await as(null).get("/api/admin/models")).status).toBe(401);
    const admin = await createUser({ role: "ADMIN" });
    expect((await as(admin).get("/api/admin/me")).body).toEqual({ role: "ADMIN" });
  });
});

describe("providers and credentials", () => {
  it("encrypts a credential on arrival and never returns it", async () => {
    const admin = await createUser({ role: "ADMIN" });
    const id = unique("p").toLowerCase().slice(0, 30);
    const created = await as(admin).post("/api/admin/providers").send({ id, kind: "OPENAI_COMPATIBLE", displayName: "Together", baseUrl: "https://api.together.example.com/v1", enabled: true });
    expect(created.status).toBe(201);
    // Low entropy on purpose: obviously not a real key.
    const secret = `sk-placeholder-${"x".repeat(12)}cdef`;
    const withCred = await as(admin).post(`/api/admin/providers/${id}/credentials`).send({ label: "Primary", secret });
    expect(withCred.status).toBe(201);
    expect(JSON.stringify(withCred.body)).not.toContain(secret);
    const provider = withCred.body.find((p: { id: string }) => p.id === id);
    expect(provider.credentials).toEqual([expect.objectContaining({ label: "Primary", last4: "cdef", enabled: true })]);
    const row = await db.selectFrom("provider_credentials").select("ciphertext").where("provider_id", "=", id).executeTakeFirstOrThrow();
    expect(row.ciphertext.startsWith("v1:")).toBe(true);
    expect(row.ciphertext).not.toContain(secret);
    expect(JSON.stringify((await as(admin).get("/api/admin/providers")).body)).not.toContain(secret);
    expect((await as(admin).post("/api/admin/providers").send({ id: "bad", kind: "OPENAI_COMPATIBLE", displayName: "x", baseUrl: null, enabled: true })).status).toBe(400);
    await as(admin).delete(`/api/admin/providers/${id}`);
  });
});

describe("the catalogue", () => {
  it("refuses to enable a model without a priced route, then serves it once it has one", async () => {
    const admin = await createUser({ role: "ADMIN" });
    const id = `t-${unique("m").toLowerCase().slice(0, 20)}`;
    await as(admin).post("/api/admin/models").send({ id, kind: "CHAT", displayName: "Test model", enabled: false }).expect(201);
    const enable = await as(admin).put(`/api/admin/models/${encodeURIComponent(id)}`).send({ kind: "CHAT", displayName: "Test model", enabled: true });
    expect(enable.status).toBe(409);
    expect(enable.body.code).toBe("MODEL_UNPRICED");

    const free = await as(admin).post(`/api/admin/models/${encodeURIComponent(id)}/routes`).send({ providerId: "stub", upstreamModel: "stub-chat", priority: 1, inputMicrosPerMtok: 0, outputMicrosPerMtok: 0 });
    expect(free.status).toBe(201);
    expect((await as(admin).put(`/api/admin/models/${encodeURIComponent(id)}`).send({ kind: "CHAT", displayName: "Test model", enabled: true })).status).toBe(409);

    const routeId = free.body.find((m: { id: string }) => m.id === id).routes[0].id;
    await as(admin).put(`/api/admin/models/${encodeURIComponent(id)}/routes/${routeId}`).send({ providerId: "stub", upstreamModel: "stub-chat", priority: 1, inputMicrosPerMtok: 1_000_000, outputMicrosPerMtok: 2_000_000 }).expect(200);
    const enabled = await as(admin).put(`/api/admin/models/${encodeURIComponent(id)}`).send({ kind: "CHAT", displayName: "Test model", enabled: true, marginBps: 2_500 });
    expect(enabled.status).toBe(200);
    const model = enabled.body.find((m: { id: string }) => m.id === id);
    expect(model).toMatchObject({ effectiveMarginBps: 2_500, price: { inputMicrosPerMtok: 1_250_000, outputMicrosPerMtok: 2_500_000 } });

    // Deleting the only route of an enabled model is refused.
    expect((await as(admin).delete(`/api/admin/models/${encodeURIComponent(id)}/routes/${routeId}`)).body.code).toBe("MODEL_UNPRICED");

    const ada = await createUser({ balanceMicros: 1_000_000 });
    const key = await createKey(ada);
    clearCatalogCache();
    const res = await gw(key.secret).post("/v1/chat/completions").send({ ...chat, model: id });
    expect(res.status).toBe(200);
    expect((await requestRow(res)).margin_bps).toBe(2_500);
    await db.deleteFrom("models").where("id", "=", id).execute();
  });

  it("refuses a free primary route even when a priced backup exists", async () => {
    const admin = await createUser({ role: "ADMIN" });
    const id = `t-${unique("f").toLowerCase().slice(0, 20)}`;
    const enc = encodeURIComponent(id);
    await as(admin).post("/api/admin/models").send({ id, kind: "CHAT", displayName: "Free primary" }).expect(201);
    await as(admin).post(`/api/admin/models/${enc}/routes`).send({ providerId: "stub", upstreamModel: "stub-chat", priority: 1, inputMicrosPerMtok: 0, outputMicrosPerMtok: 0 }).expect(201);
    await as(admin).post(`/api/admin/models/${enc}/routes`).send({ providerId: "stub", upstreamModel: "slow-1", priority: 2, inputMicrosPerMtok: 1_000_000, outputMicrosPerMtok: 1_000_000 }).expect(201);
    expect((await as(admin).put(`/api/admin/models/${enc}`).send({ kind: "CHAT", displayName: "Free primary", enabled: true })).body.code).toBe("MODEL_UNPRICED");
    const models = (await as(admin).get("/api/admin/models")).body as { id: string; price: unknown; routes: { id: string; priority: number }[] }[];
    const model = models.find((m) => m.id === id)!;
    const primary = model.routes.find((r) => r.priority === 1)!;
    // Disabling the free primary makes the priced backup the primary: now it can be enabled, and the admin price follows.
    await as(admin).put(`/api/admin/models/${enc}/routes/${primary.id}`).send({ providerId: "stub", upstreamModel: "stub-chat", priority: 1, inputMicrosPerMtok: 0, outputMicrosPerMtok: 0, enabled: false }).expect(200);
    const enabled = await as(admin).put(`/api/admin/models/${enc}`).send({ kind: "CHAT", displayName: "Free primary", enabled: true });
    expect(enabled.status).toBe(200);
    expect(enabled.body.find((m: { id: string }) => m.id === id).price).toMatchObject({ inputMicrosPerMtok: 1_000_000 });
    await db.deleteFrom("models").where("id", "=", id).execute();
  });

  it("refuses an alias that shadows another model", async () => {
    const admin = await createUser({ role: "ADMIN" });
    const res = await as(admin).post("/api/admin/models").send({ id: `t-${unique("a").toLowerCase().slice(0, 20)}`, kind: "CHAT", displayName: "Shadow", aliases: ["stub-chat"] });
    expect(res.body.code).toBe("ALIAS_TAKEN");
  });

  it("applies a margin change to the very next request (key and account overrides)", async () => {
    const admin = await createUser({ role: "ADMIN" });
    const ada = await createUser({ balanceMicros: 1_000_000 });
    const key = await createKey(ada);
    expect((await requestRow(await gw(key.secret).post("/v1/chat/completions").send(chat))).margin_bps).toBe(0);
    const detail = await as(admin).put(`/api/admin/users/${ada.id}/margin`).send({ marginBps: 4_000 });
    expect(detail.body.marginBps).toBe(4_000);
    expect((await requestRow(await gw(key.secret).post("/v1/chat/completions").send(chat))).margin_bps).toBe(4_000);
    await as(admin).put(`/api/admin/users/${ada.id}/keys/${key.id}/margin`).send({ marginBps: 0 }).expect(200);
    expect((await requestRow(await gw(key.secret).post("/v1/chat/completions").send(chat))).margin_bps).toBe(0);
    const keys = (await as(admin).get(`/api/admin/users/${ada.id}`)).body.keys;
    expect(keys[0]).toMatchObject({ id: key.id, marginBps: 0 });
    expect(JSON.stringify(keys)).not.toContain(key.secret);
  });

  it("tests a route through the real call and records the result", async () => {
    const admin = await createUser({ role: "ADMIN" });
    const models = (await as(admin).get("/api/admin/models")).body as { id: string; routes: { id: string; upstreamModel: string }[] }[];
    const failover = models.find((m) => m.id === "stub-failover")!;
    const good = failover.routes.find((r) => r.upstreamModel === "stub-chat")!;
    const bad = failover.routes.find((r) => r.upstreamModel === "fail-503")!;
    const ok = await as(admin).post(`/api/admin/models/stub-failover/routes/${good.id}/test`).send();
    expect(ok.body).toMatchObject({ ok: true });
    const failed = await as(admin).post(`/api/admin/models/stub-failover/routes/${bad.id}/test`).send();
    expect(failed.body).toMatchObject({ ok: false, message: "The provider answered 503" });
    const health = (await as(admin).get("/api/admin/health")).body as { routeId: string; checks: { ok: boolean }[] }[];
    expect(health.find((h) => h.routeId === bad.id)!.checks[0]!.ok).toBe(false);
  });

  it("forces a circuit open and closed", async () => {
    const admin = await createUser({ role: "ADMIN" });
    const ada = await createUser({ balanceMicros: 1_000_000 });
    const key = await createKey(ada);
    const models = (await as(admin).get("/api/admin/models")).body as { id: string; routes: { id: string }[] }[];
    const route = models.find((m) => m.id === "stub-embed")!.routes[0]!;
    await as(admin).post(`/api/admin/health/${route.id}/circuit`).send({ state: "open" }).expect(204);
    const refused = await gw(key.secret).post("/v1/embeddings").send({ model: "stub-embed", input: "x" });
    expect(refused.body.error.code).toBe("no_route_available");
    expect((await as(admin).get("/api/admin/health")).body.find((h: { routeId: string }) => h.routeId === route.id).circuit).toBe("open");
    await as(admin).post(`/api/admin/health/${route.id}/circuit`).send({ state: "closed" }).expect(204);
    expect((await gw(key.secret).post("/v1/embeddings").send({ model: "stub-embed", input: "x" })).status).toBe(200);
  });
});

describe("accounts and tiers", () => {
  it("lists accounts with balance and month spend, and moves one to a tier whose limits apply at once", async () => {
    const admin = await createUser({ role: "ADMIN" });
    const ada = await createUser({ balanceMicros: 2_000_000 });
    const key = await createKey(ada);
    const tiers = await as(admin).post("/api/admin/tiers").send({ name: unique("Tight"), rpm: 1, tpm: null, concurrency: null });
    const tier = tiers.body.find((t: { rpm: number | null; isDefault: boolean }) => t.rpm === 1 && !t.isDefault);
    await as(admin).put(`/api/admin/users/${ada.id}/tier`).send({ tierId: tier.id }).expect(200);
    expect((await gw(key.secret).post("/v1/chat/completions").send(chat)).status).toBe(200);
    expect((await gw(key.secret).post("/v1/chat/completions").send(chat)).status).toBe(429);

    const page = await as(admin).get(`/api/admin/users?q=${ada.username}`);
    expect(page.body.items[0]).toMatchObject({ id: ada.id, limitTier: { id: tier.id }, marginBps: null });
    expect(page.body.items[0].balanceMicros).toBeLessThan(2_000_000);
    expect(page.body.items[0].spentThisMonthMicros).toBe(2_000_000 - page.body.items[0].balanceMicros);
    await as(admin).put(`/api/admin/users/${ada.id}/tier`).send({ tierId: null });
    expect((await as(admin).delete(`/api/admin/tiers/${tier.id}`)).status).toBe(200);
    const def = (await as(admin).get("/api/admin/tiers")).body.find((t: { isDefault: boolean }) => t.isDefault);
    expect((await as(admin).delete(`/api/admin/tiers/${def.id}`)).body.code).toBe("TIER_DEFAULT");
  });

  it("erases an account: identity gone, keys revoked, logged bodies deleted, financial records kept", async () => {
    const admin = await createUser({ role: "ADMIN" });
    const ada = await createUser({ balanceMicros: 1_000_000 });
    const key = await createKey(ada, { logBodies: true });
    const res = await gw(key.secret).post("/v1/chat/completions").send(chat);
    const row = await requestRow(res);
    expect(await db.selectFrom("request_bodies").select("request_id").where("request_id", "=", row.id).executeTakeFirst()).toBeTruthy();
    await as(admin).post(`/api/admin/users/${ada.id}/erase`).send({ reason: "Asked to be forgotten" }).expect(204);
    const user = await db.selectFrom("users").select(["email", "status"]).where("id", "=", ada.id).executeTakeFirstOrThrow();
    expect(user.status).toBe("DEACTIVATED");
    expect(user.email).not.toContain(ada.username);
    expect((await gw(key.secret).post("/v1/chat/completions").send(chat)).status).toBe(401);
    expect(await db.selectFrom("request_bodies").select("request_id").where("request_id", "=", row.id).executeTakeFirst()).toBeUndefined();
    expect(await db.selectFrom("requests").select("id").where("id", "=", row.id).executeTakeFirst()).toBeTruthy();
    expect((await db.selectFrom("ledger").select("id").where("user_id", "=", ada.id).execute()).length).toBeGreaterThan(0);
  });
});

describe("stats, settings and integrations", () => {
  it("reports revenue, provider cost and the margin between them", async () => {
    const admin = await createUser({ role: "ADMIN" });
    const ada = await createUser({ balanceMicros: 1_000_000, marginBps: 5_000 });
    const key = await createKey(ada);
    await requestRow(await gw(key.secret).post("/v1/chat/completions").send(chat));
    const stats = (await as(admin).get("/api/admin/stats")).body;
    expect(stats.totals.revenueMicros).toBeGreaterThan(stats.totals.costMicros);
    expect(stats.totals.marginMicros).toBe(stats.totals.revenueMicros - stats.totals.costMicros);
    expect(stats.byModel.find((m: { modelId: string }) => m.modelId === "stub-chat")).toMatchObject({ requests: expect.any(Number), p50LatencyMs: expect.any(Number) });
    expect(stats.byProvider.find((p: { providerId: string }) => p.providerId === "stub")).toBeTruthy();
    expect(stats.daily.length).toBeGreaterThan(0);
  });

  it("saves settings with validation and audits the change", async () => {
    const admin = await createUser({ role: "ADMIN" });
    const res = await as(admin).patch("/api/admin/settings").send({ defaultMarginBps: 1_500, taxBps: 1_800, taxLabel: "GST", topupLimits: { usdMin: 10 } });
    expect(res.body).toMatchObject({ defaultMarginBps: 1_500, taxBps: 1_800, topupLimits: { usdMin: 10, usdMax: 1000 } });
    expect((await as(admin).patch("/api/admin/settings").send({ topupLimits: { usdMin: 5000 } })).body.code).toBe("SETTINGS_INVALID");
    expect((await as(admin).patch("/api/admin/settings").send({ defaultMarginBps: -1 })).status).toBe(400);
    const audit = (await as(admin).get("/api/admin/audit?action=settings.")).body.items[0];
    expect(audit.data.keys).toEqual(expect.arrayContaining(["defaultMarginBps", "taxBps"]));
    const meta = (await as(null).get("/api/meta")).body;
    expect(meta.billing).toMatchObject({ taxBps: 1_800, taxLabel: "GST" });
    await resetSettings();
  });

  it("describes integrations without secrets", async () => {
    const admin = await createUser({ role: "ADMIN" });
    const res = (await as(admin).get("/api/admin/integrations")).body;
    expect(res).toMatchObject({ payments: { stripe: true, razorpay: true, stub: true }, fx: { inrPerUsd: 80 } });
    expect(JSON.stringify(res)).not.toMatch(/sk_test|rzp_secret|whsec/);
  });

  it("lists top-ups across accounts", async () => {
    const admin = await createUser({ role: "ADMIN" });
    const ada = await createUser();
    await as(ada).post("/api/billing/topups").send({ currency: "USD", amount: 10 }).expect(201);
    const page = await as(admin).get(`/api/admin/topups?userId=${ada.id}`);
    expect(page.body.items).toEqual([expect.objectContaining({ owner: expect.objectContaining({ id: ada.id }), gateway: "STRIPE", status: "CREATED", totalMinor: 1000 })]);
  });
});
