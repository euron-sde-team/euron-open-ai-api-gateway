/**
 * The /admin control plane outside the catalogue (that is admin-catalog.service.ts):
 * the overview, accounts (status, tier, margin, credits), rate-limit tiers, top-ups,
 * promo codes, settings and integration status. Admins only, ACTIVE accounts only, and
 * every change is audited in the same transaction as the change.
 *
 * Admins never see request bodies or provider secrets: no endpoint returns either.
 */
import type { AdminStats, AdminTopupRow, AdminUserDetail, AdminUserRow, AppSettings, IntegrationStatus, LimitTier, Page, PromoCode, UserRole } from "@open-gateway/types";
import { sql } from "kysely";
import { config, DEV_DEFAULTS, razorpayEnabled, stripeEnabled } from "../core/config";
import { requireAdmin, type Actor, type RequestMeta } from "../core/context";
import { withTransaction } from "../core/effects";
import { badRequest, conflict, forbidden, notFound } from "../core/errors";
import { newId } from "../core/ids";
import { db, type Executor } from "../db/kysely";
import { credit } from "../billing/wallet";
import { invalidateKey, invalidateUserKeys } from "../gateway/auth";
import { loadSummaries } from "../presenters/user.presenter";
import { atKey, decodeTime, olderThan, timePage } from "../repositories/keyset";
import { sessionRepo } from "../repositories/session.repository";
import { userRepo } from "../repositories/user.repository";
import { anonymiseUser, assertNotLastAdmin } from "./account.service";
import { audit } from "./audit.service";
import { refundTopup as refund } from "./billing.service";
import { inrPerUsd } from "./fx.service";
import { clearSettingsCache, getSettings, mergeSettings, saveSettings } from "./settings.service";

const n = (v: unknown) => Number(v ?? 0);
const ms = (v: unknown) => (v === null || v === undefined ? null : Math.round(Number(v)));
const monthStart = () => new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1));

// ─── Overview ───────────────────────────────────────────────────────────────

/**
 * Revenue is what callers were charged (price_micros), cost what the providers charge
 * the platform for the same requests (cost_micros), margin the difference. Failovers
 * are requests that needed more than one attempt, counted against the provider that
 * finally served them.
 */
