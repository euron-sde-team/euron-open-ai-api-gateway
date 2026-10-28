/**
 * Money in: top-ups through Stripe (USD) and Razorpay (INR) against the stubs, the stub
 * gateway, webhooks racing the browser's verify, the locked FX rate, tax, refunds,
 * promo codes and the signup credit. The ledger always explains the balance.
 */
import request from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "../../src/db/kysely";
import { clearFxCache } from "../../src/services/fx.service";
import { clearSentMail, sentMail } from "../../src/integrations/mail/mailer";
import { anon, app, as, createUser, PASSWORD, resetSettings, setSettings, stubPost, walletOf } from "./harness";

beforeEach(async () => {
  await resetSettings();
  clearFxCache();
});
afterAll(async () => resetSettings());

async function ledgerSum(userId: string): Promise<number> {
  const r = await db.selectFrom("ledger").select((eb) => eb.fn.coalesce(eb.fn.sum<number>("amount_micros"), eb.lit(0)).as("s")).where("user_id", "=", userId).executeTakeFirstOrThrow();
  return Number(r.s);
}

const stripeWebhook = (body: string, signature: string) => request(app).post("/api/webhooks/stripe").set("Content-Type", "application/json").set("Stripe-Signature", signature).send(body);
const razorpayWebhook = (body: string, signature: string, eventId: string) => request(app).post("/api/webhooks/razorpay").set("Content-Type", "application/json").set("X-Razorpay-Signature", signature).set("X-Razorpay-Event-Id", eventId).send(body);

describe("Stripe (USD)", () => {
  it("opens a Checkout Session and credits once when the webhook arrives, however often", async () => {
    const ada = await createUser();
    const order = await as(ada).post("/api/billing/topups").send({ currency: "USD", amount: 10 });
    expect(order.status).toBe(201);
    expect(order.body).toMatchObject({ gateway: "STRIPE", currency: "USD", amountMinor: 1000, taxMinor: 0, totalMinor: 1000, creditMicros: 10_000_000, inrPerUsd: null, checkout: { kind: "redirect" } });
    const sessionId = (await db.selectFrom("topups").select("gateway_order_id").where("id", "=", order.body.id).executeTakeFirstOrThrow()).gateway_order_id;
    expect(order.body.checkout.url).toContain(sessionId);

    const paid = await stubPost<{ body: string; signature: string }>("/__/stripe/pay", { sessionId });
    expect((await stripeWebhook(paid.body, paid.signature)).status).toBe(200);
    expect((await stripeWebhook(paid.body, paid.signature)).status).toBe(200);
    expect(await walletOf(ada.id)).toEqual({ balance: 10_000_000, reserved: 0 });
    expect(await ledgerSum(ada.id)).toBe(10_000_000);
    const topup = await as(ada).get(`/api/billing/topups/${order.body.id}`);
    expect(topup.body).toMatchObject({ status: "PAID" });
  });

  it("refuses a webhook with a bad signature and credits nothing", async () => {
    const ada = await createUser();
    const order = await as(ada).post("/api/billing/topups").send({ currency: "USD", amount: 10 });
    const sessionId = (await db.selectFrom("topups").select("gateway_order_id").where("id", "=", order.body.id).executeTakeFirstOrThrow()).gateway_order_id;
    const paid = await stubPost<{ body: string; signature: string }>("/__/stripe/pay", { sessionId });
    expect((await stripeWebhook(paid.body, paid.signature.replace(/v1=[0-9a-f]+/, `v1=${"0".repeat(64)}`))).status).toBe(400);
    expect((await stripeWebhook(paid.body.replace("1000", "9999"), paid.signature)).status).toBe(400);
    expect((await walletOf(ada.id)).balance).toBe(0);
  });

  it("adds tax on top without crediting it", async () => {
    await setSettings({ taxBps: 1_800, taxLabel: "GST" });
    const ada = await createUser();
    const order = await as(ada).post("/api/billing/topups").send({ currency: "USD", amount: 10 });
    expect(order.body).toMatchObject({ amountMinor: 1000, taxMinor: 180, totalMinor: 1180, creditMicros: 10_000_000 });
    const sessionId = (await db.selectFrom("topups").select("gateway_order_id").where("id", "=", order.body.id).executeTakeFirstOrThrow()).gateway_order_id;
    const paid = await stubPost<{ body: string; signature: string }>("/__/stripe/pay", { sessionId });
    expect((await stripeWebhook(paid.body, paid.signature)).status).toBe(200);
    expect((await walletOf(ada.id)).balance).toBe(10_000_000);
  });

  it("refuses amounts outside the limits", async () => {
    const ada = await createUser();
    const res = await as(ada).post("/api/billing/topups").send({ currency: "USD", amount: 1 });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("TOPUP_AMOUNT");
  });
});

