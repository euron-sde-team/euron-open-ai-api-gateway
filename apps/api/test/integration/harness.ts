/**
 * Test harness: the app in-process, fast user creation with money in the wallet, the
 * starter catalogue (with the local stubs), API keys, and helpers for the stubs.
 *
 *   const ada = await createUser({ balanceMicros: 5_000_000 });   // ACTIVE, verified, $5
 *   const key = await createKey(ada);                               // a gw- secret
 *   const res = await gw(key).post("/v1/chat/completions").send({ model: "stub-chat", messages });
 *
 * Jobs run inline after commit (JOBS_MODE=inline).
 */
import type { AppSettings } from "@open-gateway/types";
import request from "supertest";
import { beforeAll } from "vitest";
import { createApp } from "../../src/app";
import { newId } from "../../src/core/ids";
import { db, initDbTypes } from "../../src/db/kysely";
import { ensureStarterCatalog } from "../../src/demo/catalog";
import { clearCatalogCache } from "../../src/gateway/catalog";
import { redis } from "../../src/integrations/redis";
import { registerAllJobs } from "../../src/jobs";
import { hashPassword } from "../../src/security/passwords";
import { signAccessToken } from "../../src/security/tokens";
import { clearSettingsCache, saveSettings } from "../../src/services/settings.service";

registerAllJobs();
export const app = createApp();

// enum[] and citext[] columns parse as arrays only after this lookup, as at boot.
beforeAll(async () => {
  await initDbTypes();
  await ensureStarterCatalog(db, { includeStub: true });
  clearCatalogCache();
});

export const PASSWORD = "correct-horse-battery-staple";
let passwordHash: string | null = null;

export interface TestUser {
  id: string;
  email: string;
  username: string;
  displayName: string;
  token: string;
}

let counter = 0;
export function unique(prefix: string): string {
  counter += 1;
  return `${prefix}${Date.now().toString(36)}${process.pid.toString(36)}${counter}`.slice(0, 38);
}

export type Role = "USER" | "ADMIN";