export async function stats(actor: Actor, from: string, to: string): Promise<AdminStats> {
  requireAdmin(actor);
  const range = (col: string) => sql<boolean>`${sql.ref(col)} >= ${from}::date AND ${sql.ref(col)} < (${to}::date + 1)`;
  const [users, newUsers, active, totals, money, daily, byModel, byProvider] = await Promise.all([
    db.selectFrom("users").select((eb) => eb.fn.countAll<string>().as("n")).where("status", "<>", "DEACTIVATED").executeTakeFirstOrThrow(),
    db.selectFrom("users").select((eb) => eb.fn.countAll<string>().as("n")).where(range("created_at")).executeTakeFirstOrThrow(),
    db.selectFrom("requests").select(sql<string>`count(DISTINCT user_id)`.as("n")).where(range("created_at")).executeTakeFirstOrThrow(),
    db
      .selectFrom("requests")
      .select([sql<string>`count(*)`.as("requests"), sql<string>`count(*) FILTER (WHERE status_code >= 400)`.as("errors"), sql<string>`coalesce(sum(price_micros), 0)`.as("revenue"), sql<string>`coalesce(sum(cost_micros), 0)`.as("cost")])
      .where(range("created_at"))
      .executeTakeFirstOrThrow(),
    db
      .selectFrom("ledger")
      .select([sql<string>`coalesce(sum(amount_micros) FILTER (WHERE type = 'TOPUP'), 0)`.as("topups"), sql<string>`coalesce(sum(amount_micros) FILTER (WHERE type IN ('GRANT', 'PROMO', 'SIGNUP')), 0)`.as("credits")])
      .where(range("created_at"))
      .executeTakeFirstOrThrow(),
    db
      .selectFrom("requests")
      .select([
        sql<string>`to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD')`.as("date"),
        sql<string>`count(*)`.as("requests"),
        sql<string>`count(*) FILTER (WHERE status_code >= 400)`.as("errors"),
        sql<string>`coalesce(sum(price_micros), 0)`.as("revenue"),
        sql<string>`coalesce(sum(cost_micros), 0)`.as("cost"),
      ])
      .where(range("created_at"))
      .groupBy("date")
      .orderBy("date")
      .execute(),
    db
      .selectFrom("requests")
      .select([
        "model_id",
        sql<string>`count(*)`.as("requests"),
        sql<string>`count(*) FILTER (WHERE status_code >= 400)`.as("errors"),
        sql<string>`coalesce(sum(input_tokens), 0)`.as("input"),
        sql<string>`coalesce(sum(output_tokens), 0)`.as("output"),
        sql<string>`coalesce(sum(price_micros), 0)`.as("revenue"),
        sql<string>`coalesce(sum(cost_micros), 0)`.as("cost"),
        sql<string | null>`percentile_cont(0.5) WITHIN GROUP (ORDER BY latency_ms) FILTER (WHERE status_code < 400)`.as("p50"),
        sql<string | null>`percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms) FILTER (WHERE status_code < 400)`.as("p95"),
        sql<string | null>`percentile_cont(0.5) WITHIN GROUP (ORDER BY ttfb_ms) FILTER (WHERE stream AND status_code < 400)`.as("ttfb"),
      ])
      .where(range("created_at"))
      .groupBy("model_id")
      .orderBy("revenue", "desc")
      .limit(100)
      .execute(),
    db
      .selectFrom("requests")
      .select([
        "provider_id",
        sql<string>`count(*)`.as("requests"),
        sql<string>`count(*) FILTER (WHERE status_code >= 400)`.as("errors"),
        sql<string>`count(*) FILTER (WHERE attempts > 1)`.as("failovers"),
        sql<string | null>`percentile_cont(0.5) WITHIN GROUP (ORDER BY latency_ms) FILTER (WHERE status_code < 400)`.as("p50"),
        sql<string | null>`percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms) FILTER (WHERE status_code < 400)`.as("p95"),
      ])
      .where(range("created_at"))
      .where("provider_id", "is not", null)
      .groupBy("provider_id")
      .orderBy("requests", "desc")
      .execute(),
  ]);
  return {
    from,
    to,
    totals: {
      users: n(users.n),
      newUsers: n(newUsers.n),
      activeAccounts: n(active.n),
      requests: n(totals.requests),
      errors: n(totals.errors),
      revenueMicros: n(totals.revenue),
      costMicros: n(totals.cost),
      marginMicros: n(totals.revenue) - n(totals.cost),
      topupsMicros: n(money.topups),
      creditsGrantedMicros: n(money.credits),
    },
    daily: daily.map((d) => ({ date: d.date, requests: n(d.requests), errors: n(d.errors), revenueMicros: n(d.revenue), costMicros: n(d.cost) })),
    byModel: byModel.map((m) => ({
      modelId: m.model_id,
      requests: n(m.requests),
      errors: n(m.errors),
      inputTokens: n(m.input),
      outputTokens: n(m.output),
      revenueMicros: n(m.revenue),
      costMicros: n(m.cost),
      p50LatencyMs: ms(m.p50),
      p95LatencyMs: ms(m.p95),
      p50TtfbMs: ms(m.ttfb),
    })),
    byProvider: byProvider.map((p) => ({ providerId: p.provider_id!, requests: n(p.requests), errors: n(p.errors), failovers: n(p.failovers), p50LatencyMs: ms(p.p50), p95LatencyMs: ms(p.p95) })),
  };
}

// ─── Accounts ───────────────────────────────────────────────────────────────

