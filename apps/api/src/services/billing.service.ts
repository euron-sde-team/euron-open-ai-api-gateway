/**
 * The wallet as the console sees it, and every way money comes in: top-ups (Stripe in
 * USD, Razorpay in INR, the stub in development), promo codes, the signup credit and
 * admin grants. All of them end in billing/wallet.ts `credit()`, which books a ledger
 * row once per (ref_type, ref_id, type) under the wallet's row lock (ADR 0003).
 *
 * Top-ups:
 *   create   price the order (amount + tax), lock the FX rate for INR, compute the
 *            credit in micro-USD, open the gateway's checkout, store the row CREATED.
 *   fulfil   the one path from "the gateway says paid" to credit, used by the webhook,
 *            Razorpay's checkout.js verify and the stub confirm. In one transaction:
 *            lock the top-up row, stop if it is already PAID, check the amount and
 *            currency against the row, mark it PAID with the payment id (unique per
 *            gateway), and credit. Whichever of webhook and verify arrives second finds
 *            the row PAID and changes nothing, so a race credits once.
 *   refund   (admin) marks a PAID top-up REFUNDED and books a negative REFUND entry.
 *            The money itself is returned in the gateway's dashboard.
 */
import PDFDocument from "pdfkit";
import type { Currency, LedgerEntry, Page, PaymentGateway as GatewayName, Topup, TopupOrder, Wallet } from "@open-gateway/types";
import { requireActive, requireActor, type Actor, type RequestMeta } from "../core/context";
import { config } from "../core/config";
import { badRequest, conflict, forbidden, HttpError, notFound } from "../core/errors";
import { newId } from "../core/ids";
import { captureError, logger } from "../core/logger";
import { db, type Executor } from "../db/kysely";
import { credit, ensureWallet, walletOf } from "../billing/wallet";
import { gatewayByName, gatewayFor, razorpayGateway, verifyRazorpayPaymentSignature, WebhookSignatureError, type PaymentEvent } from "../billing/payments";
import { atKey, decodeTime, olderThan, timePage } from "../repositories/keyset";
import { audit } from "./audit.service";
import { inrPerUsd } from "./fx.service";
import { appName, getSettings } from "./settings.service";

// ─── Wallet and ledger ──────────────────────────────────────────────────────

export async function walletView(userId: string, exec: Executor = db): Promise<Wallet> {
  const w = await walletOf(userId, exec);
  const rate = await inrPerUsd();
  return {
    balanceMicros: w.balanceMicros,
    reservedMicros: w.reservedMicros,
    availableMicros: w.balanceMicros - w.reservedMicros,
    balanceInr: Math.round((w.balanceMicros / 1_000_000) * rate * 100) / 100,
    inrPerUsd: rate,
  };
}

export async function ledger(actor: Actor, q: { cursor?: string; limit?: number; type?: string }): Promise<Page<LedgerEntry>> {
  requireActor(actor);
  const limit = q.limit ?? 25;
  let query = db
    .selectFrom("ledger")
    .select(["id", "type", "amount_micros", "balance_after_micros", "description", "created_at", atKey("created_at")])
    .where("user_id", "=", actor.id);
  if (q.type) query = query.where("type", "=", q.type as LedgerEntry["type"]);
  const rows = await query.where(olderThan("created_at", "id", decodeTime(q.cursor))).orderBy("created_at", "desc").orderBy("id", "desc").limit(limit + 1).execute();
  const page = timePage(rows, limit);
  return {
    items: page.items.map((r) => ({ id: r.id, type: r.type, amountMicros: Number(r.amount_micros), balanceAfterMicros: Number(r.balance_after_micros), description: r.description, createdAt: r.created_at.toISOString() })),
    nextCursor: page.nextCursor,
  };
}

// ─── Free credits ───────────────────────────────────────────────────────────

/** The one-time credit for a new account, booked when it becomes ACTIVE. Idempotent. */
export async function grantSignupCredit(userId: string, exec: Executor): Promise<void> {
  const { signupCreditMicros } = await getSettings(exec);
  await ensureWallet(userId, exec);
  if (signupCreditMicros > 0) await credit({ userId, type: "SIGNUP", amountMicros: signupCreditMicros, refType: "signup", refId: userId, description: "Welcome credit" }, exec);
}