describe("Razorpay (INR)", () => {
  it("locks the FX rate at order time and credits exactly what was shown, whichever of verify and webhook comes first", async () => {
    const ada = await createUser();
    const order = await as(ada).post("/api/billing/topups").send({ currency: "INR", amount: 800 });
    expect(order.status).toBe(201);
    // FX_FIXED_INR_PER_USD=80 in the test env: Rs 800 is $10.
    expect(order.body).toMatchObject({ gateway: "RAZORPAY", currency: "INR", totalMinor: 80_000, inrPerUsd: 80, creditMicros: 10_000_000, checkout: { kind: "razorpay", keyId: "rzp_test_stub", amount: 80_000, currency: "INR" } });

    // The rate moves before the buyer pays: the order keeps its rate.
    await db.insertInto("fx_rates").values({ id: "01JDK4V7Q80000000000000001", inr_per_usd: "90", source: "test" }).execute();
    clearFxCache();

    const paid = await stubPost<{ paymentId: string; signature: string; webhook: { body: string; signature: string; eventId: string } }>("/__/razorpay/pay", { orderId: order.body.checkout.orderId });
    const [verify, hook] = await Promise.all([
      as(ada).post("/api/billing/razorpay/verify").send({ orderId: order.body.checkout.orderId, paymentId: paid.paymentId, signature: paid.signature }),
      razorpayWebhook(paid.webhook.body, paid.webhook.signature, paid.webhook.eventId),
    ]);
    expect(verify.status).toBe(200);
    expect(verify.body.status).toBe("PAID");
    expect(hook.status).toBe(200);
    expect(await walletOf(ada.id)).toEqual({ balance: 10_000_000, reserved: 0 });
    const entries = await db.selectFrom("ledger").select(["type", "amount_micros", "description"]).where("user_id", "=", ada.id).execute();
    expect(entries).toEqual([{ type: "TOPUP", amount_micros: 10_000_000, description: "Top-up of ₹800.00 at ₹80.0000/USD" }]);
    await db.deleteFrom("fx_rates").execute();
  });

  it("refuses a forged checkout.js signature and another account's order", async () => {
    const ada = await createUser();
    const eve = await createUser();
    const order = await as(ada).post("/api/billing/topups").send({ currency: "INR", amount: 800 });
    const paid = await stubPost<{ paymentId: string; signature: string }>("/__/razorpay/pay", { orderId: order.body.checkout.orderId });
    const forged = await as(ada).post("/api/billing/razorpay/verify").send({ orderId: order.body.checkout.orderId, paymentId: paid.paymentId, signature: "0".repeat(64) });
    expect(forged.body.code).toBe("SIGNATURE_INVALID");
    const theirs = await as(eve).post("/api/billing/razorpay/verify").send({ orderId: order.body.checkout.orderId, paymentId: paid.paymentId, signature: paid.signature });
    expect(theirs.status).toBe(404);
    expect((await walletOf(ada.id)).balance).toBe(0);
    expect((await walletOf(eve.id)).balance).toBe(0);
  });

  it("does not credit a payment whose amount differs from the order", async () => {
    const ada = await createUser();
    const order = await as(ada).post("/api/billing/topups").send({ currency: "INR", amount: 800 });
    const paid = await stubPost<{ paymentId: string; signature: string }>("/__/razorpay/pay", { orderId: order.body.checkout.orderId, amount: 100 });
    await as(ada).post("/api/billing/razorpay/verify").send({ orderId: order.body.checkout.orderId, paymentId: paid.paymentId, signature: paid.signature });
    expect((await walletOf(ada.id)).balance).toBe(0);
    expect((await db.selectFrom("topups").select(["status", "failure_reason"]).where("id", "=", order.body.id).executeTakeFirstOrThrow())).toEqual({ status: "FAILED", failure_reason: "AMOUNT_MISMATCH" });
  });
});