function userRows(exec: Executor = db) {
  return exec
    .selectFrom("users as u")
    .leftJoin("limit_tiers as t", "t.id", "u.limit_tier_id")
    .leftJoin("wallets as w", "w.user_id", "u.id")
    .select(["u.id", "u.email", "u.status", "u.created_at", "u.last_seen_at", "u.suspended_until", "u.margin_bps", "t.id as tier_id", "t.name as tier_name", "w.balance_micros", "w.reserved_micros"])
    .select(sql<string>`(SELECT coalesce(sum(price_micros), 0) FROM requests r WHERE r.user_id = u.id AND r.created_at >= ${monthStart()})`.as("spent_month"));
}

type UserRowDb = Awaited<ReturnType<ReturnType<typeof userRows>["executeTakeFirstOrThrow"]>>;

async function toAdminRows(rows: UserRowDb[], exec: Executor = db): Promise<AdminUserRow[]> {
  const people = await loadSummaries(
    rows.map((r) => r.id),
    exec,
  );
  return rows.map((r) => ({
    ...people.get(r.id)!,
    email: r.email,
    status: r.status,
    limitTier: r.tier_id ? { id: r.tier_id, name: r.tier_name! } : null,
    createdAt: r.created_at.toISOString(),
    lastSeenAt: r.last_seen_at?.toISOString() ?? null,
    suspendedUntil: r.suspended_until?.toISOString() ?? null,
    balanceMicros: n(r.balance_micros),
    spentThisMonthMicros: n(r.spent_month),
    marginBps: r.margin_bps,
  }));
}

const oneRow = async (id: string, exec: Executor = db) => (await toAdminRows([await userRows(exec).where("u.id", "=", id).executeTakeFirstOrThrow()], exec))[0]!;

export async function listUsers(actor: Actor, q: { q?: string; status?: string; role?: UserRole; tierId?: string; cursor?: string; limit: number }): Promise<Page<AdminUserRow>> {
  requireAdmin(actor);
  let query = userRows().select(atKey("u.created_at"));
  if (q.q?.trim()) query = query.where(sql<boolean>`(u.display_name || ' ' || u.username::text || ' ' || u.email::text) ILIKE ${`%${q.q.trim().replace(/[\\%_]/g, (m) => `\\${m}`)}%`}`);
  if (q.status) query = query.where("u.status", "=", q.status as AdminUserRow["status"]);
  if (q.role) query = query.where("u.role", "=", q.role);
  if (q.tierId) query = query.where("u.limit_tier_id", "=", q.tierId);
  const rows = await query.where(olderThan("u.created_at", "u.id", decodeTime(q.cursor))).orderBy("u.created_at", "desc").orderBy("u.id", "desc").limit(q.limit + 1).execute();
  const page = timePage(rows, q.limit);
  return { items: await toAdminRows(page.items), nextCursor: page.nextCursor };
}

