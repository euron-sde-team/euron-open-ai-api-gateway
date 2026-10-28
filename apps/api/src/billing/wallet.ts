/**
 * The wallet and the ledger (ADR 0003). One balance per account in micro-USD, plus what
 * in-flight requests hold. Every change is one ledger row with the balance after it, in
 * the same transaction as the balance update.
 *
 *   reserve   before calling a provider: atomically put the worst-case price on hold,
 *             or refuse (402). `UPDATE ... WHERE balance - reserved >= amount` makes
 *             parallel requests unable to spend past the balance.
 *   settle    after the call: debit the actual price, drop the hold, book USAGE. The
 *             actual price may exceed the hold (an estimate ran low); it is charged in
 *             full and the balance may dip below zero, which refuses new requests.
 *   release   the call failed before anything billable happened: drop the hold.
 *   credit    top-ups, grants, promo codes, refunds, adjustments: idempotent per
 *             (ref_type, ref_id, type) through ledger_once, under the wallet row lock.
 *
 * A hold that is neither settled nor released (a crashed process) expires and is
 * released by the sweeper (jobs/gateway.jobs.ts).
 */
import type { LedgerType } from "@open-gateway/types";
import { sql } from "kysely";
import { newId } from "../core/ids";
import { db, type Executor } from "../db/kysely";

/** How long a hold may stay before the sweeper releases it. Longer than any provider timeout. */
export const RESERVATION_TTL_MS = 15 * 60_000;

export class InsufficientBalanceError extends Error {
  constructor(readonly availableMicros: number) {
    super("insufficient balance");
  }
}

export async function ensureWallet(userId: string, exec: Executor = db): Promise<void> {
  await exec.insertInto("wallets").values({ user_id: userId }).onConflict((oc) => oc.column("user_id").doNothing()).execute();
}

/** Hold `amount` for a request, or throw InsufficientBalanceError. Returns the reservation id. */
export async function reserve(userId: string, amountMicros: number): Promise<string> {
  const amount = Math.max(0, Math.ceil(amountMicros));
  return db.transaction().execute(async (trx) => {
    const held = await trx
      .updateTable("wallets")
      .set((eb) => ({ reserved_micros: eb("reserved_micros", "+", amount), updated_at: new Date() }))
      .where("user_id", "=", userId)
      .where(sql<boolean>`balance_micros - reserved_micros >= ${amount}`)
      .returning("user_id")
      .executeTakeFirst();
    if (!held) {
      const w = await trx.selectFrom("wallets").select(["balance_micros", "reserved_micros"]).where("user_id", "=", userId).executeTakeFirst();
      throw new InsufficientBalanceError(w ? Number(w.balance_micros) - Number(w.reserved_micros) : 0);
    }
    const id = newId();
    await trx.insertInto("reservations").values({ id, user_id: userId, amount_micros: amount, expires_at: new Date(Date.now() + RESERVATION_TTL_MS) }).execute();
    return id;
  });
}

/**
 * Settle a hold with the actual price. `book` runs in the same transaction (the request
 * row insert), so a request is recorded exactly when it is paid for. A hold that is no
 * longer HELD (already settled, or released by the sweeper) still charges, once: the
 * ledger's unique (ref, type) stops a double debit.
 */
