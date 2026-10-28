/**
 * Job handlers of the gateway (schedules in worker.ts):
 *
 *   gateway.sweep-reservations  release holds whose request never settled (a process died mid-call)
 *   gateway.health-probes       a free probe of every enabled route; failures feed the circuit breaker
 *   gateway.fx-sync             fetch today's INR per USD rate
 *   gateway.low-balance         email accounts whose available balance fell below the threshold, once
 *
 * Each is safe to run twice or on two workers at once: releases and notifications are
 * conditional UPDATEs, and probes only add rows.
 */
import { sql } from "kysely";
import { config } from "../core/config";
import { newId } from "../core/ids";
import { captureError } from "../core/logger";
import { db } from "../db/kysely";
import { sweepReservations } from "../billing/wallet";
import { recordFailure, recordSuccess } from "../gateway/breaker";
import { catalog } from "../gateway/catalog";
import { probeRoute } from "../gateway/probe";
import { sendMail } from "../integrations/mail/mailer";
import * as templates from "../integrations/mail/templates";
import { syncFx } from "../services/fx.service";
import { appName, getSettings } from "../services/settings.service";
import { registerJob } from "./registry";

/** Probe each usable route once (routes of enabled models only), recording the result and feeding the breaker. Returns how many failed. */
export async function runHealthProbes(): Promise<number> {
  const { models } = await catalog();
  const routes = models.flatMap((m) => m.routes);
  let failed = 0;
  // A handful at a time: probes are cheap, but a long catalogue should not open hundreds of sockets at once.
  for (let i = 0; i < routes.length; i += 8) {
    await Promise.all(
      routes.slice(i, i + 8).map(async (route) => {
        const r = await probeRoute(route);
        if (r.ok) await recordSuccess(route.id);
        else {
          failed++;
          await recordFailure(route.id);
        }
        await db.insertInto("health_checks").values({ id: newId(), route_id: route.id, ok: r.ok, latency_ms: r.latencyMs, error: r.ok ? null : r.message.slice(0, 300) }).execute();
      }),
    );
  }
  return failed;
}

/** Accounts below the threshold that have not been told since their last credit. Returns how many were emailed. */
export async function notifyLowBalances(): Promise<number> {
  const { lowBalanceMicros } = await getSettings();
  if (lowBalanceMicros <= 0) return 0;
  // Only accounts that have used the API: a new account sitting on its signup credit is not "running low".
  const due = await db
    .updateTable("wallets as w")
    .set({ low_balance_notified_at: new Date() })
    .from("users as u")
    .whereRef("u.id", "=", "w.user_id")
    .where("u.status", "=", "ACTIVE")
    .where("w.low_balance_notified_at", "is", null)
    .where(sql<boolean>`w.balance_micros - w.reserved_micros < ${lowBalanceMicros}`)
    .where(sql<boolean>`EXISTS (SELECT 1 FROM requests r WHERE r.user_id = w.user_id)`)
    .returning(["u.email", "u.display_name", "w.balance_micros", "w.reserved_micros"])
    .execute();
  const name = await appName();
  for (const d of due) {
    try {
      const available = ((Number(d.balance_micros) - Number(d.reserved_micros)) / 1_000_000).toFixed(2);
      await sendMail(templates.lowBalance(name, d.email, d.display_name, available, `${config.APP_WEB_URL}/billing`));
    } catch (err) {
      captureError(err, { where: "gateway.low-balance" });
    }
  }
  return due.length;
}

export function registerGatewayJobs(): void {
  registerJob("gateway.sweep-reservations", async () => void (await sweepReservations()));
  registerJob("gateway.health-probes", async () => void (await runHealthProbes()));
  registerJob("gateway.fx-sync", async () => void (await syncFx()));
  registerJob("gateway.low-balance", async () => void (await notifyLowBalances()));
}