export async function userDetail(actor: Actor, id: string): Promise<AdminUserDetail> {
  requireAdmin(actor);
  const row = await userRows().where("u.id", "=", id).executeTakeFirst();
  if (!row) throw notFound("User not found", "USER_NOT_FOUND");
  const [base] = await toAdminRows([row]);
  const [keys, totals, usage] = await Promise.all([
    db.selectFrom("api_keys").select(["id", "name", "display_hint", "status", "margin_bps", "last_used_at"]).where("user_id", "=", id).orderBy("status").orderBy("created_at", "desc").execute(),
    db
      .selectNoFrom([
        sql<string>`(SELECT count(*) FROM requests WHERE user_id = ${id})`.as("requests"),
        sql<string>`(SELECT coalesce(sum(price_micros), 0) FROM requests WHERE user_id = ${id})`.as("spend"),
        sql<string>`(SELECT coalesce(sum(amount_micros), 0) FROM ledger WHERE user_id = ${id} AND type = 'TOPUP')`.as("topups"),
        sql<string>`(SELECT coalesce(sum(amount_micros), 0) FROM ledger WHERE user_id = ${id} AND type IN ('GRANT', 'PROMO', 'SIGNUP'))`.as("credits"),
      ])
      .executeTakeFirstOrThrow(),
    db
      .selectFrom("requests")
      .select([sql<string>`to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD')`.as("date"), sql<string>`count(*)`.as("r"), sql<string>`coalesce(sum(price_micros), 0)`.as("s")])
      .where("user_id", "=", id)
      .where(sql<boolean>`created_at > now() - interval '30 days'`)
      .groupBy("date")
      .orderBy("date")
      .execute(),
  ]);
  return {
    ...base!,
    reservedMicros: n(row.reserved_micros),
    keys: keys.map((k) => ({ id: k.id, name: k.name, hint: k.display_hint, status: k.status, marginBps: k.margin_bps, lastUsedAt: k.last_used_at?.toISOString() ?? null })),
    totals: { requests: n(totals.requests), spendMicros: n(totals.spend), topupsMicros: n(totals.topups), creditsMicros: n(totals.credits) },
    usage: usage.map((u) => ({ date: u.date, requests: n(u.r), spendMicros: n(u.s) })),
  };
}

async function target(actor: Actor, id: string, exec: Executor = db) {
  const user = await userRepo.findById(id, exec);
  if (!user) throw notFound("User not found", "USER_NOT_FOUND");
  if (user.id === actor.id) throw forbidden("You cannot do that to your own account", "SELF_ACTION");
  return user;
}

export async function setRole(actor: Actor, id: string, role: UserRole, meta: RequestMeta): Promise<AdminUserRow> {
  requireAdmin(actor);
  return withTransaction(async (trx) => {
    const user = await target(actor, id, trx);
    if (user.role === role) return oneRow(id, trx);
    if (user.role === "ADMIN") await assertNotLastAdmin(user.id, "ADMIN", trx);
    await trx.updateTable("users").set({ role, updated_at: new Date() }).where("id", "=", id).execute();
    // A demoted admin's open sessions must not keep admin powers until the token expires.
    if (role !== "ADMIN") await userRepo.bumpTokenVersion(id, trx);
    await audit({ actorId: actor.id, action: "user.role", entityType: "user", entityId: id, ip: meta.ip, data: { from: user.role, to: role } }, trx);
    return oneRow(id, trx);
  });
}

/** Suspended and banned accounts' keys stop working at once: the data plane checks the account's status, and the cached key contexts are dropped. */
export async function setStatus(actor: Actor, id: string, action: "suspend" | "unsuspend" | "ban" | "unban", input: { days?: number; reason?: string }, meta: RequestMeta): Promise<AdminUserRow> {
  requireAdmin(actor);
  const row = await withTransaction(async (trx) => {
    const user = await target(actor, id, trx);
    if (user.status === "DEACTIVATED") throw conflict("This account was erased", "USER_ERASED");
    const now = new Date();
    if (action === "suspend") {
      if (!input.days || input.days < 1 || input.days > 365) throw badRequest("Suspend for 1 to 365 days", "DAYS_INVALID");
      if (user.role === "ADMIN") throw forbidden("Demote an admin before suspending them", "TARGET_PROTECTED");
      await trx.updateTable("users").set({ status: "SUSPENDED", suspended_until: new Date(now.getTime() + input.days * 86_400_000), updated_at: now }).where("id", "=", id).execute();
    } else if (action === "unsuspend") {
      if (user.status !== "SUSPENDED") throw conflict("This account is not suspended", "INVALID_STATUS");
      await trx.updateTable("users").set({ status: "ACTIVE", suspended_until: null, updated_at: now }).where("id", "=", id).execute();
    } else if (action === "ban") {
      if (user.role === "ADMIN") throw forbidden("Demote an admin before banning them", "TARGET_PROTECTED");
      await trx.updateTable("users").set({ status: "BANNED", suspended_until: null, updated_at: now }).where("id", "=", id).execute();
      await sessionRepo.revokeAllForUser(id, trx);
      await userRepo.bumpTokenVersion(id, trx);
    } else {
      if (user.status !== "BANNED") throw conflict("This account is not banned", "INVALID_STATUS");
      await trx.updateTable("users").set({ status: "ACTIVE", updated_at: now }).where("id", "=", id).execute();
    }
    await audit({ actorId: actor.id, action: `user.${action}`, entityType: "user", entityId: id, ip: meta.ip, data: { reason: input.reason ?? null, days: input.days ?? null } }, trx);
    return oneRow(id, trx);
  });
  await invalidateUserKeys(id);
  return row;
}

