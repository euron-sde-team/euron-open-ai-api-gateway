/**
 * API keys for the console. The secret is generated here, returned once in the create
 * response and stored only as an HMAC (security/api-keys.ts). Every change drops the
 * key's cached context so the data plane sees it within one request, not one minute.
 *
 * Revoking is permanent: the row stays (usage history points at it) with status
 * REVOKED. Accounts may hold MAX_KEYS active keys.
 */
import type { ApiKey, ApiKeyInput, CreatedApiKey } from "@open-gateway/types";
import { requireActive, requireActor, type Actor, type RequestMeta } from "../core/context";
import { badRequest, conflict, notFound } from "../core/errors";
import { newId } from "../core/ids";
import { db, type Executor } from "../db/kysely";
import { catalog } from "../gateway/catalog";
import { invalidateKey, isIpEntry } from "../gateway/auth";
import { hashApiKey, keyHint, newApiKey } from "../security/api-keys";
import { audit } from "./audit.service";

export const MAX_KEYS = 50;

type KeyRow = {
  id: string;
  name: string;
  display_hint: string;
  status: "ACTIVE" | "REVOKED";
  expires_at: Date | null;
  allowed_models: string[];
  monthly_budget_micros: string | number | null;
  rpm: number | null;
  tpm: number | null;
  ip_allowlist: string[];
  log_bodies: boolean;
  last_used_at: Date | null;
  created_at: Date;
  revoked_at: Date | null;
};

function toKey(r: KeyRow, spent: number): ApiKey {
  return {
    id: r.id,
    name: r.name,
    hint: r.display_hint,
    status: r.status,
    expiresAt: r.expires_at?.toISOString() ?? null,
    allowedModels: r.allowed_models,
    monthlyBudgetMicros: r.monthly_budget_micros === null ? null : Number(r.monthly_budget_micros),
    spentThisMonthMicros: spent,
    rpm: r.rpm,
    tpm: r.tpm,
    ipAllowlist: r.ip_allowlist,
    logBodies: r.log_bodies,
    lastUsedAt: r.last_used_at?.toISOString() ?? null,
    createdAt: r.created_at.toISOString(),
    revokedAt: r.revoked_at?.toISOString() ?? null,
  };
}

const COLUMNS = ["id", "name", "display_hint", "status", "expires_at", "allowed_models", "monthly_budget_micros", "rpm", "tpm", "ip_allowlist", "log_bodies", "last_used_at", "created_at", "revoked_at"] as const;

const monthStart = () => new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1));

/** This month's spend per key of one account, in one grouped query. */
async function spendByKey(userId: string, exec: Executor = db): Promise<Map<string, number>> {
  const rows = await exec
    .selectFrom("requests")
    .select(["api_key_id", (eb) => eb.fn.sum<string>("price_micros").as("s")])
    .where("user_id", "=", userId)
    .where("created_at", ">=", monthStart())
    .groupBy("api_key_id")
    .execute();
  return new Map(rows.filter((r) => r.api_key_id).map((r) => [r.api_key_id!, Number(r.s ?? 0)]));
}

export async function listKeys(actor: Actor): Promise<ApiKey[]> {
  requireActor(actor);
  const [rows, spend] = await Promise.all([db.selectFrom("api_keys").select(COLUMNS).where("user_id", "=", actor.id).orderBy("status", "asc").orderBy("created_at", "desc").execute(), spendByKey(actor.id)]);
  return rows.map((r) => toKey(r, spend.get(r.id) ?? 0));
}

/** Checks the parts of an input zod cannot: models that exist, a future expiry, well-formed CIDRs. */
async function validate(input: Partial<ApiKeyInput>): Promise<void> {
  if (input.allowedModels?.length) {
    const { byName } = await catalog();
    const unknown = input.allowedModels.filter((m) => !byName.has(m.trim().toLowerCase()));
    if (unknown.length) throw badRequest(`Unknown models: ${unknown.slice(0, 5).join(", ")}`, "UNKNOWN_MODEL", { models: unknown });
  }
  if (input.expiresAt && new Date(input.expiresAt) <= new Date()) throw badRequest("The expiry must be in the future", "EXPIRY_IN_PAST");
  const bad = (input.ipAllowlist ?? []).filter((c) => !isIpEntry(c));
  if (bad.length) throw badRequest(`Not an IP address or CIDR: ${bad.slice(0, 3).join(", ")}`, "IP_ALLOWLIST_INVALID");
}