export async function settle(reservationId: string, userId: string, priceMicros: number, ref: { requestId: string; description: string }, book?: (trx: Executor) => Promise<void>): Promise<number> {
  const price = Math.max(0, Math.ceil(priceMicros));
  return db.transaction().execute(async (trx) => {
    const res = await trx.selectFrom("reservations").select(["amount_micros", "status"]).where("id", "=", reservationId).forUpdate().executeTakeFirst();
    const release = res && res.status === "HELD" ? Number(res.amount_micros) : 0;
    const w = await trx
      .updateTable("wallets")
      .set((eb) => ({ balance_micros: eb("balance_micros", "-", price), reserved_micros: sql`greatest(reserved_micros - ${release}, 0)`, updated_at: new Date() }))
      .where("user_id", "=", userId)
      .returning("balance_micros")
      .executeTakeFirstOrThrow();
    if (res?.status === "HELD") await trx.updateTable("reservations").set({ status: "SETTLED" }).where("id", "=", reservationId).execute();
    if (book) await book(trx);
    if (price > 0) {
      const inserted = await trx
        .insertInto("ledger")
        .values({ id: newId(), user_id: userId, type: "USAGE", amount_micros: -price, balance_after_micros: Number(w.balance_micros), ref_type: "request", ref_id: ref.requestId, description: ref.description.slice(0, 300) })
        .onConflict((oc) => oc.columns(["ref_type", "ref_id", "type"]).doNothing())
        .returning("id")
        .executeTakeFirst();
      // Already booked (a retry of the same settlement): give the debit back.
      if (!inserted) await trx.updateTable("wallets").set((eb) => ({ balance_micros: eb("balance_micros", "+", price) })).where("user_id", "=", userId).execute();
    }
    return Number(w.balance_micros);
  });
}

/** Drop a hold without charging (the call failed before anything billable happened). */
export async function release(reservationId: string, userId: string): Promise<void> {
  await db.transaction().execute(async (trx) => {
    const res = await trx.updateTable("reservations").set({ status: "RELEASED" }).where("id", "=", reservationId).where("status", "=", "HELD").returning("amount_micros").executeTakeFirst();
    if (!res) return;
    await trx
      .updateTable("wallets")
      .set({ reserved_micros: sql`greatest(reserved_micros - ${Number(res.amount_micros)}, 0)`, updated_at: new Date() })
      .where("user_id", "=", userId)
      .execute();
  });
}

export interface CreditInput {
  userId: string;
  type: Exclude<LedgerType, "USAGE">;
  amountMicros: number;
  refType: string;
  refId: string;
  description: string;
  actorId?: string | null;
}

/**
 * Add (or, for REFUND and negative ADJUSTMENT, remove) money, once per (refType, refId,
 * type). Runs in the caller's transaction when given one. Returns the new balance, or
 * null when this reference was already booked (nothing changed).
 */
export async function credit(c: CreditInput, exec?: Executor): Promise<number | null> {
  const run = async (trx: Executor) => {
    await ensureWallet(c.userId, trx);
    await trx.selectFrom("wallets").select("user_id").where("user_id", "=", c.userId).forUpdate().executeTakeFirst();
    const seen = await trx.selectFrom("ledger").select("id").where("ref_type", "=", c.refType).where("ref_id", "=", c.refId).where("type", "=", c.type).executeTakeFirst();
    if (seen) return null;
    const amount = Math.trunc(c.amountMicros);
    const w = await trx
      .updateTable("wallets")
      .set((eb) => ({ balance_micros: eb("balance_micros", "+", amount), updated_at: new Date(), low_balance_notified_at: amount > 0 ? null : undefined }))
      .where("user_id", "=", c.userId)
      .returning("balance_micros")
      .executeTakeFirstOrThrow();
    await trx
      .insertInto("ledger")
      .values({ id: newId(), user_id: c.userId, type: c.type, amount_micros: amount, balance_after_micros: Number(w.balance_micros), ref_type: c.refType, ref_id: c.refId, description: c.description.slice(0, 300), created_by: c.actorId ?? null })
      .execute();
    return Number(w.balance_micros);
  };
  return exec ? run(exec) : db.transaction().execute(run);
}

export async function walletOf(userId: string, exec: Executor = db): Promise<{ balanceMicros: number; reservedMicros: number }> {
  const w = await exec.selectFrom("wallets").select(["balance_micros", "reserved_micros"]).where("user_id", "=", userId).executeTakeFirst();
  return { balanceMicros: Number(w?.balance_micros ?? 0), reservedMicros: Number(w?.reserved_micros ?? 0) };
}

/** Release holds whose time ran out (a process died mid-request). Returns how many. */
export async function sweepReservations(now = new Date()): Promise<number> {
  const due = await db.selectFrom("reservations").select(["id", "user_id"]).where("status", "=", "HELD").where("expires_at", "<=", now).limit(1000).execute();
  for (const r of due) await release(r.id, r.user_id);
  return due.length;
}