export async function eraseUser(actor: Actor, id: string, reason: string, meta: RequestMeta): Promise<void> {
  requireAdmin(actor);
  await withTransaction(async (trx) => {
    const user = await target(actor, id, trx);
    if (user.status === "DEACTIVATED") throw conflict("This account was already erased", "ALREADY_ERASED");
    await assertNotLastAdmin(user.id, user.role, trx);
    await anonymiseUser(id, trx);
    await audit({ actorId: actor.id, action: "user.erase", entityType: "user", entityId: id, ip: meta.ip, data: { reason } }, trx);
  });
  await invalidateUserKeys(id);
}

export async function setUserTier(actor: Actor, id: string, tierId: string | null, meta: RequestMeta): Promise<AdminUserRow> {
  requireAdmin(actor);
  const row = await withTransaction(async (trx) => {
    const user = await userRepo.findById(id, trx);
    if (!user) throw notFound("User not found", "USER_NOT_FOUND");
    if (tierId && !(await trx.selectFrom("limit_tiers").select("id").where("id", "=", tierId).executeTakeFirst())) throw notFound("Tier not found", "TIER_NOT_FOUND");
    await trx.updateTable("users").set({ limit_tier_id: tierId, updated_at: new Date() }).where("id", "=", id).execute();
    await audit({ actorId: actor.id, action: "user.tier", entityType: "user", entityId: id, ip: meta.ip, data: { from: user.limit_tier_id, to: tierId } }, trx);
    return oneRow(id, trx);
  });
  await invalidateUserKeys(id);
  return row;
}

/** An account margin (a partner at cost, say). Null falls back to the model's margin, then the default. */
export async function setUserMargin(actor: Actor, id: string, marginBps: number | null, meta: RequestMeta): Promise<AdminUserDetail> {
  requireAdmin(actor);
  await withTransaction(async (trx) => {
    const user = await userRepo.findById(id, trx);
    if (!user) throw notFound("User not found", "USER_NOT_FOUND");
    await trx.updateTable("users").set({ margin_bps: marginBps, updated_at: new Date() }).where("id", "=", id).execute();
    await audit({ actorId: actor.id, action: "user.margin", entityType: "user", entityId: id, ip: meta.ip, data: { from: user.margin_bps, to: marginBps } }, trx);
  });
  await invalidateUserKeys(id);
  return userDetail(actor, id);
}

/** A key margin: the highest-precedence override. */
export async function setKeyMargin(actor: Actor, userId: string, keyId: string, marginBps: number | null, meta: RequestMeta): Promise<AdminUserDetail> {
  requireAdmin(actor);
  const hash = await withTransaction(async (trx) => {
    const key = await trx.selectFrom("api_keys").select(["key_hash", "margin_bps"]).where("id", "=", keyId).where("user_id", "=", userId).executeTakeFirst();
    if (!key) throw notFound("Key not found", "KEY_NOT_FOUND");
    await trx.updateTable("api_keys").set({ margin_bps: marginBps, updated_at: new Date() }).where("id", "=", keyId).execute();
    await audit({ actorId: actor.id, action: "key.margin", entityType: "api_key", entityId: keyId, ip: meta.ip, data: { userId, from: key.margin_bps, to: marginBps } }, trx);
    return key.key_hash;
  });
  await invalidateKey(hash);
  return userDetail(actor, userId);
}

