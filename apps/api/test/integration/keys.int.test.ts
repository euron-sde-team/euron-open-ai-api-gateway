/** API keys: the console CRUD, every key control in the data plane, rate limits, and owner scoping. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "../../src/db/kysely";
import { as, createKey, createUser, gw, requestRow, resetGatewayState, resetSettings, setSettings } from "./harness";

const chat = { model: "stub-chat", messages: [{ role: "user", content: "hi" }] };

beforeAll(async () => setSettings({ defaultMarginBps: 0 }));
afterAll(async () => resetSettings());
beforeEach(async () => resetGatewayState());

describe("console CRUD", () => {
  it("returns the secret once, stores only a hash, and lists keys without secrets", async () => {
    const ada = await createUser();
    const created = await as(ada).post("/api/keys").send({ name: "Laptop", allowedModels: ["stub"] });
    expect(created.status).toBe(201);
    expect(created.body.secret).toMatch(/^gw-[A-Za-z0-9]{40}$/);
    expect(created.body.hint).toBe(`gw-${created.body.secret.slice(3, 7)}...${created.body.secret.slice(-4)}`);
    expect(created.body.allowedModels).toEqual(["stub-chat"]);
    const row = await db.selectFrom("api_keys").selectAll().where("id", "=", created.body.id).executeTakeFirstOrThrow();
    expect(JSON.stringify(row)).not.toContain(created.body.secret);
    const list = await as(ada).get("/api/keys");
    expect(list.body).toHaveLength(1);
    expect(JSON.stringify(list.body)).not.toContain(created.body.secret);
    expect(list.body[0]).not.toHaveProperty("secret");
  });

  it("validates models, expiry and IP rules", async () => {
    const ada = await createUser();
    expect((await as(ada).post("/api/keys").send({ name: "x", allowedModels: ["nope"] })).body.code).toBe("UNKNOWN_MODEL");
    expect((await as(ada).post("/api/keys").send({ name: "x", expiresAt: "2020-01-01T00:00:00.000Z" })).body.code).toBe("EXPIRY_IN_PAST");
    expect((await as(ada).post("/api/keys").send({ name: "x", ipAllowlist: ["not-an-ip"] })).body.code).toBe("IP_ALLOWLIST_INVALID");
  });

  it("hides another account's keys behind 404", async () => {
    const ada = await createUser();
    const eve = await createUser();
    const key = await createKey(ada);
    expect((await as(eve).patch(`/api/keys/${key.id}`).send({ name: "mine now" })).status).toBe(404);
    expect((await as(eve).delete(`/api/keys/${key.id}`)).status).toBe(404);
    expect((await as(eve).get("/api/keys")).body).toEqual([]);
  });
});

describe("key controls in the data plane", () => {
  it("stops a revoked key on the next request", async () => {
    const ada = await createUser({ balanceMicros: 1_000_000 });
    const key = await createKey(ada);
    expect((await gw(key.secret).post("/v1/chat/completions").send(chat)).status).toBe(200);
    expect((await as(ada).delete(`/api/keys/${key.id}`)).status).toBe(204);
    const res = await gw(key.secret).post("/v1/chat/completions").send(chat);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("invalid_api_key");
  });

  it("refuses an expired key", async () => {
    const ada = await createUser({ balanceMicros: 1_000_000 });
    const key = await createKey(ada);
    await db.updateTable("api_keys").set({ expires_at: new Date(Date.now() - 1000) }).where("id", "=", key.id).execute();
    expect((await gw(key.secret).post("/v1/chat/completions").send(chat)).status).toBe(401);
  });

  it("enforces the model allow-list, the IP allow-list and an edit that tightens either", async () => {
    const ada = await createUser({ balanceMicros: 1_000_000 });
    const key = await createKey(ada, { allowedModels: ["stub-embed"] });
    const denied = await gw(key.secret).post("/v1/chat/completions").send(chat);
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe("model_not_allowed");

    const open = await createKey(ada);
    expect((await gw(open.secret).post("/v1/chat/completions").send(chat)).status).toBe(200);
    expect((await as(ada).patch(`/api/keys/${open.id}`).send({ ipAllowlist: ["198.51.100.0/24"] })).status).toBe(200);
    const blocked = await gw(open.secret).post("/v1/chat/completions").send(chat);
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe("ip_not_allowed");
    expect((await as(ada).patch(`/api/keys/${open.id}`).send({ ipAllowlist: ["127.0.0.0/8", "::1"] })).status).toBe(200);
    expect((await gw(open.secret).post("/v1/chat/completions").send(chat)).status).toBe(200);
  });

  it("stops a key at its monthly budget", async () => {
    const ada = await createUser({ balanceMicros: 1_000_000 });
    const key = await createKey(ada, { monthlyBudgetMicros: 5_000 });
    // Each call reserves about 6 200 micros (the stub's 4 096 output cap at $1.50/Mtok): over budget from the start.
    const res = await gw(key.secret).post("/v1/chat/completions").send(chat);
    expect(res.status).toBe(402);
    expect(res.body.error.code).toBe("budget_exceeded");
    const roomy = await createKey(ada, { monthlyBudgetMicros: 50_000 });
    const ok = await gw(roomy.secret).post("/v1/chat/completions").send({ ...chat, max_tokens: 10 });
    expect(ok.status).toBe(200);
    const row = await requestRow(ok);
    const listed = (await as(ada).get("/api/keys")).body.find((k: { id: string }) => k.id === roomy.id);
    expect(listed.spentThisMonthMicros).toBe(Number(row.price_micros));
  });

  it("stops every key of a suspended account", async () => {
    const ada = await createUser({ balanceMicros: 1_000_000 });
    const key = await createKey(ada);
    expect((await gw(key.secret).post("/v1/chat/completions").send(chat)).status).toBe(200);
    const admin = await createUser({ role: "ADMIN" });
    expect((await as(admin).post(`/api/admin/users/${ada.id}/suspend`).send({ days: 3 })).status).toBe(200);
    const res = await gw(key.secret).post("/v1/chat/completions").send(chat);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("account_restricted");
  });
});

describe("rate limits", () => {
  it("answers 429 with retry-after once a key's RPM is spent", async () => {
    const ada = await createUser({ balanceMicros: 10_000_000 });
    const key = await createKey(ada, { rpm: 3 });
    const statuses: number[] = [];
    let limited: { headers: Record<string, string>; body: any } | null = null;
    for (let i = 0; i < 5; i++) {
      const res = await gw(key.secret).post("/v1/chat/completions").send({ ...chat, max_tokens: 10 });
      statuses.push(res.status);
      if (res.status === 429) limited = res;
    }
    expect(statuses.slice(0, 3)).toEqual([200, 200, 200]);
    expect(statuses.slice(3)).toEqual([429, 429]);
    expect(Number(limited!.headers["retry-after"])).toBeGreaterThan(0);
    expect(limited!.body.error).toMatchObject({ type: "rate_limit_error", code: "rate_limit_exceeded" });
  });

  it("answers 429 once a key's TPM is spent", async () => {
    const ada = await createUser({ balanceMicros: 10_000_000 });
    const key = await createKey(ada, { tpm: 500 });
    expect((await gw(key.secret).post("/v1/chat/completions").send({ ...chat, max_tokens: 400 })).status).toBe(200);
    const res = await gw(key.secret).post("/v1/chat/completions").send({ ...chat, max_tokens: 400 });
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe("tokens_rate_limit_exceeded");
  });
});