describe("the stub gateway, receipts and refunds", () => {
  it("confirms a stub top-up when the real gateway is not configured, issues a receipt, and an admin refund debits it", async () => {
    const ada = await createUser();
    // With both gateways configured in tests, the stub is reached by marking a row STUB directly.
    const order = await as(ada).post("/api/billing/topups").send({ currency: "USD", amount: 20 });
    await db.updateTable("topups").set({ gateway: "STUB", gateway_order_id: `stub_${order.body.id}` }).where("id", "=", order.body.id).execute();
    const confirmed = await as(ada).post(`/api/billing/topups/${order.body.id}/stub-confirm`).send({});
    expect(confirmed.body.status).toBe("PAID");
    expect((await walletOf(ada.id)).balance).toBe(20_000_000);

    const pdf = await as(ada).get(`/api/billing/topups/${order.body.id}/receipt.pdf`).buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => cb(null, Buffer.concat(chunks)));
    });
    expect(pdf.headers["content-type"]).toBe("application/pdf");
    expect((pdf.body as Buffer).subarray(0, 5).toString()).toBe("%PDF-");

    const admin = await createUser({ role: "ADMIN" });
    expect((await as(admin).post(`/api/admin/topups/${order.body.id}/refund`).send({ reason: "Asked for a refund" })).status).toBe(204);
    expect((await walletOf(ada.id)).balance).toBe(0);
    expect((await as(admin).post(`/api/admin/topups/${order.body.id}/refund`).send({ reason: "Again" })).body.code).toBe("TOPUP_NOT_PAID");
    expect(await ledgerSum(ada.id)).toBe(0);
  });

  it("hides another account's top-ups", async () => {
    const ada = await createUser();
    const eve = await createUser();
    const order = await as(ada).post("/api/billing/topups").send({ currency: "USD", amount: 10 });
    expect((await as(eve).get(`/api/billing/topups/${order.body.id}`)).status).toBe(404);
    expect((await as(eve).get(`/api/billing/topups/${order.body.id}/receipt.pdf`)).status).toBe(404);
  });
});

describe("free credits", () => {
  it("redeems a promo code once per account and stops at the cap", async () => {
    const admin = await createUser({ role: "ADMIN" });
    const created = await as(admin).post("/api/admin/promos").send({ code: "TRYME5", amountMicros: 5_000_000, maxRedemptions: 2 });
    expect(created.status).toBe(201);
    const [a, b, c] = [await createUser(), await createUser(), await createUser()];
    expect((await as(a).post("/api/billing/promo").send({ code: "tryme5" })).body.creditedMicros).toBe(5_000_000);
    expect((await as(a).post("/api/billing/promo").send({ code: "TRYME5" })).body.code).toBe("PROMO_USED");
    expect((await as(b).post("/api/billing/promo").send({ code: "TRYME5" })).status).toBe(200);
    expect((await as(c).post("/api/billing/promo").send({ code: "TRYME5" })).status).toBe(410);
    expect((await as(c).post("/api/billing/promo").send({ code: "NOPE99" })).status).toBe(404);
    expect((await walletOf(a.id)).balance).toBe(5_000_000);
  });

  it("gives a new account its signup credit when it verifies its email, once", async () => {
    await setSettings({ signupCreditMicros: 2_500_000 });
    clearSentMail();
    const username = `signup${Date.now().toString(36)}`;
    await anon().post("/api/auth/signup").send({ email: `${username}@example.com`, username, displayName: "Signup Person", password: PASSWORD }).expect(202);
    const user = await db.selectFrom("users").select("id").where("username", "=", username).executeTakeFirstOrThrow();
    expect(await ledgerSum(user.id)).toBe(0);
    const link = sentMail().at(-1)!.text.match(/token=([^\s&]+)/)![1]!;
    await anon().post("/api/auth/verify-email").send({ token: decodeURIComponent(link) }).expect(200);
    expect(await ledgerSum(user.id)).toBe(2_500_000);
    const { grantSignupCredit } = await import("../../src/services/billing.service");
    await db.transaction().execute((trx) => grantSignupCredit(user.id, trx));
    expect(await ledgerSum(user.id)).toBe(2_500_000);
  });

  it("lets an admin grant and adjust credit, audited", async () => {
    const admin = await createUser({ role: "ADMIN" });
    const ada = await createUser();
    const granted = await as(admin).post(`/api/admin/users/${ada.id}/credit`).send({ type: "GRANT", amountMicros: 3_000_000, reason: "Hackathon credit" });
    expect(granted.status).toBe(200);
    expect(granted.body.balanceMicros).toBe(3_000_000);
    await as(admin).post(`/api/admin/users/${ada.id}/credit`).send({ type: "ADJUSTMENT", amountMicros: -500_000, reason: "Correction" });
    expect((await walletOf(ada.id)).balance).toBe(2_500_000);
    expect((await as(admin).post(`/api/admin/users/${ada.id}/credit`).send({ type: "GRANT", amountMicros: -1, reason: "nope" })).status).toBe(400);
    const audit = await db.selectFrom("audit_log").select("action").where("entity_id", "=", ada.id).where("action", "like", "wallet.%").execute();
    expect(audit.map((a) => a.action).sort()).toEqual(["wallet.adjustment", "wallet.grant"]);
    expect((await as(ada).get("/api/billing/ledger")).body.items.map((e: { type: string }) => e.type)).toEqual(["ADJUSTMENT", "GRANT"]);
  });
});