/** Allowed models are stored by public id, so an alias in the input is resolved first. */
async function canonicalModels(models: string[] | undefined): Promise<string[] | undefined> {
  if (!models) return undefined;
  const { byName } = await catalog();
  return [...new Set(models.map((m) => byName.get(m.trim().toLowerCase())?.id ?? m))];
}

export async function createKey(actor: Actor, input: ApiKeyInput, meta: RequestMeta): Promise<CreatedApiKey> {
  requireActive(actor);
  await validate(input);
  const active = await db.selectFrom("api_keys").select((eb) => eb.fn.countAll<string>().as("n")).where("user_id", "=", actor.id).where("status", "=", "ACTIVE").executeTakeFirst();
  if (Number(active?.n ?? 0) >= MAX_KEYS) throw conflict(`An account can hold ${MAX_KEYS} active keys; revoke one first`, "KEY_LIMIT");
  const secret = newApiKey();
  const row = await db
    .insertInto("api_keys")
    .values({
      id: newId(),
      user_id: actor.id,
      name: input.name,
      key_hash: hashApiKey(secret),
      display_hint: keyHint(secret),
      expires_at: input.expiresAt ? new Date(input.expiresAt) : null,
      allowed_models: (await canonicalModels(input.allowedModels)) ?? [],
      monthly_budget_micros: input.monthlyBudgetMicros ?? null,
      rpm: input.rpm ?? null,
      tpm: input.tpm ?? null,
      ip_allowlist: input.ipAllowlist ?? [],
      log_bodies: input.logBodies ?? false,
    })
    .returning(COLUMNS)
    .executeTakeFirstOrThrow();
  await audit({ actorId: actor.id, action: "key.created", entityType: "api_key", entityId: row.id, ip: meta.ip, data: { name: row.name } });
  return { ...toKey(row, 0), secret };
}

export async function updateKey(actor: Actor, id: string, patch: Partial<ApiKeyInput>, meta: RequestMeta): Promise<ApiKey> {
  requireActive(actor);
  await validate(patch);
  const current = await db.selectFrom("api_keys").select(["key_hash", "status"]).where("id", "=", id).where("user_id", "=", actor.id).executeTakeFirst();
  if (!current) throw notFound("Key not found", "KEY_NOT_FOUND");
  if (current.status === "REVOKED") throw conflict("A revoked key cannot be changed", "KEY_REVOKED");
  const allowed = await canonicalModels(patch.allowedModels);
  const row = await db
    .updateTable("api_keys")
    .set({
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.expiresAt !== undefined ? { expires_at: patch.expiresAt ? new Date(patch.expiresAt) : null } : {}),
      ...(allowed !== undefined ? { allowed_models: allowed } : {}),
      ...(patch.monthlyBudgetMicros !== undefined ? { monthly_budget_micros: patch.monthlyBudgetMicros } : {}),
      ...(patch.rpm !== undefined ? { rpm: patch.rpm } : {}),
      ...(patch.tpm !== undefined ? { tpm: patch.tpm } : {}),
      ...(patch.ipAllowlist !== undefined ? { ip_allowlist: patch.ipAllowlist } : {}),
      ...(patch.logBodies !== undefined ? { log_bodies: patch.logBodies } : {}),
      updated_at: new Date(),
    })
    .where("id", "=", id)
    .where("user_id", "=", actor.id)
    .returning(COLUMNS)
    .executeTakeFirstOrThrow();
  await invalidateKey(current.key_hash);
  await audit({ actorId: actor.id, action: "key.updated", entityType: "api_key", entityId: id, ip: meta.ip, data: { fields: Object.keys(patch) } });
  const spend = await spendByKey(actor.id);
  return toKey(row, spend.get(id) ?? 0);
}

export async function revokeKey(actor: Actor, id: string, meta: RequestMeta): Promise<void> {
  requireActor(actor);
  const row = await db
    .updateTable("api_keys")
    .set({ status: "REVOKED", revoked_at: new Date(), updated_at: new Date() })
    .where("id", "=", id)
    .where("user_id", "=", actor.id)
    .where("status", "=", "ACTIVE")
    .returning("key_hash")
    .executeTakeFirst();
  if (!row) {
    const exists = await db.selectFrom("api_keys").select("id").where("id", "=", id).where("user_id", "=", actor.id).executeTakeFirst();
    if (!exists) throw notFound("Key not found", "KEY_NOT_FOUND");
    return;
  }
  await invalidateKey(row.key_hash);
  await audit({ actorId: actor.id, action: "key.revoked", entityType: "api_key", entityId: id, ip: meta.ip });
}
