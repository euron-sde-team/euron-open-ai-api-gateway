/**
 * Secrets never leave the server. A provider credential set to CANARY_KEY serves real
 * traffic (and failures) through the stubs; this file walks every kind of response a
 * developer and an admin can fetch, and the database, and asserts the canary is nowhere
 * in clear. A caller's API key is the second canary: only its hash may be stored.
 */
import type request from "supertest";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { newId } from "../../src/core/ids";
import { db } from "../../src/db/kysely";
import { clearCatalogCache } from "../../src/gateway/catalog";
import { CANARY_KEY } from "./env";
import { anon, as, createKey, createUser, gw, requestRow, resetGatewayState, stubRequests, stubsUrl, type TestUser } from "./harness";

const PROVIDER = "canary";
const MODEL = "t-canary-chat";

/** Buffer any response (JSON, PDF, an attachment) as text. */
const asText = (r: request.Test) =>
  r.buffer(true).parse((res, cb) => {
    let data = "";
    res.setEncoding("latin1");
    res.on("data", (c: string) => (data += c));
    res.on("end", () => cb(null, data));
  });

let admin: TestUser;
let user: TestUser;
let apiKey: { secret: string; id: string };

beforeAll(async () => {
  await resetGatewayState();
  admin = await createUser({ role: "ADMIN" });
  user = await createUser({ balanceMicros: 5_000_000 });
  await as(admin).post("/api/admin/providers").send({ id: PROVIDER, kind: "OPENAI_COMPATIBLE", displayName: "Canary", baseUrl: `${stubsUrl()}/v1`, enabled: true }).expect(201);
  await as(admin).post(`/api/admin/providers/${PROVIDER}/credentials`).send({ label: "Canary", secret: CANARY_KEY }).expect(201);
  await db.insertInto("models").values({ id: MODEL, kind: "CHAT", display_name: "Canary chat", enabled: true }).execute();
  await db.insertInto("model_routes").values({ id: newId(), model_id: MODEL, provider_id: PROVIDER, upstream_model: "stub-chat", priority: 1, input_micros_per_mtok: 1_000, output_micros_per_mtok: 1_000 }).execute();
  await db.insertInto("models").values({ id: `${MODEL}-401`, kind: "CHAT", display_name: "Canary refused", enabled: true }).execute();
  await db.insertInto("model_routes").values({ id: newId(), model_id: `${MODEL}-401`, provider_id: PROVIDER, upstream_model: "fail-401", priority: 1, input_micros_per_mtok: 1_000, output_micros_per_mtok: 1_000 }).execute();
  clearCatalogCache();
  apiKey = await createKey(user, { logBodies: true });
});

afterAll(async () => {
  await db.deleteFrom("models").where("id", "in", [MODEL, `${MODEL}-401`]).execute();
  await db.deleteFrom("providers").where("id", "=", PROVIDER).execute();
  clearCatalogCache();
});

describe("the canaries", () => {
  test("serve traffic and appear in no response a developer or an admin can fetch", async () => {
    const bodies: string[] = [];
    const ok = await gw(apiKey.secret).post("/v1/chat/completions").send({ model: MODEL, messages: [{ role: "user", content: "canary" }] });
    expect(ok.status).toBe(200);
    bodies.push(ok.text);
    const row = await requestRow(ok);
    // The provider received the canary as its bearer: the credential really was used.
    expect((await stubRequests()).find((r) => r.path === "/v1/chat/completions")!.headers.authorization).toBe("present");
    const refused = await gw(apiKey.secret).post("/v1/chat/completions").send({ model: `${MODEL}-401`, messages: [{ role: "user", content: "canary" }] });
    expect(refused.status).toBe(502);
    bodies.push(refused.text);
    bodies.push((await gw(apiKey.secret).post("/v1/messages").send({ model: MODEL, max_tokens: 20, messages: [{ role: "user", content: "canary" }] })).text);
    bodies.push((await gw(apiKey.secret).get("/v1/models")).text);

    const userGets = ["/api/meta", "/api/catalog", "/api/users/me", "/api/keys", "/api/billing/wallet", "/api/billing/ledger", "/api/usage/summary", "/api/usage/requests", `/api/usage/requests/${row.id}`, "/api/users/me/sessions"];
    for (const url of userGets) bodies.push((await as(user).get(url).expect(200)).text);
    bodies.push((await asText(as(user).get("/api/users/me/export")).expect(200)).body as string);
    bodies.push((await anon().get("/api/catalog").expect(200)).text);

    const models = (await as(admin).get("/api/admin/models").expect(200)).body as { id: string; routes: { id: string }[] }[];
    const route = models.find((m) => m.id === MODEL)!.routes[0]!;
    bodies.push((await as(admin).post(`/api/admin/models/${MODEL}/routes/${route.id}/test`).send({}).expect(200)).text);
    const adminGets = ["/api/admin/me", "/api/admin/stats", "/api/admin/users", `/api/admin/users/${user.id}`, "/api/admin/tiers", "/api/admin/providers", "/api/admin/models", "/api/admin/health", "/api/admin/topups", "/api/admin/promos", "/api/admin/settings", "/api/admin/integrations", "/api/admin/audit?limit=100"];
    for (const url of adminGets) bodies.push((await as(admin).get(url).expect(200)).text);
    bodies.push((await as(user).get("/api/admin/providers").expect(403)).text);

    for (const b of bodies) {
      expect(b).not.toContain(CANARY_KEY);
      expect(b).not.toContain("canary-value");
      expect(b).not.toContain(apiKey.secret);
    }
    const provider = (await as(admin).get("/api/admin/providers")).body.find((p: { id: string }) => p.id === PROVIDER);
    expect(provider.credentials[0]).toMatchObject({ label: "Canary", last4: CANARY_KEY.slice(-4) });
  });

  test("are stored nowhere in the database in clear", async () => {
    for (const secret of [CANARY_KEY, apiKey.secret]) {
      const like = `%${secret}%`;
      const hits = await sql<{ n: number }>`
        SELECT (SELECT count(*) FROM settings WHERE value::text LIKE ${like})
             + (SELECT count(*) FROM providers WHERE coalesce(base_url, '') LIKE ${like})
             + (SELECT count(*) FROM provider_credentials WHERE ciphertext LIKE ${like} OR label LIKE ${like})
             + (SELECT count(*) FROM api_keys WHERE key_hash LIKE ${like} OR display_hint LIKE ${like})
             + (SELECT count(*) FROM audit_log WHERE data::text LIKE ${like})
             + (SELECT count(*) FROM requests WHERE coalesce(error_code, '') LIKE ${like})
             + (SELECT count(*) FROM request_bodies WHERE request::text LIKE ${like} OR coalesce(response::text, '') LIKE ${like})
             + (SELECT count(*) FROM health_checks WHERE coalesce(error, '') LIKE ${like}) AS n`.execute(db);
      expect(Number(hits.rows[0]!.n)).toBe(0);
    }
  });
});
