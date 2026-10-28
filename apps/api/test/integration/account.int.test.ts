/**
 * Your account: GET/PATCH /users/me, sessions, the data export (your keys, ledger, top-ups
 * and transcripts, never anyone else's) and account deletion with its grace period.
 */
import { describe, expect, test } from "vitest";
import { db } from "../../src/db/kysely";
import { DELETION_GRACE_DAYS } from "../../src/services/account.service";
import { anon, as, createKey, createUser, gw, PASSWORD, requestRow, type TestUser } from "./harness";

/** The export endpoint streams JSON as an attachment; buffer it as text. */
async function exportOf(user: TestUser): Promise<Record<string, any>> {
  const res = await as(user)
    .get("/api/users/me/export")
    .buffer(true)
    .parse((r, cb) => {
      let data = "";
      r.setEncoding("utf8");
      r.on("data", (c: string) => (data += c));
      r.on("end", () => cb(null, data));
    });
  expect(res.status).toBe(200);
  expect(res.headers["content-type"]).toMatch(/application\/json/);
  expect(res.headers["content-disposition"]).toBe(`attachment; filename="${user.username}-export.json"`);
  expect(res.headers["cache-control"]).toBe("no-store");
  return JSON.parse(res.body as string);
}

describe("your account", () => {
  test("GET /me: identity and status, no secrets", async () => {
    const u = await createUser({ displayName: "Morgan Example" });
    const me = (await as(u).get("/api/users/me").expect(200)).body;
    expect(me).toEqual({
      id: u.id,
      username: u.username,
      email: u.email,
      displayName: "Morgan Example",
      role: "USER",
      status: "ACTIVE",
      emailVerified: true,
      totpEnabled: false,
      deletionRequestedAt: null,
      suspendedUntil: null,
      canOpenAdmin: false,
    });
    expect(JSON.stringify(me)).not.toMatch(/password|totp_secret|token_version/);
    await anon().get("/api/users/me").expect(401);
  });

  test("display names are cleaned of emails, phone numbers and links; nothing name-like is a 400", async () => {
    const u = await createUser();
    const res = await as(u).patch("/api/users/me").send({ displayName: "Jordan Sample jordan@example.com +1 (555) 010-2233 https://example.com/me" }).expect(200);
    expect(res.body.displayName).toBe("Jordan Sample");
    const bad = await as(u).patch("/api/users/me").send({ displayName: "+1 555 010 2233" }).expect(400);
    expect(bad.body.code).toBe("DISPLAY_NAME_INVALID");
    expect((await as(u).get("/api/users/me").expect(200)).body.displayName).toBe("Jordan Sample");
  });

  test("the patch is strict: unknown keys and identity fields are rejected", async () => {
    const u = await createUser();
    for (const body of [{ role: "ADMIN" }, { email: "other@example.com" }, { id: "01ARZ3NDEKTSV4RRFFQ69G5FAV" }, { status: "ACTIVE" }, { username: "someone-else" }]) {
      const res = await as(u).patch("/api/users/me").send(body).expect(400);
      expect(res.body.code).toBe("VALIDATION_FAILED");
    }
    const row = await db.selectFrom("users").select(["role", "email"]).where("id", "=", u.id).executeTakeFirstOrThrow();
    expect(row).toEqual({ role: "USER", email: u.email });
  });

  test("suspended accounts can read but not edit", async () => {
    const u = await createUser({ status: "SUSPENDED" });
    const me = await as(u).get("/api/users/me").expect(200);
    expect(me.body.suspendedUntil).toEqual(expect.any(String));
    const res = await as(u).patch("/api/users/me").send({ displayName: "Changed Name" }).expect(403);
    expect(res.body.code).toBe("ACCOUNT_RESTRICTED");
  });

  test("a suspension that has run out is lifted on the next request", async () => {
    const u = await createUser({ status: "SUSPENDED" });
    await db.updateTable("users").set({ suspended_until: new Date(Date.now() - 1000) }).where("id", "=", u.id).execute();
    await as(u).patch("/api/users/me").send({ displayName: "Free Again" }).expect(200);
  });
});

describe("sessions", () => {
  test("sessions are listed and revocable, only by their owner", async () => {
    const u = await createUser();
    await anon().post("/api/auth/login").set("User-Agent", "TestAgent/1").send({ login: u.email, password: PASSWORD }).expect(200);
    const list = await as(u).get("/api/users/me/sessions").set("User-Agent", "TestAgent/1").expect(200);
    expect(list.body).toHaveLength(1);
    expect(list.body[0]).toMatchObject({ userAgent: "TestAgent/1" });
    expect(JSON.stringify(list.body)).not.toMatch(/token/i);
    const other = await createUser();
    await as(other).delete(`/api/users/me/sessions/${list.body[0].id}`).expect(404);
    await as(u).delete(`/api/users/me/sessions/${list.body[0].id}`).expect(204);
    expect((await as(u).get("/api/users/me/sessions").expect(200)).body).toHaveLength(0);
    await as(u).delete(`/api/users/me/sessions/${list.body[0].id}`).expect(404);
    await as(u).delete("/api/users/me/sessions/not-an-id").expect(400);
  });
});