export async function redeemPromo(actor: Actor, rawCode: string, meta: RequestMeta): Promise<{ creditedMicros: number; wallet: Wallet }> {
  requireActive(actor);
  const code = rawCode.trim();
  const amount = await db.transaction().execute(async (trx) => {
    const promo = await trx.selectFrom("promo_codes").selectAll().where("code", "=", code).forUpdate().executeTakeFirst();
    if (!promo || !promo.active) throw notFound("That code does not exist", "PROMO_NOT_FOUND");
    if (promo.expires_at && promo.expires_at <= new Date()) throw new HttpError(410, "That code has expired", "PROMO_EXPIRED");
    if (promo.max_redemptions !== null && promo.redeemed_count >= promo.max_redemptions) throw new HttpError(410, "That code has been fully redeemed", "PROMO_EXPIRED");
    const inserted = await trx.insertInto("promo_redemptions").values({ promo_id: promo.id, user_id: actor.id }).onConflict((oc) => oc.doNothing()).returning("promo_id").executeTakeFirst();
    if (!inserted) throw conflict("You have already used this code", "PROMO_USED");
    await trx.updateTable("promo_codes").set((eb) => ({ redeemed_count: eb("redeemed_count", "+", 1) })).where("id", "=", promo.id).execute();
    const amountMicros = Number(promo.amount_micros);
    await credit({ userId: actor.id, type: "PROMO", amountMicros, refType: "promo", refId: `${promo.id}:${actor.id}`, description: `Promo code ${promo.code}` }, trx);
    await audit({ actorId: actor.id, action: "promo.redeemed", entityType: "promo", entityId: promo.id, ip: meta.ip, data: { amountMicros } }, trx);
    return amountMicros;
  });
  return { creditedMicros: amount, wallet: await walletView(actor.id) };
}

// ─── Top-ups ────────────────────────────────────────────────────────────────

type TopupRow = { id: string; gateway: GatewayName; currency: string; amount_minor: string | number; tax_minor: string | number; total_minor: string | number; fx_inr_per_usd: string | number | null; credit_micros: string | number; status: Topup["status"]; created_at: Date; paid_at: Date | null };

function toTopup(r: TopupRow): Topup {
  return {
    id: r.id,
    gateway: r.gateway,
    currency: r.currency as Currency,
    amountMinor: Number(r.amount_minor),
    taxMinor: Number(r.tax_minor),
    totalMinor: Number(r.total_minor),
    inrPerUsd: r.fx_inr_per_usd === null ? null : Number(r.fx_inr_per_usd),
    creditMicros: Number(r.credit_micros),
    status: r.status,
    createdAt: r.created_at.toISOString(),
    paidAt: r.paid_at?.toISOString() ?? null,
  };
}

/**
 * Price a top-up. `amount` is major units (dollars or rupees) before tax; tax is added on
 * top and never credited. USD credits 1:1; INR credits at the locked rate, rounded down
 * to the micro-dollar so the platform never credits more than was paid.
 */
export function priceTopup(currency: Currency, amount: number, taxBps: number, rate: number): { amountMinor: number; taxMinor: number; totalMinor: number; creditMicros: number; inrPerUsd: number | null } {
  const amountMinor = Math.round(amount * 100);
  const taxMinor = Math.ceil((amountMinor * taxBps) / 10_000);
  const creditMicros = currency === "USD" ? amountMinor * 10_000 : Math.floor((amountMinor * 10_000) / rate);
  return { amountMinor, taxMinor, totalMinor: amountMinor + taxMinor, creditMicros, inrPerUsd: currency === "INR" ? rate : null };
}

