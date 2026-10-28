/**
 * Job handlers of the operations module (schedules in worker.ts):
 *
 *   maintenance.lift-suspensions   timed suspensions that have run out
 *   maintenance.purge-accounts     erase accounts whose deletion grace period is over
 *   maintenance.retention          expired request bodies, request rows past the retention
 *                                  setting, probes older than 14 days, webhook ids older than 90 days
 *
 * Every step is safe to run twice or on two workers at once: state changes are
 * conditional UPDATEs, and the purge re-checks each account under a row lock.
 */
import { sql } from "kysely";
import { withTransaction } from "../core/effects";
import { captureError } from "../core/logger";
import { db } from "../db/kysely";
import { invalidateUserKeys } from "../gateway/auth";
import { anonymiseUser, DELETION_GRACE_DAYS } from "../services/account.service";
import { audit } from "../services/audit.service";
import { getSettings } from "../services/settings.service";
import { registerJob } from "./registry";

/** SUSPENDED accounts whose suspended_until has passed become ACTIVE. Returns how many. */
export async function liftSuspensions(): Promise<number> {
  const rows = await db
    .updateTable("users")
    .set({ status: "ACTIVE", suspended_until: null, updated_at: new Date() })
    .where("status", "=", "SUSPENDED")
    .where("suspended_until", "<=", new Date())
    .returning("id")
    .execute();
  for (const r of rows) {
    await audit({ actorId: null, action: "user.suspension_lifted", entityType: "user", entityId: r.id });
    // Their keys work again from the next request, not after the cached context expires.
    await invalidateUserKeys(r.id);
  }
  return rows.length;
}

/** Erase accounts whose deletion request is older than the grace period. Returns how many. */
export async function purgeAccounts(now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - DELETION_GRACE_DAYS * 86_400_000);
  const due = await db.selectFrom("users").select("id").where("deletion_requested_at", "<=", cutoff).limit(200).execute();
  let n = 0;
  for (const { id } of due) {
    try {
      const done = await withTransaction(async (trx) => {
        // Re-check under a row lock: they may have signed in (cancelling it) since the select.
        const row = await trx.selectFrom("users").select("deletion_requested_at").where("id", "=", id).forUpdate().executeTakeFirst();
        if (!row?.deletion_requested_at || row.deletion_requested_at > cutoff) return false;
        await anonymiseUser(id, trx);
        await audit({ actorId: null, action: "user.purged", entityType: "user", entityId: id }, trx);
        return true;
      });
      if (done) {
        n++;
        // The keys were revoked in the transaction; drop their cached contexts too.
        await invalidateUserKeys(id);
      }
    } catch (err) {
      captureError(err, { where: "maintenance.purge-accounts", userId: id });
    }
  }
  return n;
}

async function deleteInBatches(table: string, where: ReturnType<typeof sql>): Promise<number> {
  let total = 0;
  for (let round = 0; round < 50; round++) {
    const res = await sql<{ n: number }>`
      WITH gone AS (DELETE FROM ${sql.table(table)} WHERE ctid IN (SELECT ctid FROM ${sql.table(table)} WHERE ${where} LIMIT 1000) RETURNING 1)
      SELECT count(*)::int AS n FROM gone`.execute(db);
    const n = Number(res.rows[0]?.n ?? 0);
    total += n;
    if (n < 1000) break;
  }
  return total;
}

/** Retention for logged bodies (always), request rows (when the setting is on), probes and webhook ids. */
export async function applyRetention(): Promise<{ bodies: number; requests: number }> {
  const { requestRetentionDays } = await getSettings();
  const bodies = await deleteInBatches("request_bodies", sql`expires_at < now()`);
  const requests = requestRetentionDays ? await deleteInBatches("requests", sql`created_at < now() - make_interval(days => ${requestRetentionDays})`) : 0;
  await deleteInBatches("health_checks", sql`checked_at < now() - interval '14 days'`);
  await deleteInBatches("payment_webhook_events", sql`received_at < now() - interval '90 days'`);
  if (requests) await audit({ actorId: null, action: "retention.applied", entityType: "settings", entityId: "app", data: { requests, requestRetentionDays } });
  return { bodies, requests };
}

export function registerMaintenanceJobs(): void {
  registerJob("maintenance.lift-suspensions", async () => void (await liftSuspensions()));
  registerJob("maintenance.purge-accounts", async () => void (await purgeAccounts()));
  registerJob("maintenance.retention", async () => void (await applyRetention()));
}
