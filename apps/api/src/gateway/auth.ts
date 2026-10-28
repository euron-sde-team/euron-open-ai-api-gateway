/**
 * API key authentication for the data plane. The key comes from `Authorization: Bearer`
 * or `x-api-key` (what the Anthropic SDK sends). It is hashed with the server pepper and
 * looked up once; the result (key controls, the account's status, tier and margin) is
 * cached in Redis for a minute and dropped when the key or the account changes
 * (invalidateKey, invalidateUserKeys). last_used_at is written at most once a minute.
 */
import type { Request } from "express";
import { db } from "../db/kysely";
import { captureError } from "../core/logger";
import { redis } from "../integrations/redis";
import { hashApiKey, looksLikeApiKey } from "../security/api-keys";
import { GatewayError } from "./errors";
import type { Limits } from "./limits";

export interface KeyContext {
  keyId: string;
  keyName: string;
  userId: string;
  allowedModels: string[];
  monthlyBudgetMicros: number | null;
  ipAllowlist: string[];
  logBodies: boolean;
  keyMarginBps: number | null;
  userMarginBps: number | null;
  limits: Limits;
}

interface Cached extends KeyContext {
  active: boolean;
  expiresAt: string | null;
  userStatus: string;
}

const TTL_SECONDS = 60;
const cacheKey = (hash: string) => `gwkey:${hash}`;

function presented(req: Request): string | null {
  const auth = req.get("authorization");
  if (auth && /^bearer\s+/i.test(auth)) return auth.replace(/^bearer\s+/i, "").trim();
  const x = req.get("x-api-key");
  return x ? x.trim() : null;
}

async function load(hash: string): Promise<Cached | null> {
  const row = await db
    .selectFrom("api_keys as k")
    .innerJoin("users as u", "u.id", "k.user_id")
    .leftJoin("limit_tiers as t", "t.id", "u.limit_tier_id")
    .leftJoin("limit_tiers as d", (j) => j.on("d.is_default", "=", true))
    .select([
      "k.id",
      "k.name",
      "k.user_id",
      "k.status",
      "k.expires_at",
      "k.allowed_models",
      "k.monthly_budget_micros",
      "k.rpm",
      "k.tpm",
      "k.ip_allowlist",
      "k.log_bodies",
      "k.margin_bps as key_margin",
      "u.status as user_status",
      "u.margin_bps as user_margin",
      "t.id as tier_id",
      "t.rpm as t_rpm",
      "t.tpm as t_tpm",
      "t.concurrency as t_conc",
      "d.rpm as d_rpm",
      "d.tpm as d_tpm",
      "d.concurrency as d_conc",
    ])
    .where("k.key_hash", "=", hash)
    .executeTakeFirst();
  if (!row) return null;
  const onTier = row.tier_id !== null;
  return {
    keyId: row.id,
    keyName: row.name,
    userId: row.user_id,
    active: row.status === "ACTIVE",
    expiresAt: row.expires_at?.toISOString() ?? null,
    userStatus: row.user_status,
    allowedModels: row.allowed_models,
    monthlyBudgetMicros: row.monthly_budget_micros === null ? null : Number(row.monthly_budget_micros),
    ipAllowlist: row.ip_allowlist,
    logBodies: row.log_bodies,
    keyMarginBps: row.key_margin,
    userMarginBps: row.user_margin,
    limits: {
      rpm: row.rpm ?? (onTier ? row.t_rpm : row.d_rpm) ?? null,
      tpm: row.tpm ?? (onTier ? row.t_tpm : row.d_tpm) ?? null,
      concurrency: (onTier ? row.t_conc : row.d_conc) ?? null,
    },
  };
}

export async function authenticateKey(req: Request): Promise<KeyContext> {
  const key = presented(req);
  if (!key) throw new GatewayError(401, "authentication_error", "missing_api_key", "Provide an API key in the Authorization header (Bearer) or x-api-key.");
  if (!looksLikeApiKey(key)) throw new GatewayError(401, "authentication_error", "invalid_api_key", "This API key is not valid.");
  const hash = hashApiKey(key);
  let ctx: Cached | null = null;
  try {
    const hit = await redis().get(cacheKey(hash));
    if (hit) ctx = JSON.parse(hit) as Cached;
  } catch (err) {
    captureError(err, { where: "gateway.auth.cache" });
  }
  if (!ctx) {
    ctx = await load(hash);
    if (ctx) await redis().set(cacheKey(hash), JSON.stringify(ctx), "EX", TTL_SECONDS).catch(() => undefined);
  }
  if (!ctx || !ctx.active) throw new GatewayError(401, "authentication_error", "invalid_api_key", "This API key is not valid or was revoked.");
  if (ctx.expiresAt && Date.parse(ctx.expiresAt) <= Date.now()) throw new GatewayError(401, "authentication_error", "expired_api_key", "This API key has expired.");
  if (ctx.userStatus !== "ACTIVE") throw new GatewayError(403, "permission_error", "account_restricted", "This account cannot make requests right now.");
  void touch(ctx.keyId);
  return ctx;
}

