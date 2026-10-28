/**
 * Generic HTTP hardening: the error envelope, body parsing and limits, headers and
 * CORS, request ids, authentication failures, id, limit and cursor validation, LIKE
 * escaping in search, and rate limiting. Per-route authorization lives with each domain
 * (admin.int.test.ts for /api/admin).
 */
import request from "supertest";
import { afterEach, describe, expect, test } from "vitest";
import { db } from "../../src/db/kysely";
import { anon, app, as, createUser, unique as uniq } from "./harness";

const ULID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";

const operator = (role: "ADMIN") => createUser({ role });

const ORIGIN = process.env.CORS_ORIGINS?.split(",")[0] ?? "http://localhost:3560";

describe("the error envelope", () => {
  test("unknown routes answer 404 JSON with a request id", async () => {
    const res = await anon().get("/api/no-such-route").expect(404);
    expect(res.headers["content-type"]).toMatch(/application\/json/);
    expect(res.body).toMatchObject({ code: "NOT_FOUND", error: expect.any(String), requestId: expect.any(String) });
    expect(res.headers["x-request-id"]).toBe(res.body.requestId);
  });

  test("malformed JSON is a 400, never a 500", async () => {
    const res = await request(app).post("/api/auth/login").set("Content-Type", "application/json").send("{not json").expect(400);
    expect(res.body.code).toBe("BAD_REQUEST");
  });

  test("a body over 2 MB is a 413 PAYLOAD_TOO_LARGE", async () => {
    const u = await createUser();
    const res = await as(u)
      .post("/api/keys")
      .set("Content-Type", "application/json")
      .send(JSON.stringify({ name: "x".repeat(2_200_000) }))
      .expect(413);
    expect(res.body.code).toBe("PAYLOAD_TOO_LARGE");
  });

  test("validation failures name the fields; unknown fields are refused by strict schemas", async () => {
    const u = await createUser();
    const res = await as(u).patch("/api/users/me").send({ displayName: "x".repeat(200), surprise: true }).expect(400);
    expect(res.body.code).toBe("VALIDATION_FAILED");
    const paths = res.body.details.fields.map((f: { path: string }) => f.path);
    expect(paths.join(" ")).toMatch(/displayName|surprise|body/);
    for (const [url, body] of [
      ["/api/auth/login", { login: u.email, password: "x", admin: true }],
      ["/api/auth/forgot-password", { email: u.email, redirect: "https://elsewhere.example.com" }],
      ["/api/keys", { name: "Key", marginBps: 0 }],
      ["/api/keys", { name: "Key", userId: ULID }],
      ["/api/billing/topups", { currency: "USD", amount: 10, creditMicros: 999_000_000 }],
      ["/api/billing/promo", { code: "LAUNCH10", amountMicros: 1 }],
    ] as const) {
      const r = await as(u).post(url).send(body);
      expect([r.status, r.body.code], url).toEqual([400, "VALIDATION_FAILED"]);
    }
  });

  test("the request id is echoed when well formed and replaced when not", async () => {
    const good = await anon().get("/up").set("X-Request-Id", "trace-abc12345").expect(200);
    expect(good.headers["x-request-id"]).toBe("trace-abc12345");
    const bad = await anon().get("/up").set("X-Request-Id", "bad id\twith spaces").expect(200);
    expect(bad.headers["x-request-id"]).not.toBe("bad id\twith spaces");
    expect(bad.headers["x-request-id"]).toMatch(/^[0-9A-Z]{26}$/);
  });

  test("health and readiness answer", async () => {
    expect((await anon().get("/up").expect(200)).body).toEqual({ ok: true });
    expect((await anon().get("/api/ready").expect(200)).body).toEqual({ ok: true });
  });
});