/** A signed ledger entry an admin books: GRANT adds free credit, ADJUSTMENT corrects either way. */
export async function creditUser(actor: Actor, id: string, input: { type: "GRANT" | "ADJUSTMENT"; amountMicros: number; reason: string }, meta: RequestMeta): Promise<AdminUserDetail> {
  requireAdmin(actor);
  if (input.type === "GRANT" && input.amountMicros <= 0) throw badRequest("A grant must be positive", "AMOUNT_INVALID");
  if (input.amountMicros === 0) throw badRequest("The amount cannot be zero", "AMOUNT_INVALID");
  await withTransaction(async (trx) => {
    if (!(await userRepo.findById(id, trx))) throw notFound("User not found", "USER_NOT_FOUND");
    const ref = newId();
    await credit({ userId: id, type: input.type, amountMicros: input.amountMicros, refType: "admin", refId: ref, description: input.reason, actorId: actor.id }, trx);
    await audit({ actorId: actor.id, action: `wallet.${input.type.toLowerCase()}`, entityType: "user", entityId: id, ip: meta.ip, data: { amountMicros: input.amountMicros, reason: input.reason, ref } }, trx);
  });
  return userDetail(actor, id);
}

// ─── Rate-limit tiers ───────────────────────────────────────────────────────

export async function listTiers(actor: Actor, exec: Executor = db): Promise<LimitTier[]> {
  requireAdmin(actor);
  const rows = await exec
    .selectFrom("limit_tiers as t")
    .select(["t.id", "t.name", "t.rpm", "t.tpm", "t.concurrency", "t.is_default"])
    .select(sql<string>`(SELECT count(*) FROM users u WHERE u.limit_tier_id = t.id)`.as("users"))
    .orderBy("t.is_default", "desc")
    .orderBy("t.name")
    .execute();
  return rows.map((r) => ({ id: r.id, name: r.name, rpm: r.rpm, tpm: r.tpm, concurrency: r.concurrency, isDefault: r.is_default, userCount: n(r.users) }));
}

export interface TierInput {
  name: string;
  rpm: number | null;
  tpm: number | null;
  concurrency: number | null;
  isDefault?: boolean;
}

/** Exactly one tier is the default (accounts without a tier use it). Changing tiers drops every cached key context. */
export async function saveTier(actor: Actor, id: string | null, input: TierInput, meta: RequestMeta): Promise<LimitTier[]> {
  requireAdmin(actor);
  const out = await withTransaction(async (trx) => {
    const clash = await trx.selectFrom("limit_tiers").select("id").where("name", "=", input.name).$if(!!id, (q) => q.where("id", "<>", id!)).executeTakeFirst();
    if (clash) throw conflict("A tier with that name exists", "TIER_EXISTS");
    const tierId = id ?? newId();
    const values = { name: input.name, rpm: input.rpm, tpm: input.tpm, concurrency: input.concurrency };
    if (id) {
      const current = await trx.selectFrom("limit_tiers").select("is_default").where("id", "=", id).executeTakeFirst();
      if (!current) throw notFound("Tier not found", "TIER_NOT_FOUND");
      if (current.is_default && input.isDefault === false) throw conflict("Make another tier the default first", "TIER_DEFAULT");
      await trx.updateTable("limit_tiers").set({ ...values, updated_at: new Date() }).where("id", "=", id).execute();
    } else {
      await trx.insertInto("limit_tiers").values({ id: tierId, ...values, is_default: false }).execute();
    }
    if (input.isDefault) {
      await trx.updateTable("limit_tiers").set({ is_default: false }).where("id", "<>", tierId).execute();
      await trx.updateTable("limit_tiers").set({ is_default: true }).where("id", "=", tierId).execute();
    }
    await audit({ actorId: actor.id, action: id ? "tier.updated" : "tier.created", entityType: "limit_tier", entityId: tierId, ip: meta.ip, data: { ...values, isDefault: input.isDefault ?? false } }, trx);
    return listTiers(actor, trx);
  });
  await invalidateAllKeys();
  return out;
}