export async function createTopup(actor: Actor, input: { currency: Currency; amount: number }, meta: RequestMeta): Promise<TopupOrder> {
  requireActive(actor);
  const s = await getSettings();
  const [min, max] = input.currency === "USD" ? [s.topupLimits.usdMin, s.topupLimits.usdMax] : [s.topupLimits.inrMin, s.topupLimits.inrMax];
  if (!(input.amount >= min && input.amount <= max)) throw badRequest(`Top up between ${min} and ${max} ${input.currency}`, "TOPUP_AMOUNT", { min, max });
  const gateway = gatewayFor(input.currency);
  if (!gateway) throw conflict(`${input.currency} top-ups are not available right now`, "GATEWAY_UNAVAILABLE");
  const priced = priceTopup(input.currency, input.amount, s.taxBps, await inrPerUsd());
  const user = await db.selectFrom("users").select("email").where("id", "=", actor.id).executeTakeFirstOrThrow();
  const id = newId();
  const product = await appName();
  const { orderRef, checkout } = await gateway.createCheckout({ topupId: id, currency: input.currency, totalMinor: priced.totalMinor, description: `${product} credit`, email: user.email });
  await db
    .insertInto("topups")
    .values({
      id,
      user_id: actor.id,
      gateway: gateway.name,
      currency: input.currency,
      amount_minor: priced.amountMinor,
      tax_minor: priced.taxMinor,
      total_minor: priced.totalMinor,
      fx_inr_per_usd: priced.inrPerUsd === null ? null : String(priced.inrPerUsd),
      credit_micros: priced.creditMicros,
      gateway_order_id: orderRef,
    })
    .execute();
  await audit({ actorId: actor.id, action: "topup.created", entityType: "topup", entityId: id, ip: meta.ip, data: { gateway: gateway.name, currency: input.currency, totalMinor: priced.totalMinor } });
  return { id, gateway: gateway.name, currency: input.currency, amountMinor: priced.amountMinor, taxMinor: priced.taxMinor, totalMinor: priced.totalMinor, inrPerUsd: priced.inrPerUsd, creditMicros: priced.creditMicros, checkout };
}

export type FulfilResult = "CREDITED" | "ALREADY_PAID" | "NOT_FOUND" | "MISMATCH";

/** The single path from a confirmed payment to credit. See the header. */
export async function fulfilTopup(gateway: GatewayName, orderRef: string, paid: { paymentRef: string | null; amountMinor: number | null; currency: string | null }, exec?: Executor): Promise<FulfilResult> {
  const run = async (trx: Executor): Promise<FulfilResult> => {
    const t = await trx.selectFrom("topups").selectAll().where("gateway", "=", gateway).where("gateway_order_id", "=", orderRef).forUpdate().executeTakeFirst();
    if (!t) return "NOT_FOUND";
    if (t.status === "PAID" || t.status === "REFUNDED") return "ALREADY_PAID";
    if (paid.amountMinor !== Number(t.total_minor) || (paid.currency ?? "").toUpperCase() !== t.currency) {
      logger.error({ topupId: t.id, gateway, expected: { amount: Number(t.total_minor), currency: t.currency }, got: { amount: paid.amountMinor, currency: paid.currency } }, "top-up amount mismatch: not credited");
      await trx.updateTable("topups").set({ status: "FAILED", failure_reason: "AMOUNT_MISMATCH" }).where("id", "=", t.id).execute();
      return "MISMATCH";
    }
    await trx.updateTable("topups").set({ status: "PAID", gateway_payment_id: paid.paymentRef, paid_at: new Date(), failure_reason: null }).where("id", "=", t.id).execute();
    const label = t.currency === "INR" ? `Top-up of ₹${(Number(t.amount_minor) / 100).toFixed(2)} at ₹${Number(t.fx_inr_per_usd).toFixed(4)}/USD` : `Top-up of $${(Number(t.amount_minor) / 100).toFixed(2)}`;
    await credit({ userId: t.user_id, type: "TOPUP", amountMicros: Number(t.credit_micros), refType: "topup", refId: t.id, description: label }, trx);
    await audit({ actorId: t.user_id, action: "topup.paid", entityType: "topup", entityId: t.id, data: { gateway, creditMicros: Number(t.credit_micros) } }, trx);
    return "CREDITED";
  };
  return exec ? run(exec) : db.transaction().execute(run);
}

