/**
 * Account lifecycle: deleting your own account (with a grace period), an admin erasing
 * one, and exporting your own data.
 *
 * Delete (DELETE /api/users/me) marks the account `deletion_requested_at` and signs it
 * out everywhere. Signing in again within the grace period cancels the request; after
 * it, the maintenance.purge-accounts job runs `anonymiseUser`. An admin erase (POST
 * /api/admin/users/:id/erase) runs it at once.
 *
 * `anonymiseUser` keeps the users row (usage totals and the audit log point at it) but
 * removes the person and everything they wrote:
 *   - users: status DEACTIVATED, email deleted+<id>@invalid.example, username
 *     deleted-<id tail>, display name "Deleted user", two-factor removed, password
 *     replaced with an unknown one, every session revoked;
 *   - every API key is revoked and any logged request bodies are deleted. The
 *     ledger, top-ups and request metadata stay: they are financial records, now
 *     pointing at an anonymous account.
 * Being the last active admin blocks deletion (409 LAST_ADMIN).
 *
 * Export (GET /api/users/me/export) streams one JSON document of the caller's own data,
 * read in pages of EXPORT_PAGE rows so a large account never sits in memory at once.
 */
import type { Response } from "express";
import type { Actor, RequestMeta } from "../core/context";
import { withTransaction } from "../core/effects";
import { conflict } from "../core/errors";
import { db, type Executor } from "../db/kysely";
import { toMe } from "../presenters/user.presenter";
import { recoveryCodeRepo } from "../repositories/recovery-code.repository";
import { sessionRepo } from "../repositories/session.repository";
import { userRepo } from "../repositories/user.repository";
import { hashPassword } from "../security/passwords";
import { randomToken } from "../security/tokens";
import { audit } from "./audit.service";
import { confirmIdentity } from "./auth.service";

export const DELETED_DISPLAY_NAME = "Deleted user";
/** Days between asking to delete an account and the purge. */
export const DELETION_GRACE_DAYS = 14;

export async function assertNotLastAdmin(userId: string, role: string, exec: Executor = db): Promise<void> {
  if (role !== "ADMIN") return;
  const others = await exec.selectFrom("users").select("id").where("role", "=", "ADMIN").where("status", "=", "ACTIVE").where("id", "<>", userId).executeTakeFirst();
  if (!others) throw conflict("You are the last administrator; make someone else an admin first", "LAST_ADMIN");
}

/** Ask for deletion: signed out everywhere now, erased after the grace period. */
export async function requestDeletion(actor: Actor, input: { password: string; totp?: string; recoveryCode?: string }, meta: RequestMeta): Promise<{ purgeAfter: string }> {
  const user = await confirmIdentity(actor, input);
  await assertNotLastAdmin(user.id, user.role);
  const now = new Date();
  await withTransaction(async (trx) => {
    await trx.updateTable("users").set({ deletion_requested_at: now, updated_at: now }).where("id", "=", user.id).execute();
    await sessionRepo.revokeAllForUser(user.id, trx);
    await userRepo.bumpTokenVersion(user.id, trx);
    await audit({ actorId: user.id, action: "user.deletion_requested", entityType: "user", entityId: user.id, ip: meta.ip }, trx);
  });
  return { purgeAfter: new Date(now.getTime() + DELETION_GRACE_DAYS * 86_400_000).toISOString() };
}

/** Signing in during the grace period keeps the account. Called by auth.service on a successful login. */
export async function cancelDeletionOnSignIn(userId: string, exec: Executor = db): Promise<boolean> {
  const r = await exec.updateTable("users").set({ deletion_requested_at: null }).where("id", "=", userId).where("deletion_requested_at", "is not", null).executeTakeFirst();
  const cancelled = Number(r.numUpdatedRows) > 0;
  if (cancelled) await audit({ actorId: userId, action: "user.deletion_cancelled", entityType: "user", entityId: userId }, exec);
  return cancelled;
}