describe("headers and CORS", () => {
  test("security headers are set and the framework is not advertised", async () => {
    const res = await anon().get("/api/meta").expect(200);
    expect(res.headers["x-powered-by"]).toBeUndefined();
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["content-security-policy"]).toMatch(/default-src 'none'/);
    expect(res.headers["content-security-policy"]).toMatch(/frame-ancestors 'none'/);
  });

  test("a write from a foreign origin is refused before any handler; the app's origin is allowed", async () => {
    const refused = await request(app).post("/api/auth/logout").set("Origin", "https://attacker.example.com").expect(403);
    expect(refused.body.code).toBe("CORS_ORIGIN_DENIED");
    const allowed = await request(app).post("/api/auth/logout").set("Origin", ORIGIN);
    expect(allowed.status).not.toBe(403);
    expect(allowed.headers["access-control-allow-origin"]).toBe(ORIGIN);
    const preflight = await request(app).options("/api/users/me").set("Origin", "https://attacker.example.com").set("Access-Control-Request-Method", "PATCH");
    expect(preflight.headers["access-control-allow-origin"]).toBeUndefined();
    // An operator's write from elsewhere is refused just the same.
    const admin = await operator("ADMIN");
    const u = await createUser();
    expect((await as(admin).post(`/api/admin/users/${u.id}/ban`).set("Origin", "https://attacker.example.com").send({ reason: "Forged" }).expect(403)).body.code).toBe("CORS_ORIGIN_DENIED");
    expect((await db.selectFrom("users").select("status").where("id", "=", u.id).executeTakeFirstOrThrow()).status).toBe("ACTIVE");
  });

  test("private downloads are never cacheable by a proxy", async () => {
    const u = await createUser();
    const res = await as(u).get("/api/users/me/export").expect(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    const created = await as(u).post("/api/keys").send({ name: "Fresh" }).expect(201);
    expect(created.headers["cache-control"]).toBe("no-store");
    expect((await as(u).get("/api/billing/wallet").expect(200)).headers["cache-control"]).toBe("no-store");
    expect((await as(u).get("/api/catalog").expect(200)).headers["cache-control"]).toBe("private, no-store");
  });
});

describe("authentication failures", () => {
  test("missing, garbage and stale tokens", async () => {
    expect((await anon().get("/api/users/me").expect(401)).body.code).toBe("UNAUTHENTICATED");
    expect((await request(app).get("/api/users/me").set("Authorization", "Bearer ").expect(401)).body.code).toBe("UNAUTHENTICATED");
    expect((await request(app).get("/api/users/me").set("Authorization", "Bearer not.a.token").expect(401)).body.code).toBe("TOKEN_INVALID");
    expect((await request(app).get("/api/users/me").set("Authorization", "Basic dXNlcjpwYXNz").expect(401)).body.code).toBe("UNAUTHENTICATED");
    const u = await createUser();
    await db
      .updateTable("users")
      .set((eb) => ({ token_version: eb("token_version", "+", 1) }))
      .where("id", "=", u.id)
      .execute();
    expect((await as(u).get("/api/users/me").expect(401)).body.code).toBe("TOKEN_INVALID");
  });

  test("a bad token on a public route is ignored, not rejected", async () => {
    await request(app).get("/api/meta").set("Authorization", "Bearer garbage").expect(200);
  });

  test("a deactivated account cannot use its token", async () => {
    const u = await createUser();
    await db.updateTable("users").set({ status: "DEACTIVATED" }).where("id", "=", u.id).execute();
    expect((await as(u).get("/api/users/me").expect(403)).body.code).toBe("ACCOUNT_DEACTIVATED");
  });
});

