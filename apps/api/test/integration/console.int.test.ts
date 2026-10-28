/** The developer console API: meta, the catalogue at the account's prices, the wallet, usage and request bodies. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { anon, as, createKey, createUser, gw, requestRow, resetGatewayState, resetSettings, setSettings } from "./harness";

beforeAll(async () => setSettings({ defaultMarginBps: 1_000 }));
afterAll(async () => resetSettings());
beforeEach(async () => resetGatewayState());

const chat = { model: "stub-chat", messages: [{ role: "user", content: "console" }], max_tokens: 20 };

describe("meta and the catalogue", () => {
  it("tells a signed-out client what it needs: base URL, key prefix and how to top up", async () => {
    const meta = (await anon().get("/api/meta").expect(200)).body;
    expect(meta).toMatchObject({ keyPrefix: "gw-", gatewayBaseUrl: expect.stringMatching(/\/v1$/), billing: { inrPerUsd: 80, taxBps: 0 } });
    expect(meta.billing.topups).toEqual([
      { currency: "USD", gateway: "STRIPE", minMinor: 500, maxMinor: 100_000 },
      { currency: "INR", gateway: "RAZORPAY", minMinor: 50_000, maxMinor: 10_000_000 },
    ]);
  });

  it("lists list prices signed out and the account's own prices signed in", async () => {
    const pub = (await anon().get("/api/catalog").expect(200)).body as { id: string; price: { inputMicrosPerMtok: number }; routes: number }[];
    const stub = pub.find((m) => m.id === "stub-chat")!;
    expect(stub.price.inputMicrosPerMtok).toBe(550_000);
    expect(pub.find((m) => m.id === "stub-failover")!.routes).toBe(2);
    expect(pub.some((m) => m.id === "gpt-5.4")).toBe(false);
    const partner = await createUser({ marginBps: 0 });
    const mine = (await as(partner).get("/api/catalog").expect(200)).body as typeof pub;
    expect(mine.find((m) => m.id === "stub-chat")!.price.inputMicrosPerMtok).toBe(500_000);
    expect(JSON.stringify(pub)).not.toMatch(/upstream|provider|credential/i);
  });
});

describe("wallet and usage", () => {
  it("shows the wallet with its INR equivalent", async () => {
    const ada = await createUser({ balanceMicros: 12_500_000 });
    expect((await as(ada).get("/api/billing/wallet")).body).toEqual({ balanceMicros: 12_500_000, reservedMicros: 0, availableMicros: 12_500_000, balanceInr: 1000, inrPerUsd: 80 });
  });

  it("summarises usage by day, model and key, and lists requests without bodies unless the key logs them", async () => {
    const ada = await createUser({ balanceMicros: 5_000_000 });
    const plain = await createKey(ada, { name: "Plain" });
    const logged = await createKey(ada, { name: "Logged", logBodies: true });
    const a = await requestRow(await gw(plain.secret).post("/v1/chat/completions").send(chat));
    const b = await requestRow(await gw(logged.secret).post("/v1/chat/completions").send(chat));
    await requestRow(await gw(logged.secret).post("/v1/embeddings").send({ model: "stub-embed", input: "x" }));

    const summary = (await as(ada).get("/api/usage/summary")).body;
    expect(summary.totals.requests).toBe(3);
    expect(summary.totals.spendMicros).toBe(Number(a.price_micros) + Number(b.price_micros) + summary.byModel.find((m: { modelId: string }) => m.modelId === "stub-embed").spendMicros);
    expect(summary.daily).toHaveLength(30);
    expect(summary.daily.at(-1).requests).toBe(3);
    expect(summary.byKey.map((k: { name: string }) => k.name).sort()).toEqual(["Logged", "Plain"]);
    expect((await as(ada).get(`/api/usage/summary?apiKeyId=${plain.id}`)).body.totals.requests).toBe(1);

    const page = (await as(ada).get("/api/usage/requests?limit=2")).body;
    expect(page.items).toHaveLength(2);
    expect(page.nextCursor).toBeTruthy();
    const rest = (await as(ada).get(`/api/usage/requests?limit=2&cursor=${encodeURIComponent(page.nextCursor)}`)).body;
    expect(rest.items).toHaveLength(1);
    expect(new Set([...page.items, ...rest.items].map((r: { id: string }) => r.id)).size).toBe(3);

    const withoutBodies = (await as(ada).get(`/api/usage/requests/${a.id}`)).body;
    expect(withoutBodies).toMatchObject({ id: a.id, apiKeyName: "Plain", hasBodies: false, bodies: null });
    const withBodies = (await as(ada).get(`/api/usage/requests/${b.id}`)).body;
    expect(withBodies.hasBodies).toBe(true);
    expect(withBodies.bodies.request.messages[0].content).toBe("console");
    expect(withBodies.bodies.response.choices[0].message.content).toBe("Stub reply to: console");
  });

  it("keeps usage private: another account sees 404 and admins never get bodies", async () => {
    const ada = await createUser({ balanceMicros: 1_000_000 });
    const eve = await createUser();
    const key = await createKey(ada, { logBodies: true });
    const row = await requestRow(await gw(key.secret).post("/v1/chat/completions").send(chat));
    expect((await as(eve).get(`/api/usage/requests/${row.id}`)).status).toBe(404);
    expect((await as(eve).get("/api/usage/summary")).body.totals.requests).toBe(0);
    const admin = await createUser({ role: "ADMIN" });
    for (const path of [`/api/admin/users/${ada.id}`, "/api/admin/stats", "/api/admin/health"]) {
      expect(JSON.stringify((await as(admin).get(path)).body)).not.toContain("Stub reply to: console");
    }
  });
});