/** Strip everything that identifies a person (see the header). Runs inside the caller's transaction. */
export async function anonymiseUser(id: string, trx: Executor): Promise<void> {
  const now = new Date();
  const unusable = await hashPassword(randomToken());
  await trx
    .updateTable("users")
    .set({
      status: "DEACTIVATED",
      role: "USER",
      email: `deleted+${id.toLowerCase()}@invalid.example`,
      username: `deleted-${id.slice(-12).toLowerCase()}`,
      display_name: DELETED_DISPLAY_NAME,
      limit_tier_id: null,
      margin_bps: null,
      password_hash: unusable,
      totp_enabled: false,
      totp_secret: null,
      totp_last_step: null,
      suspended_until: null,
      deletion_requested_at: null,
      updated_at: now,
    })
    .where("id", "=", id)
    .execute();
  await recoveryCodeRepo.deleteAll(id, trx);
  await trx.deleteFrom("auth_tokens").where("user_id", "=", id).execute();
  await sessionRepo.revokeAllForUser(id, trx);
  await userRepo.bumpTokenVersion(id, trx);

  await trx.updateTable("api_keys").set({ status: "REVOKED", revoked_at: now, updated_at: now }).where("user_id", "=", id).where("status", "=", "ACTIVE").execute();
  await trx.deleteFrom("request_bodies").where("request_id", "in", (eb) => eb.selectFrom("requests").select("id").where("user_id", "=", id)).execute();
}

// ─── Export ─────────────────────────────────────────────────────────────────

const EXPORT_PAGE = 500;

type Section = { name: string; query: (after: string | null) => Promise<{ id: string }[]> };

function sections(userId: string): Section[] {
  const after = <Q extends { where: (...a: any[]) => Q }>(q: Q, col: string, cursor: string | null): Q => (cursor ? q.where(col, ">", cursor) : q);
  return [
    {
      name: "apiKeys",
      query: (c) =>
        after(db.selectFrom("api_keys").select(["id", "name", "display_hint", "status", "expires_at", "allowed_models", "monthly_budget_micros", "rpm", "tpm", "ip_allowlist", "log_bodies", "last_used_at", "created_at", "revoked_at"]).where("user_id", "=", userId), "id", c)
          .orderBy("id")
          .limit(EXPORT_PAGE)
          .execute(),
    },
    { name: "ledger", query: (c) => after(db.selectFrom("ledger").select(["id", "type", "amount_micros", "balance_after_micros", "description", "created_at"]).where("user_id", "=", userId), "id", c).orderBy("id").limit(EXPORT_PAGE).execute() },
    {
      name: "topups",
      query: (c) =>
        after(db.selectFrom("topups").select(["id", "gateway", "currency", "amount_minor", "tax_minor", "total_minor", "fx_inr_per_usd", "credit_micros", "status", "created_at", "paid_at", "refunded_at"]).where("user_id", "=", userId), "id", c)
          .orderBy("id")
          .limit(EXPORT_PAGE)
          .execute(),
    },
    {
      name: "requests",
      query: (c) =>
        after(
          db
            .selectFrom("requests")
            .select(["id", "api_key_id", "model_id", "endpoint", "stream", "status_code", "error_code", "input_tokens", "output_tokens", "cached_tokens", "units", "estimated", "latency_ms", "price_micros", "created_at"])
            .where("user_id", "=", userId),
          "id",
          c,
        )
          .orderBy("id")
          .limit(EXPORT_PAGE)
          .execute(),
    },
  ];
}

/** Stream the caller's data as one JSON document: { exportedAt, account, apiKeys: [...], ledger: [...], topups: [...], requests: [...] }. */
export async function exportAccount(actor: Actor, res: Response): Promise<void> {
  const user = await userRepo.findById(actor.id);
  if (!user) return void res.status(404).end();
  const account = { ...(await toMe(user)), createdAt: user.created_at.toISOString() };
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${user.username}-export.json"`);
  res.setHeader("Cache-Control", "no-store");
  const write = (chunk: string) => new Promise<void>((resolve) => (res.write(chunk) ? resolve() : res.once("drain", resolve)));
  await write(`{"exportedAt":${JSON.stringify(new Date().toISOString())},"account":${JSON.stringify(account)}`);
  for (const section of sections(user.id)) {
    await write(`,${JSON.stringify(section.name)}:[`);
    let cursor: string | null = null;
    let first = true;
    for (;;) {
      const rows = await section.query(cursor);
      for (const row of rows) {
        await write(`${first ? "" : ","}${JSON.stringify(row)}`);
        first = false;
      }
      if (rows.length < EXPORT_PAGE) break;
      cursor = rows[rows.length - 1]!.id;
    }
    await write("]");
  }
  await write("}");
  res.end();
  await audit({ actorId: user.id, action: "user.export", entityType: "user", entityId: user.id });
}
