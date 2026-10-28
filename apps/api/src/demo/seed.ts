/**
 * Demo data so a fresh install has something to look at. Run with `make demo` (or
 * `node dist/cli.js demo:seed`).
 *
 *   - the starter catalogue plus the local stubs (every endpoint works with no keys)
 *   - an admin and four developers, each with keys, top-ups, a signup credit and thirty
 *     days of traffic across the stub models; one account on a partner margin and one
 *     on a higher rate-limit tier, a promo code, and a failed and a refunded top-up
 *   - every request has its USAGE ledger entry, so balances, ledgers and usage agree
 *
 * The main developer's API key is printed once (only its hash is stored). Refuses to run
 * with NODE_ENV=production. If the demo admin exists it prints the logins and exits.
 */
import crypto from "node:crypto";
import { config } from "../core/config";
import { newId } from "../core/ids";
import { db, type Executor } from "../db/kysely";
import { closeRedis } from "../integrations/redis";
import { closeQueues } from "../jobs/registry";
import { hashApiKey, keyHint, newApiKey } from "../security/api-keys";
import { hashPassword } from "../security/passwords";
import { ensureStarterCatalog } from "./catalog";

const ADMIN_EMAIL = "admin@example.com";
const DAY = 86_400_000;

const PEOPLE = [
  { email: "priya.nair@example.com", username: "priya-nair", name: "Priya Nair", main: true, traffic: 60 },
  { email: "leo.marquez@example.com", username: "leo-marquez", name: "Leo Marquez", traffic: 25, partner: true },
  { email: "sam.kowalski@example.com", username: "sam-kowalski", name: "Sam Kowalski", traffic: 35, scale: true },
  { email: "amara.okafor@example.com", username: "amara-okafor", name: "Amara Okafor", traffic: 10 },
];

/** Model, endpoint and the route cost the demo bills at (matches demo/catalog.ts). */
const MIX = [
  { model: "stub-chat", endpoint: "/v1/chat/completions", provider: "stub", upstream: "stub-chat", input: 500_000, output: 1_500_000, weight: 6 },
  { model: "stub-claude", endpoint: "/v1/messages", provider: "stub-anthropic", upstream: "stub-claude", input: 800_000, output: 4_000_000, weight: 3 },
  { model: "stub-failover", endpoint: "/v1/chat/completions", provider: "stub", upstream: "stub-chat", input: 500_000, output: 1_500_000, weight: 1 },
  { model: "stub-embed", endpoint: "/v1/embeddings", provider: "stub", upstream: "stub-embed", input: 20_000, output: 0, weight: 2 },
];

function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(20261028);
const pick = <T extends { weight: number }>(items: T[]): T => {
  let r = rand() * items.reduce((s, i) => s + i.weight, 0);
  for (const i of items) if ((r -= i.weight) < 0) return i;
  return items[items.length - 1]!;
};

const withMargin = (micros: number, bps: number) => Math.ceil((micros * (10_000 + bps)) / 10_000);

async function insertBatches<T>(exec: Executor, table: "requests" | "ledger", rows: T[]): Promise<void> {
  for (let i = 0; i < rows.length; i += 500) await exec.insertInto(table).values(rows.slice(i, i + 500) as never).execute();
}