describe("export", () => {
  test("contains your keys (without secrets), ledger, top-ups and request metadata, never another account's; audited", async () => {
    const u = await createUser({ balanceMicros: 1_000_000 });
    const other = await createUser({ balanceMicros: 1_000_000 });
    const key = await createKey(u, { name: "Exported key" });
    const row = await requestRow(await gw(key.secret).post("/v1/chat/completions").send({ model: "stub-chat", max_tokens: 10, messages: [{ role: "user", content: "export me" }] }));
    await db.insertInto("ledger").values({ id: row.id.slice(4), user_id: u.id, type: "GRANT", amount_micros: 1, balance_after_micros: 1, ref_type: "test", ref_id: row.id, description: "Test grant" }).execute();
    await as(u).post("/api/billing/topups").send({ currency: "USD", amount: 10 }).expect(201);
    const theirKey = await createKey(other, { name: "Their key" });
    const theirs = await requestRow(await gw(theirKey.secret).post("/v1/chat/completions").send({ model: "stub-chat", max_tokens: 10, messages: [{ role: "user", content: "theirs" }] }));

    const data = await exportOf(u);
    expect(Object.keys(data)).toEqual(["exportedAt", "account", "apiKeys", "ledger", "topups", "requests"]);
    expect(data.account).toMatchObject({ id: u.id, email: u.email });
    expect(data.apiKeys).toEqual([expect.objectContaining({ id: key.id, name: "Exported key" })]);
    expect(data.requests).toEqual([expect.objectContaining({ id: row.id, model_id: "stub-chat" })]);
    expect(data.topups).toHaveLength(1);
    expect(data.ledger.map((e: { type: string }) => e.type)).toEqual(expect.arrayContaining(["USAGE", "GRANT"]));
    const text = JSON.stringify(data);
    expect(text).not.toContain(key.secret);
    expect(text).not.toContain(other.email);
    expect(text).not.toContain(theirs.id);
    expect(text).not.toContain("Their key");
    expect(text).not.toMatch(/password_hash|totp_secret|key_hash/);

    const audit = await db.selectFrom("audit_log").select("actor_id").where("action", "=", "user.export").where("entity_id", "=", u.id).execute();
    expect(audit).toEqual([{ actor_id: u.id }]);
    await anon().get("/api/users/me/export").expect(401);
  });

  test("an account with nothing yet exports empty sections", async () => {
    const u = await createUser();
    const data = await exportOf(u);
    expect(data).toMatchObject({ apiKeys: [], ledger: [], topups: [], requests: [] });
  });
});

describe("account deletion", () => {
  test("needs the right password", async () => {
    const u = await createUser();
    expect((await as(u).delete("/api/users/me").send({ password: "not-the-password" }).expect(400)).body.code).toBe("INVALID_CREDENTIALS");
    await as(u).delete("/api/users/me").send({}).expect(400);
    await as(u).delete("/api/users/me").send({ password: PASSWORD, extra: true }).expect(400);
    await as(u).get("/api/users/me").expect(200);
  });

  test("a request signs out everywhere and starts the grace period; signing in again cancels it", async () => {
    const u = await createUser();
    const res = await as(u).delete("/api/users/me").send({ password: PASSWORD }).expect(200);
    const purgeAfter = Date.parse(res.body.purgeAfter);
    expect(Math.abs(purgeAfter - (Date.now() + DELETION_GRACE_DAYS * 86_400_000))).toBeLessThan(60_000);
    expect((await as(u).get("/api/users/me").expect(401)).body.code).toBe("TOKEN_INVALID");
    const row = await db.selectFrom("users").select(["deletion_requested_at", "status"]).where("id", "=", u.id).executeTakeFirstOrThrow();
    expect(row.deletion_requested_at).not.toBeNull();
    expect(row.status).toBe("ACTIVE");

    const login = await anon().post("/api/auth/login").send({ login: u.email, password: PASSWORD }).expect(200);
    expect(login.body.user.deletionRequestedAt).toBeNull();
    const audit = await db.selectFrom("audit_log").select("action").where("entity_id", "=", u.id).where("action", "in", ["user.deletion_requested", "user.deletion_cancelled"]).orderBy("created_at").execute();
    expect(audit.map((a) => a.action)).toEqual(["user.deletion_requested", "user.deletion_cancelled"]);
  });

  test("the purge job erases accounts whose grace period is over: keys revoked, logged bodies gone", async () => {
    const u = await createUser({ balanceMicros: 1_000_000 });
    const key = await createKey(u, { logBodies: true });
    const row = await requestRow(await gw(key.secret).post("/v1/chat/completions").send({ model: "stub-chat", max_tokens: 10, messages: [{ role: "user", content: "soon purged" }] }));
    await as(u).delete("/api/users/me").send({ password: PASSWORD }).expect(200);
    await db.updateTable("users").set({ deletion_requested_at: new Date(Date.now() - (DELETION_GRACE_DAYS + 1) * 86_400_000) }).where("id", "=", u.id).execute();
    const { getHandler } = await import("../../src/jobs/registry");
    await getHandler("maintenance.purge-accounts")!({});
    expect((await db.selectFrom("users").select("status").where("id", "=", u.id).executeTakeFirstOrThrow()).status).toBe("DEACTIVATED");
    const user = await db.selectFrom("users").select(["email", "display_name"]).where("id", "=", u.id).executeTakeFirstOrThrow();
    expect(user.email).not.toBe(u.email);
    expect(user.display_name).toBe("Deleted user");
    expect((await db.selectFrom("api_keys").select("status").where("id", "=", key.id).executeTakeFirstOrThrow()).status).toBe("REVOKED");
    expect(await db.selectFrom("request_bodies").select("request_id").where("request_id", "=", row.id).executeTakeFirst()).toBeUndefined();
    expect((await gw(key.secret).post("/v1/chat/completions").send({ model: "stub-chat", messages: [{ role: "user", content: "x" }] })).status).toBe(401);
  });

});