export async function deleteTier(actor: Actor, id: string, meta: RequestMeta): Promise<LimitTier[]> {
  requireAdmin(actor);
  const out = await withTransaction(async (trx) => {
    const tier = await trx.selectFrom("limit_tiers").select("is_default").where("id", "=", id).executeTakeFirst();
    if (!tier) throw notFound("Tier not found", "TIER_NOT_FOUND");
    if (tier.is_default) throw conflict("The default tier cannot be deleted", "TIER_DEFAULT");
    await trx.deleteFrom("limit_tiers").where("id", "=", id).execute();
    await audit({ actorId: actor.id, action: "tier.deleted", entityType: "limit_tier", entityId: id, ip: meta.ip }, trx);
    return listTiers(actor, trx);
  });
  await invalidateAllKeys();
  return out;
}

/** Tier changes reach many accounts; key contexts expire within a minute anyway, so this is a best effort over the cache. */
async function invalidateAllKeys(): Promise<void> {
  const users = await db.selectFrom("api_keys").select("user_id").distinct().where("status", "=", "ACTIVE").execute();
  for (const u of users) await invalidateUserKeys(u.user_id);
}

// ─── Top-ups ────────────────────────────────────────────────────────────────

export async function listTopups(actor: Actor, q: { status?: string; userId?: string; cursor?: string; limit: number }): Promise<Page<AdminTopupRow>> {
  requireAdmin(actor);
  let query = db.selectFrom("topups").select(["id", "user_id", "gateway", "currency", "total_minor", "credit_micros", "status", "created_at", "paid_at", atKey("created_at")]);
  if (q.status) query = query.where("status", "=", q.status as AdminTopupRow["status"]);
  if (q.userId) query = query.where("user_id", "=", q.userId);
  const rows = await query.where(olderThan("created_at", "id", decodeTime(q.cursor))).orderBy("created_at", "desc").orderBy("id", "desc").limit(q.limit + 1).execute();
  const page = timePage(rows, q.limit);
  const people = await loadSummaries(page.items.map((r) => r.user_id));
  return {
    items: page.items.map((r) => ({
      id: r.id,
      owner: people.get(r.user_id)!,
      gateway: r.gateway,
      currency: r.currency as AdminTopupRow["currency"],
      totalMinor: n(r.total_minor),
      creditMicros: n(r.credit_micros),
      status: r.status,
      createdAt: r.created_at.toISOString(),
      paidAt: r.paid_at?.toISOString() ?? null,
    })),
    nextCursor: page.nextCursor,
  };
}

export async function refundTopup(actor: Actor, id: string, reason: string, meta: RequestMeta): Promise<void> {
  requireAdmin(actor);
  await refund(actor.id, id, reason, meta);
}

// ─── Promo codes ────────────────────────────────────────────────────────────

export async function listPromos(actor: Actor): Promise<PromoCode[]> {
  requireAdmin(actor);
  const rows = await db.selectFrom("promo_codes").selectAll().orderBy("created_at", "desc").execute();
  return rows.map((r) => ({ id: r.id, code: r.code, amountMicros: n(r.amount_micros), maxRedemptions: r.max_redemptions, redeemedCount: r.redeemed_count, expiresAt: r.expires_at?.toISOString() ?? null, active: r.active, createdAt: r.created_at.toISOString() }));
}