/** Insert an ACTIVE, verified user with a wallet, and mint an access token. */
export async function createUser(over: { role?: Role; status?: "ACTIVE" | "SUSPENDED" | "BANNED"; displayName?: string; username?: string; balanceMicros?: number; marginBps?: number | null } = {}): Promise<TestUser> {
  passwordHash ??= await hashPassword(PASSWORD);
  const username = over.username ?? unique("u");
  const email = `${username}@example.com`;
  const row = await db
    .insertInto("users")
    .values({
      id: newId(),
      email,
      username,
      display_name: over.displayName ?? `User ${username}`,
      password_hash: passwordHash,
      role: over.role ?? "USER",
      status: over.status ?? "ACTIVE",
      email_verified_at: new Date(),
      margin_bps: over.marginBps ?? null,
      ...(over.status === "SUSPENDED" ? { suspended_until: new Date(Date.now() + 86_400_000) } : {}),
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  await db.insertInto("wallets").values({ user_id: row.id, balance_micros: over.balanceMicros ?? 0 }).execute();
  return { id: row.id, email, username, displayName: row.display_name, token: signAccessToken(row.id, row.token_version) };
}

/** A supertest agent that sends the user's bearer token on every request. */
export function as(user: TestUser | null) {
  const agent = request(app);
  const auth = (r: request.Test) => (user ? r.set("Authorization", `Bearer ${user.token}`) : r);
  return {
    get: (url: string) => auth(agent.get(url)),
    post: (url: string) => auth(agent.post(url)),
    put: (url: string) => auth(agent.put(url)),
    patch: (url: string) => auth(agent.patch(url)),
    delete: (url: string) => auth(agent.delete(url)),
  };
}

export const anon = () => as(null);

// ─── Keys and the data plane ────────────────────────────────────────────────

/** Create a key through the console API; returns the secret and the key id. */
export async function createKey(user: TestUser, body: Record<string, unknown> = {}): Promise<{ secret: string; id: string }> {
  const res = await as(user).post("/api/keys").send({ name: "Test key", ...body });
  if (res.status !== 201) throw new Error(`create key: ${res.status} ${JSON.stringify(res.body)}`);
  return { secret: res.body.secret, id: res.body.id };
}

/** A supertest agent for /v1 with an API key (Bearer by default, or x-api-key). */
export function gw(secret: string, how: "bearer" | "x-api-key" = "bearer") {
  const agent = request(app);
  const auth = (r: request.Test) => (how === "bearer" ? r.set("Authorization", `Bearer ${secret}`) : r.set("x-api-key", secret));
  return {
    get: (url: string) => auth(agent.get(url)),
    post: (url: string) => auth(agent.post(url)),
  };
}

export async function walletOf(userId: string): Promise<{ balance: number; reserved: number }> {
  const w = await db.selectFrom("wallets").select(["balance_micros", "reserved_micros"]).where("user_id", "=", userId).executeTakeFirstOrThrow();
  return { balance: Number(w.balance_micros), reserved: Number(w.reserved_micros) };
}

/**
 * The request row of a /v1 response. Settlement commits just after the response is
 * written (the caller is never kept waiting for the ledger), so this polls briefly.
 */
export async function requestRow(res: { headers: Record<string, string> }) {
  const id = res.headers["x-request-id"]!;
  return waitFor(() => db.selectFrom("requests").selectAll().where("id", "=", id).executeTakeFirst(), 5_000, 20);
}

/** Empty the rate-limit, breaker and key caches so tests do not see each other's counters. */
export async function resetGatewayState(): Promise<void> {
  const r = redis();
  for (const pattern of ["rl:*", "cb:*", "gwkey:*", "gwspend:*", "gwslot:*"]) {
    let cursor = "0";
    do {
      const [next, keys] = await r.scan(cursor, "MATCH", pattern, "COUNT", 500);
      cursor = next;
      if (keys.length) await r.del(...keys);
    } while (cursor !== "0");
  }
  clearCatalogCache();
}

/** Parse an SSE body into its data payloads (and event names). */
export function sseEvents(text: string): { event: string | null; data: string }[] {
  return text
    .split("\n\n")
    .filter((b) => b.trim())
    .map((block) => {
      const event = /^event: (.*)$/m.exec(block)?.[1] ?? null;
      const data = block
        .split("\n")
        .filter((l) => l.startsWith("data: "))
        .map((l) => l.slice(6))
        .join("\n");
      return { event, data };
    });
}

/** Price of token usage at route cost and margin, exactly as the gateway computes it. */
export function priceOf(cost: { input: number; output: number }, usage: { input: number; output: number }, marginBps: number): number {
  const up = (m: number) => (m <= 0 ? 0 : Math.ceil((m * (10_000 + marginBps)) / 10_000));
  return Math.ceil((usage.input * up(cost.input) + usage.output * up(cost.output)) / 1_000_000);
}

// ─── Settings ───────────────────────────────────────────────────────────────

/** Merge a patch into the deployment settings (in-process cache cleared). */
export async function setSettings(patch: Partial<AppSettings>): Promise<void> {
  clearSettingsCache();
  await saveSettings(patch, null);
  clearSettingsCache();
}

/** Back to the defaults. */
export async function resetSettings(): Promise<void> {
  await db.deleteFrom("settings").where("key", "=", "app").execute();
  clearSettingsCache();
}

// ─── Stubs ──────────────────────────────────────────────────────────────────

export function stubsUrl(): string {
  return process.env.STUBS_URL!;
}

export interface StubRequest {
  method: string;
  path: string;
  at: string;
  body: any;
  headers: Record<string, string | null>;
}

/** What the stubs received, newest first. */
export async function stubRequests(): Promise<StubRequest[]> {
  const res = await fetch(`${stubsUrl()}/__/requests`);
  return (await res.json()) as StubRequest[];
}

export async function stubPost<T = any>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${stubsUrl()}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return (await res.json()) as T;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Poll until fn returns something truthy. */
export async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, timeoutMs = 10_000, everyMs = 50): Promise<T> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > until) throw new Error("waitFor timed out");
    await sleep(everyMs);
  }
}