export async function seedDemo(): Promise<void> {
  if (config.NODE_ENV === "production") throw new Error("demo:seed refuses to run in production");
  const password = config.DEMO_PASSWORD ?? crypto.randomBytes(9).toString("base64url");
  if (await db.selectFrom("users").select("id").where("email", "=", ADMIN_EMAIL).executeTakeFirst()) {
    printLogins(config.DEMO_PASSWORD ? password : null, null);
    return;
  }
  await ensureStarterCatalog(db, { includeStub: true });
  const hash = await hashPassword(password);
  const now = Date.now();
  const defaultMargin = 2_000;
  await db.insertInto("settings").values({ key: "app", value: JSON.stringify({ defaultMarginBps: defaultMargin, supportEmail: "support@example.com" }) }).onConflict((oc) => oc.column("key").doNothing()).execute();

  const scaleTier = newId();
  await db.insertInto("limit_tiers").values({ id: scaleTier, name: "Scale", rpm: 600, tpm: 2_000_000, concurrency: 32 }).execute();
  await db.insertInto("promo_codes").values({ id: newId(), code: "LAUNCH10", amount_micros: 10_000_000, max_redemptions: 500, expires_at: new Date(now + 60 * DAY) }).execute();

  const adminId = newId();
  await db.insertInto("users").values({ id: adminId, email: ADMIN_EMAIL, username: "admin", display_name: "Morgan Ellis", password_hash: hash, role: "ADMIN", status: "ACTIVE", email_verified_at: new Date(now - 40 * DAY), created_at: new Date(now - 40 * DAY) }).execute();
  await db.insertInto("wallets").values({ user_id: adminId }).execute();

  const routes = new Map((await db.selectFrom("model_routes").select(["id", "model_id", "upstream_model"]).execute()).map((r) => [`${r.model_id}:${r.upstream_model}`, r.id]));
  let mainKey: string | null = null;

  for (const [i, p] of PEOPLE.entries()) {
    const userId = newId();
    const joined = now - (34 - i) * DAY;
    const margin = p.partner ? 500 : null;
    await db
      .insertInto("users")
      .values({ id: userId, email: p.email, username: p.username, display_name: p.name, password_hash: hash, role: "USER", status: "ACTIVE", email_verified_at: new Date(joined), created_at: new Date(joined), last_seen_at: new Date(now - i * 3_600_000), margin_bps: margin, limit_tier_id: p.scale ? scaleTier : null })
      .execute();

    // Keys: a production and a staging key, plus a revoked one for the main account.
    const keyIds: string[] = [];
    for (const [k, name] of ["Production", "Staging", ...(p.main ? ["Old laptop"] : [])].entries()) {
      const secret = newApiKey();
      if (p.main && k === 0) mainKey = secret;
      const keyId = newId();
      keyIds.push(keyId);
      await db
        .insertInto("api_keys")
        .values({
          id: keyId,
          user_id: userId,
          name,
          key_hash: hashApiKey(secret),
          display_hint: keyHint(secret),
          status: name === "Old laptop" ? "REVOKED" : "ACTIVE",
          revoked_at: name === "Old laptop" ? new Date(now - 10 * DAY) : null,
          allowed_models: name === "Staging" ? ["stub-chat", "stub-embed"] : [],
          monthly_budget_micros: name === "Staging" ? 5_000_000 : null,
          log_bodies: p.main && name === "Staging",
          created_at: new Date(joined + DAY),
          last_used_at: name === "Old laptop" ? new Date(now - 12 * DAY) : new Date(now - 3_600_000),
        })
        .execute();
    }

    // Money in: signup credit, then top-ups (USD and INR, all through the stub gateway).
    const events: { at: number; type: "SIGNUP" | "TOPUP" | "USAGE" | "REFUND"; amount: number; refType: string; refId: string; description: string }[] = [];
    events.push({ at: joined, type: "SIGNUP", amount: 1_000_000, refType: "signup", refId: userId, description: "Welcome credit" });
    const topups = p.main
      ? [
          { days: 30, currency: "USD", minor: 2_000, rate: null },
          { days: 12, currency: "INR", minor: 250_000, rate: 85.12 },
        ]
      : [{ days: 31 - i, currency: i % 2 ? "INR" : "USD", minor: i % 2 ? 150_000 : 1_500, rate: i % 2 ? 85.3 : null }];
    for (const t of topups) {
      const topupId = newId();
      const credit = t.currency === "USD" ? t.minor * 10_000 : Math.floor((t.minor * 10_000) / t.rate!);
      const at = now - t.days * DAY;
      await db
        .insertInto("topups")
        .values({ id: topupId, user_id: userId, gateway: "STUB", currency: t.currency, amount_minor: t.minor, tax_minor: 0, total_minor: t.minor, fx_inr_per_usd: t.rate === null ? null : String(t.rate), credit_micros: credit, gateway_order_id: `stub_${topupId}`, gateway_payment_id: `stub_pay_${topupId}`, status: "PAID", created_at: new Date(at), paid_at: new Date(at + 60_000) })
        .execute();
      events.push({ at: at + 60_000, type: "TOPUP", amount: credit, refType: "topup", refId: topupId, description: t.currency === "INR" ? `Top-up of ₹${(t.minor / 100).toFixed(2)} at ₹${t.rate!.toFixed(4)}/USD` : `Top-up of $${(t.minor / 100).toFixed(2)}` });
    }
    if (p.main) {
      const failed = newId();
      await db.insertInto("topups").values({ id: failed, user_id: userId, gateway: "STUB", currency: "USD", amount_minor: 5_000, total_minor: 5_000, credit_micros: 50_000_000, gateway_order_id: `stub_${failed}`, status: "FAILED", failure_reason: "PAYMENT_FAILED", created_at: new Date(now - 20 * DAY) }).execute();
    }

    // Traffic: requests on most days, billed at the route cost plus the margin in force.
    const requestRows: Record<string, unknown>[] = [];
    for (let d = 30; d >= 0; d--) {
      if (now - d * DAY < joined + DAY) continue;
      const count = Math.round(p.traffic * (0.5 + rand()) * (d % 7 === 0 || d % 7 === 6 ? 0.4 : 1));
      for (let n = 0; n < count; n++) {
        // Most traffic on the production key; the staging key may only call stub-chat and stub-embed.
        const onStaging = rand() >= 0.8;
        const m = pick(onStaging ? MIX.filter((x) => x.model === "stub-chat" || x.model === "stub-embed") : MIX);
        const at = now - d * DAY - Math.floor(rand() * 20 * 3_600_000) - 60_000;
        if (at > now - 60_000) continue;
        const failed = rand() < 0.02;
        const input = m.model === "stub-embed" ? 200 + Math.floor(rand() * 2_000) : 300 + Math.floor(rand() * 3_000);
        const output = m.model === "stub-embed" || failed ? 0 : 80 + Math.floor(rand() * 900);
        const cost = failed ? 0 : Math.ceil((input * m.input + output * m.output) / 1_000_000);
        const bps = margin ?? defaultMargin;
        const price = failed ? 0 : Math.ceil((input * withMargin(m.input, bps) + output * withMargin(m.output, bps)) / 1_000_000);
        const requestId = `req_${newId()}`;
        const stream = m.endpoint !== "/v1/embeddings" && rand() < 0.6;
        const latency = (m.model === "stub-embed" ? 120 : 600) + Math.floor(rand() * (m.model === "stub-claude" ? 2_400 : 1_400));
        requestRows.push({
          id: requestId,
          user_id: userId,
          api_key_id: keyIds[onStaging ? 1 : 0],
          model_id: m.model,
          route_id: routes.get(`${m.model}:${m.upstream}`) ?? null,
          provider_id: m.provider,
          endpoint: m.endpoint,
          stream,
          status_code: failed ? 502 : 200,
          error_code: failed ? "upstream_unavailable" : null,
          attempts: m.model === "stub-failover" ? 2 : 1,
          input_tokens: failed ? 0 : input,
          output_tokens: output,
          cached_tokens: 0,
          units: 0,
          estimated: false,
          latency_ms: latency,
          ttfb_ms: stream ? Math.floor(latency * 0.25) : null,
          cost_micros: cost,
          price_micros: price,
          margin_bps: bps,
          ip: "203.0.113.10",
          created_at: new Date(at),
        });
        if (price > 0) events.push({ at, type: "USAGE", amount: -price, refType: "request", refId: requestId, description: `${m.model} via ${m.endpoint}` });
      }
    }
    await insertBatches(db, "requests", requestRows);

    // The ledger in time order with running balances; the wallet ends at the last one.
    events.sort((a, b) => a.at - b.at);
    let balance = 0;
    const ledgerRows = events.map((e) => {
      balance += e.amount;
      return { id: newId(), user_id: userId, type: e.type, amount_micros: e.amount, balance_after_micros: balance, ref_type: e.refType, ref_id: e.refId, description: e.description, created_at: new Date(e.at) };
    });
    await insertBatches(db, "ledger", ledgerRows);
    await db.insertInto("wallets").values({ user_id: userId, balance_micros: balance }).execute();
  }

  // A few health probes so the health page is not empty.
  // Only the stub routes: real providers have no credential in the demo, so they have never been probed.
  for (const [routeKey, routeId] of routes) {
    if (!routeKey.startsWith("stub")) continue;
    const failing = routeKey.endsWith(":fail-503");
    for (let k = 0; k < 6; k++) await db.insertInto("health_checks").values({ id: newId(), route_id: routeId, ok: !failing, latency_ms: 40 + Math.floor(rand() * 60), error: failing ? "The provider answered 503" : null, checked_at: new Date(now - k * 5 * 60_000) }).execute();
  }

  printLogins(password, mainKey);
  await closeQueues();
  await closeRedis();
}

function printLogins(password: string | null, apiKey: string | null): void {
  const lines = [
    "",
    "  Demo accounts (all share one password):",
    `    admin      ${ADMIN_EMAIL}`,
    ...PEOPLE.map((p) => `    ${p.main ? "main     " : "developer"}  ${p.email}`),
    password ? `  Password:  ${password}` : "  The password was printed when the demo was first seeded (DEMO_PASSWORD in deploy/compose/.env).",
    ...(apiKey ? ["", `  API key of ${PEOPLE[0]!.email} (shown once, only its hash is stored):`, `    ${apiKey}`] : []),
    "",
  ];
  process.stdout.write(`${lines.join("\n")}\n`);
}