export async function createPromo(actor: Actor, input: { code: string; amountMicros: number; maxRedemptions?: number | null; expiresAt?: string | null }, meta: RequestMeta): Promise<PromoCode[]> {
  requireAdmin(actor);
  await withTransaction(async (trx) => {
    if (await trx.selectFrom("promo_codes").select("id").where("code", "=", input.code).executeTakeFirst()) throw conflict("That code exists", "PROMO_EXISTS");
    const id = newId();
    await trx.insertInto("promo_codes").values({ id, code: input.code, amount_micros: input.amountMicros, max_redemptions: input.maxRedemptions ?? null, expires_at: input.expiresAt ? new Date(input.expiresAt) : null, created_by: actor.id }).execute();
    await audit({ actorId: actor.id, action: "promo.created", entityType: "promo", entityId: id, ip: meta.ip, data: { code: input.code, amountMicros: input.amountMicros, maxRedemptions: input.maxRedemptions ?? null } }, trx);
  });
  return listPromos(actor);
}

export async function setPromoActive(actor: Actor, id: string, active: boolean, meta: RequestMeta): Promise<PromoCode[]> {
  requireAdmin(actor);
  await withTransaction(async (trx) => {
    const row = await trx.updateTable("promo_codes").set({ active }).where("id", "=", id).returning("id").executeTakeFirst();
    if (!row) throw notFound("Promo code not found", "PROMO_NOT_FOUND");
    await audit({ actorId: actor.id, action: active ? "promo.activated" : "promo.deactivated", entityType: "promo", entityId: id, ip: meta.ip }, trx);
  });
  return listPromos(actor);
}

// ─── Settings and integrations ──────────────────────────────────────────────

export type SettingsPatch = { [K in keyof AppSettings]?: AppSettings[K] extends Record<string, unknown> ? Partial<AppSettings[K]> : AppSettings[K] };

export async function readSettings(actor: Actor): Promise<AppSettings> {
  requireAdmin(actor);
  return getSettings();
}

export async function updateSettings(actor: Actor, patch: SettingsPatch, meta: RequestMeta): Promise<AppSettings> {
  requireAdmin(actor);
  return withTransaction(async (trx) => {
    clearSettingsCache();
    const input = patch as Partial<AppSettings>;
    const merged = mergeSettings(await getSettings(trx), input);
    if (merged.registration === "INVITE_ONLY" && !merged.allowedEmailDomains.length) throw badRequest("Invite-only sign-up needs at least one allowed email domain", "SETTINGS_INVALID");
    const l = merged.topupLimits;
    if (l.usdMin > l.usdMax || l.inrMin > l.inrMax) throw badRequest("A top-up minimum cannot exceed its maximum", "SETTINGS_INVALID");
    const { before, after } = await saveSettings(input, actor.id, trx);
    const b = before as unknown as Record<string, unknown>;
    const a = after as unknown as Record<string, unknown>;
    const keys = Object.keys(input).filter((k) => JSON.stringify(b[k]) !== JSON.stringify(a[k]));
    if (keys.length) await audit({ actorId: actor.id, action: "settings.update", entityType: "settings", entityId: "app", ip: meta.ip, data: { keys, before: Object.fromEntries(keys.map((k) => [k, b[k]])), after: Object.fromEntries(keys.map((k) => [k, a[k]])) } }, trx);
    clearSettingsCache();
    return after;
  });
}

export async function integrations(actor: Actor): Promise<IntegrationStatus> {
  requireAdmin(actor);
  const last = await db.selectFrom("fx_rates").select(["source", "fetched_at"]).orderBy("fetched_at", "desc").limit(1).executeTakeFirst();
  return {
    mail: { mode: config.MAIL_MODE },
    payments: { stripe: stripeEnabled(), razorpay: razorpayEnabled(), stub: config.PAYMENTS_STUB },
    fx: { inrPerUsd: await inrPerUsd(), source: config.FX_PROVIDER === "fixed" ? "fixed" : (last?.source ?? "fixed (no fetch yet)"), fetchedAt: last?.fetched_at.toISOString() ?? null },
    credentialsKeyConfigured: config.CREDENTIALS_KEY !== DEV_DEFAULTS.CREDENTIALS_KEY,
  };
}