/** Razorpay checkout.js success: verify the signature, confirm the captured amount with Razorpay, then fulfil. */
export async function verifyRazorpay(actor: Actor, input: { orderId: string; paymentId: string; signature: string }): Promise<Topup> {
  requireActor(actor);
  const t = await db.selectFrom("topups").select(["id", "user_id"]).where("gateway", "=", "RAZORPAY").where("gateway_order_id", "=", input.orderId).executeTakeFirst();
  if (!t || t.user_id !== actor.id) throw notFound("Top-up not found", "TOPUP_NOT_FOUND");
  if (!config.RAZORPAY_KEY_SECRET || !verifyRazorpayPaymentSignature(input.orderId, input.paymentId, input.signature, config.RAZORPAY_KEY_SECRET)) throw badRequest("The payment signature does not verify", "SIGNATURE_INVALID");
  const p = await razorpayGateway.fetchPayment(input.paymentId);
  if (!p.captured || p.orderRef !== input.orderId) throw conflict("The payment is not captured yet", "PAYMENT_PENDING");
  await fulfilTopup("RAZORPAY", input.orderId, { paymentRef: input.paymentId, amountMinor: p.amountMinor, currency: p.currency });
  return topup(actor, t.id);
}

/** Development only: confirm a stub top-up as if the gateway had paid it. */
export async function confirmStubTopup(actor: Actor, id: string): Promise<Topup> {
  requireActor(actor);
  if (!config.PAYMENTS_STUB) throw forbidden("The stub gateway is off", "STUB_DISABLED");
  const t = await db.selectFrom("topups").selectAll().where("id", "=", id).where("user_id", "=", actor.id).executeTakeFirst();
  if (!t || t.gateway !== "STUB") throw notFound("Top-up not found", "TOPUP_NOT_FOUND");
  await fulfilTopup("STUB", t.gateway_order_id, { paymentRef: `stub_pay_${t.id}`, amountMinor: Number(t.total_minor), currency: t.currency });
  return topup(actor, id);
}

/**
 * A gateway webhook. The signature is checked over the raw body first; then, in one
 * transaction, the event id is recorded (a duplicate delivery stops here) and the
 * top-up fulfilled, so an event whose fulfilment fails is not marked seen and the
 * gateway's retry gets another chance.
 */
export async function handleWebhook(gatewayName: "STRIPE" | "RAZORPAY", rawBody: Buffer, headers: Record<string, string | string[] | undefined>): Promise<{ status: number }> {
  let event: PaymentEvent;
  try {
    event = gatewayByName(gatewayName).parseWebhook(rawBody, headers);
  } catch (err) {
    if (err instanceof WebhookSignatureError) {
      logger.warn({ gateway: gatewayName, reason: err.message }, "webhook refused");
      return { status: 400 };
    }
    throw err;
  }
  try {
    await db.transaction().execute(async (trx) => {
      const fresh = await trx.insertInto("payment_webhook_events").values({ gateway: gatewayName, event_id: event.id }).onConflict((oc) => oc.doNothing()).returning("event_id").executeTakeFirst();
      if (!fresh || !event.orderRef) return;
      if (event.type === "PAID") await fulfilTopup(gatewayName, event.orderRef, event, trx);
      if (event.type === "FAILED") {
        await trx.updateTable("topups").set({ status: "FAILED", failure_reason: (event.failureReason ?? "PAYMENT_FAILED").slice(0, 300) }).where("gateway", "=", gatewayName).where("gateway_order_id", "=", event.orderRef).where("status", "=", "CREATED").execute();
      }
    });
    return { status: 200 };
  } catch (err) {
    captureError(err, { where: "webhook", gateway: gatewayName, eventId: event.id });
    return { status: 500 };
  }
}

export async function topups(actor: Actor, q: { cursor?: string; limit?: number }): Promise<Page<Topup>> {
  requireActor(actor);
  const limit = q.limit ?? 25;
  const rows = await db
    .selectFrom("topups")
    .select(["id", "gateway", "currency", "amount_minor", "tax_minor", "total_minor", "fx_inr_per_usd", "credit_micros", "status", "created_at", "paid_at", atKey("created_at")])
    .where("user_id", "=", actor.id)
    .where(olderThan("created_at", "id", decodeTime(q.cursor)))
    .orderBy("created_at", "desc")
    .orderBy("id", "desc")
    .limit(limit + 1)
    .execute();
  const page = timePage(rows, limit);
  return { items: page.items.map(toTopup), nextCursor: page.nextCursor };
}