async function touch(keyId: string): Promise<void> {
  try {
    if ((await redis().set(`gwkey:touch:${keyId}`, "1", "EX", 60, "NX")) !== "OK") return;
    await db.updateTable("api_keys").set({ last_used_at: new Date() }).where("id", "=", keyId).execute();
  } catch (err) {
    captureError(err, { where: "gateway.auth.touch" });
  }
}

/** Drop the cached context of one key (after an update or revoke). */
export async function invalidateKey(keyHash: string): Promise<void> {
  await redis().del(cacheKey(keyHash)).catch(() => undefined);
}

/** Drop every cached key of an account (status, tier or margin changed). */
export async function invalidateUserKeys(userId: string): Promise<void> {
  const rows = await db.selectFrom("api_keys").select("key_hash").where("user_id", "=", userId).execute();
  if (rows.length) await redis().del(...rows.map((r) => cacheKey(r.key_hash))).catch(() => undefined);
}

/** Whether `ip` is inside one of the allow-list entries (IPv4/IPv6 addresses or CIDRs). Empty list: allowed. */
export function ipAllowed(ip: string | undefined, allowlist: string[]): boolean {
  if (!allowlist.length) return true;
  if (!ip) return false;
  const addr = ip.replace(/^::ffff:/, "");
  return allowlist.some((entry) => inCidr(addr, entry));
}

/** Whether an allow-list entry is an IPv4 or IPv6 address, optionally with a /prefix that fits it. */
export function isIpEntry(entry: string): boolean {
  const [range, bitsText, extra] = entry.trim().split("/");
  if (!range || extra !== undefined) return false;
  const parsed = toBigInt(range.replace(/^::ffff:(?=\d+\.)/, ""));
  if (!parsed) return false;
  if (bitsText === undefined) return true;
  if (!/^\d{1,3}$/.test(bitsText)) return false;
  return Number(bitsText) <= (parsed.v6 ? 128 : 32);
}

function inCidr(ip: string, entry: string): boolean {
  const [range, bitsText] = entry.split("/");
  if (!range) return false;
  if (bitsText === undefined) {
    // Compare as numbers so 2001:DB8::1 and 2001:db8:0::1 match the same client.
    const a = toBigInt(ip);
    const b = toBigInt(range.replace(/^::ffff:(?=\d+\.)/, ""));
    return !!a && !!b && a.v6 === b.v6 && a.n === b.n;
  }
  const bits = Number(bitsText);
  const a = toBigInt(ip);
  const b = toBigInt(range);
  if (a === null || b === null || a.v6 !== b.v6) return false;
  const width = a.v6 ? 128 : 32;
  if (!(bits >= 0 && bits <= width)) return false;
  const mask = bits === 0 ? 0n : ((1n << BigInt(bits)) - 1n) << BigInt(width - bits);
  return (a.n & mask) === (b.n & mask);
}

function toBigInt(ip: string): { n: bigint; v6: boolean } | null {
  if (/^\d+\.\d+\.\d+\.\d+$/.test(ip)) {
    const parts = ip.split(".").map(Number);
    if (parts.some((p) => p > 255)) return null;
    return { n: parts.reduce((acc, p) => (acc << 8n) + BigInt(p), 0n), v6: false };
  }
  if (!ip.includes(":")) return null;
  const [head, tail] = ip.split("::");
  const h = head ? head.split(":") : [];
  const t = tail !== undefined && tail ? tail.split(":") : [];
  const fill = ip.includes("::") ? 8 - h.length - t.length : 0;
  const groups = [...h, ...Array(Math.max(0, fill)).fill("0"), ...t];
  if (groups.length !== 8) return null;
  let n = 0n;
  for (const g of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g || "0")) return null;
    const v = parseInt(g || "0", 16);
    n = (n << 16n) + BigInt(v);
  }
  return { n, v6: true };
}