describe("ids, limits and cursors", () => {
  test("malformed ids are a 400 VALIDATION_FAILED, never a database error", async () => {
    const admin = await operator("ADMIN");
    for (const url of ["/api/admin/users/not-an-id", "/api/admin/users/123", "/api/billing/topups/x", "/api/billing/topups/x/receipt.pdf", "/api/usage/requests/x", "/api/admin/users/%27%20OR%201%3D1", "/api/usage/requests/%27%20OR%201%3D1"]) {
      const res = await as(admin).get(url);
      expect(res.status, url).toBe(400);
      expect(res.body.code, url).toBe("VALIDATION_FAILED");
    }
  });

  test("a well formed id that does not exist is a 404", async () => {
    const admin = await operator("ADMIN");
    expect((await as(admin).get(`/api/admin/users/${ULID}`)).status).toBe(404);
    expect((await as(admin).get(`/api/billing/topups/${ULID}`)).status).toBe(404);
    expect((await as(admin).get(`/api/usage/requests/req_${ULID}`)).status).toBe(404);
    expect((await as(admin).patch(`/api/keys/${ULID}`).send({ name: "x" })).status).toBe(404);
  });

  test("page limits are bounded", async () => {
    const u = await createUser();
    const admin = await operator("ADMIN");
    for (const limit of ["0", "51", "1000", "-1", "abc"]) {
      expect((await as(u).get(`/api/usage/requests?limit=${limit}`)).status, limit).toBe(400);
    }
    await as(u).get("/api/usage/requests?limit=50").expect(200);
    expect((await as(u).get("/api/billing/ledger?limit=51")).status).toBe(400);
    expect((await as(admin).get("/api/admin/users?limit=101")).status).toBe(400);
    await as(admin).get("/api/admin/topups?limit=100").expect(200);
  });

  test("tampered cursors are a 400 INVALID_CURSOR on every kind of list", async () => {
    const u = await createUser();
    const admin = await operator("ADMIN");
    const forged = [Buffer.from("not json").toString("base64url"), Buffer.from(JSON.stringify(["2026-01-01T00:00:00.000Z", "'; DROP TABLE users; --"])).toString("base64url"), Buffer.from(JSON.stringify([{}, 1])).toString("base64url"), "%%%"];
    const lists: [typeof u, string][] = [
      [u, "/api/usage/requests"],
      [u, "/api/billing/ledger"],
      [u, "/api/billing/topups"],
      [admin, "/api/admin/users"],
      [admin, "/api/admin/topups"],
      [admin, "/api/admin/audit"],
    ];
    for (const [who, url] of lists) {
      for (const c of forged) {
        const res = await as(who).get(`${url}?cursor=${encodeURIComponent(c)}`);
        expect(res.status, `${url} ${c}`).toBe(400);
        expect(["INVALID_CURSOR", "VALIDATION_FAILED"], `${url} ${c}`).toContain(res.body.code);
      }
    }
  });

  test("a real cursor round-trips", async () => {
    const admin = await operator("ADMIN");
    const marker = uniq("pager");
    for (let i = 0; i < 3; i++) await createUser({ displayName: `Pager ${marker} ${i}` });
    const first = (await as(admin).get(`/api/admin/users?q=${marker}&limit=2`).expect(200)).body;
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = (await as(admin).get(`/api/admin/users?q=${marker}&limit=2&cursor=${encodeURIComponent(first.nextCursor)}`).expect(200)).body;
    expect(second.items).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    expect(new Set([...first.items, ...second.items].map((r: { id: string }) => r.id)).size).toBe(3);
  });
});

describe("user text never becomes query syntax", () => {
  test("LIKE wildcards and query syntax are matched literally in search", async () => {
    const admin = await operator("ADMIN");
    await createUser({ displayName: `Wild ${uniq("w")}` });
    for (const q of ["%", "_", "%%", "\\", "a & b | !c", "':*", "((", "<->", "!"]) {
      for (const url of ["/api/admin/users"]) {
        const res = await as(admin).get(`${url}?q=${encodeURIComponent(q)}&limit=50`);
        expect(res.status, `${url} ${q}`).toBe(200);
        if (url === "/api/admin/users" && ["%", "_", "%%", "\\"].includes(q)) {
          for (const row of res.body.items as { displayName: string; username: string; email: string }[]) expect(`${row.displayName} ${row.username} ${row.email}`, q).toContain(q);
        }
      }
    }
  });
});

describe("rate limits", () => {
  afterEach(() => {
    delete process.env.RATE_LIMITS;
    delete process.env.RATE_LIMIT_STORE;
  });

  test("an IP-keyed limit answers 429 with Retry-After once spent; another IP has its own budget", async () => {
    process.env.RATE_LIMITS = "on";
    process.env.RATE_LIMIT_STORE = "memory";
    const ip = "198.51.100.77";
    let last = 0;
    let retryAfter: string | undefined;
    for (let i = 0; i < 11; i++) {
      const res = await request(app).post("/api/auth/login").set("X-Forwarded-For", ip).send({ login: `nobody-${uniq("n")}@example.com`, password: "wrong-password-123" });
      last = res.status;
      retryAfter = res.headers["retry-after"];
    }
    expect(last).toBe(429);
    expect(Number(retryAfter)).toBeGreaterThan(0);
    const other = await request(app).post("/api/auth/login").set("X-Forwarded-For", "198.51.100.78").send({ login: `nobody-${uniq("n")}@example.com`, password: "wrong-password-123" });
    expect(other.status).toBe(401);
  });
});