export async function topup(actor: Actor, id: string): Promise<Topup> {
  requireActor(actor);
  const t = await db
    .selectFrom("topups")
    .select(["id", "gateway", "currency", "amount_minor", "tax_minor", "total_minor", "fx_inr_per_usd", "credit_micros", "status", "created_at", "paid_at"])
    .where("id", "=", id)
    .where("user_id", "=", actor.id)
    .executeTakeFirst();
  if (!t) throw notFound("Top-up not found", "TOPUP_NOT_FOUND");
  return toTopup(t);
}

const money = (minor: number, currency: string) => `${currency === "INR" ? "INR" : "USD"} ${(minor / 100).toFixed(2)}`;

/** A PDF receipt for a paid top-up. */
export async function receiptPdf(actor: Actor, id: string): Promise<Buffer> {
  const t = await topup(actor, id);
  if (t.status !== "PAID" && t.status !== "REFUNDED") throw conflict("Receipts are issued for paid top-ups", "TOPUP_NOT_PAID");
  const [user, s] = await Promise.all([db.selectFrom("users").select(["email", "display_name"]).where("id", "=", actor.id).executeTakeFirstOrThrow(), getSettings()]);
  const doc = new PDFDocument({ size: "A4", margin: 56, info: { Title: `Receipt ${t.id}` } });
  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve) => doc.on("end", () => resolve(Buffer.concat(chunks))));
  doc.fontSize(20).text(s.appName);
  doc.moveDown(0.3).fontSize(10).fillColor("#555").text("Receipt for wallet credit");
  doc.moveDown(1.5).fillColor("#000").fontSize(11);
  const row = (k: string, v: string) => doc.text(`${k}: ${v}`);
  row("Receipt", t.id);
  row("Paid on", (t.paidAt ?? t.createdAt).slice(0, 10));
  row("Billed to", `${user.display_name} <${user.email}>`);
  row("Paid with", t.gateway === "STRIPE" ? "Stripe" : t.gateway === "RAZORPAY" ? "Razorpay" : "Test gateway");
  doc.moveDown();
  row("Credit", money(t.amountMinor, t.currency));
  if (t.taxMinor > 0) row(s.taxLabel, money(t.taxMinor, t.currency));
  row("Total charged", money(t.totalMinor, t.currency));
  if (t.inrPerUsd) row("Exchange rate", `${t.inrPerUsd.toFixed(4)} INR per USD (locked when the order was created)`);
  row("Wallet credited", `USD ${(t.creditMicros / 1_000_000).toFixed(6)}`);
  if (t.status === "REFUNDED") row("Status", "Refunded");
  if (s.supportEmail) doc.moveDown(2).fontSize(9).fillColor("#555").text(`Questions: ${s.supportEmail}`);
  doc.end();
  return done;
}

// ─── Admin: refund a top-up ─────────────────────────────────────────────────

export async function refundTopup(adminId: string, id: string, reason: string, meta: RequestMeta): Promise<void> {
  await db.transaction().execute(async (trx) => {
    const t = await trx.selectFrom("topups").selectAll().where("id", "=", id).forUpdate().executeTakeFirst();
    if (!t) throw notFound("Top-up not found", "TOPUP_NOT_FOUND");
    if (t.status !== "PAID") throw conflict("Only paid top-ups can be refunded", "TOPUP_NOT_PAID");
    await trx.updateTable("topups").set({ status: "REFUNDED", refunded_at: new Date() }).where("id", "=", id).execute();
    await credit({ userId: t.user_id, type: "REFUND", amountMicros: -Number(t.credit_micros), refType: "topup", refId: t.id, description: `Refund of top-up: ${reason}`.slice(0, 300), actorId: adminId }, trx);
    await audit({ actorId: adminId, action: "topup.refunded", entityType: "topup", entityId: id, ip: meta.ip, data: { reason, creditMicros: Number(t.credit_micros) } }, trx);
  });
}
