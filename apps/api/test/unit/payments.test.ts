import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  formEncode,
  normalizeRazorpayEvent,
  normalizeStripeEvent,
  verifyRazorpayPaymentSignature,
  verifyRazorpayWebhookSignature,
  verifyStripeSignature,
} from "../../src/billing/payments";

const hmac = (secret: string, payload: string) =>
  createHmac("sha256", secret).update(payload).digest("hex");

describe("verifyStripeSignature", () => {
  const secret = "whsec_test";
  const body = Buffer.from('{"id":"evt_1","type":"checkout.session.completed"}');
  const t = 1_700_000_000;
  const sig = hmac(secret, `${t}.${body.toString()}`);

  it("accepts a valid signature", () => {
    expect(verifyStripeSignature(body, `t=${t},v1=${sig}`, secret, t)).toBeNull();
  });

  it("refuses a wrong secret and a tampered body", () => {
    expect(verifyStripeSignature(body, `t=${t},v1=${sig}`, "whsec_other", t)).toBe(
      "signature mismatch"
    );
    expect(
      verifyStripeSignature(Buffer.from('{"id":"evt_2"}'), `t=${t},v1=${sig}`, secret, t)
    ).toBe("signature mismatch");
  });

  it("refuses a timestamp more than 300 seconds away", () => {
    expect(verifyStripeSignature(body, `t=${t},v1=${sig}`, secret, t + 300)).toBeNull();
    expect(verifyStripeSignature(body, `t=${t},v1=${sig}`, secret, t + 301)).toBe(
      "timestamp outside tolerance"
    );
    expect(verifyStripeSignature(body, `t=${t},v1=${sig}`, secret, t - 301)).toBe(
      "timestamp outside tolerance"
    );
  });

  it("accepts any one of several v1 signatures", () => {
    expect(
      verifyStripeSignature(body, `t=${t},v1=${"0".repeat(64)},v1=${sig}`, secret, t)
    ).toBeNull();
  });

  it("refuses a missing or malformed header", () => {
    expect(verifyStripeSignature(body, undefined, secret, t)).toBe("missing Stripe-Signature");
    expect(verifyStripeSignature(body, "garbage", secret, t)).toBe("malformed Stripe-Signature");
    expect(verifyStripeSignature(body, `t=${t}`, secret, t)).toBe("malformed Stripe-Signature");
    expect(verifyStripeSignature(body, `v1=${sig}`, secret, t)).toBe("malformed Stripe-Signature");
  });
});

describe("normalizeStripeEvent", () => {
  const session = (type: string, object: Record<string, unknown>) => ({
    id: "evt_1",
    type,
    data: { object },
  });

  it("turns a paid session into PAID with amount, currency and references", () => {
    expect(
      normalizeStripeEvent(
        session("checkout.session.completed", {
          id: "cs_1",
          payment_status: "paid",
          payment_intent: "pi_1",
          amount_total: 2500,
          currency: "usd",
        })
      )
    ).toEqual({
      id: "evt_1",
      type: "PAID",
      rawType: "checkout.session.completed",
      orderRef: "cs_1",
      paymentRef: "pi_1",
      amountMinor: 2500,
      currency: "USD",
      failureReason: null,
    });
    expect(
      normalizeStripeEvent(
        session("checkout.session.async_payment_succeeded", {
          id: "cs_2",
          payment_status: "paid",
          payment_intent: { id: "pi_2" },
          amount_total: 100,
          currency: "usd",
        })
      ).paymentRef
    ).toBe("pi_2");
  });

  it("ignores an unpaid session", () => {
    const e = normalizeStripeEvent(
      session("checkout.session.completed", { id: "cs_1", payment_status: "unpaid" })
    );
    expect(e.type).toBe("IGNORED");
    expect(e.orderRef).toBeNull();
  });

  it("marks expired and failed sessions FAILED", () => {
    expect(normalizeStripeEvent(session("checkout.session.expired", { id: "cs_1" }))).toMatchObject(
      { type: "FAILED", orderRef: "cs_1", failureReason: "CHECKOUT_EXPIRED" }
    );
    expect(
      normalizeStripeEvent(session("checkout.session.async_payment_failed", { id: "cs_1" }))
    ).toMatchObject({ type: "FAILED", orderRef: "cs_1", failureReason: "PAYMENT_FAILED" });
  });

  it("ignores other events", () => {
    expect(normalizeStripeEvent(session("charge.refunded", { id: "ch_1" }))).toMatchObject({
      id: "evt_1",
      type: "IGNORED",
      rawType: "charge.refunded",
    });
    expect(normalizeStripeEvent(null)).toMatchObject({ id: "", type: "IGNORED" });
  });
});

describe("Razorpay signatures", () => {
  it("verifies the checkout payment signature over order|payment", () => {
    const sig = hmac("rzp_secret_test", "order_1|pay_1");
    expect(verifyRazorpayPaymentSignature("order_1", "pay_1", sig, "rzp_secret_test")).toBe(true);
    expect(verifyRazorpayPaymentSignature("order_1", "pay_2", sig, "rzp_secret_test")).toBe(false);
    expect(verifyRazorpayPaymentSignature("order_1", "pay_1", sig, "rzp_secret_other")).toBe(false);
  });

  it("verifies the webhook signature over the raw body", () => {
    const body = Buffer.from('{"event":"payment.captured"}');
    const sig = hmac("whsec_test", body.toString());
    expect(verifyRazorpayWebhookSignature(body, sig, "whsec_test")).toBe(true);
    expect(verifyRazorpayWebhookSignature(body, sig.toUpperCase(), "whsec_test")).toBe(true);
    expect(verifyRazorpayWebhookSignature(Buffer.from('{"event":"x"}'), sig, "whsec_test")).toBe(
      false
    );
    expect(verifyRazorpayWebhookSignature(body, undefined, "whsec_test")).toBe(false);
    expect(verifyRazorpayWebhookSignature(body, "abc", "whsec_test")).toBe(false);
  });
});

describe("normalizeRazorpayEvent", () => {
  it("payment.captured is PAID with the order and payment ids", () => {
    const body = {
      event: "payment.captured",
      payload: {
        payment: { entity: { id: "pay_1", order_id: "order_1", amount: 50000, currency: "inr" } },
      },
    };
    expect(normalizeRazorpayEvent(body, "ev_1")).toEqual({
      id: "ev_1",
      type: "PAID",
      rawType: "payment.captured",
      orderRef: "order_1",
      paymentRef: "pay_1",
      amountMinor: 50000,
      currency: "INR",
      failureReason: null,
    });
    expect(
      normalizeRazorpayEvent(
        { event: "payment.captured", payload: { payment: { entity: { id: "pay_1" } } } },
        "ev_2"
      ).type
    ).toBe("IGNORED");
  });

  it("order.paid prefers the payment entity and falls back to the order", () => {
    const orderOnly = {
      event: "order.paid",
      payload: { order: { entity: { id: "order_1", amount_paid: 50000, currency: "INR" } } },
    };
    expect(normalizeRazorpayEvent(orderOnly, "ev_1")).toMatchObject({
      type: "PAID",
      orderRef: "order_1",
      paymentRef: null,
      amountMinor: 50000,
      currency: "INR",
    });
    const both = {
      event: "order.paid",
      payload: {
        order: { entity: { id: "order_1", amount_paid: 1, currency: "INR" } },
        payment: { entity: { id: "pay_1", amount: 50000, currency: "INR" } },
      },
    };
    expect(normalizeRazorpayEvent(both, "ev_1")).toMatchObject({
      paymentRef: "pay_1",
      amountMinor: 50000,
    });
    expect(normalizeRazorpayEvent({ event: "order.paid", payload: {} }, "ev_1").type).toBe(
      "IGNORED"
    );
  });

  it("payment.failed is FAILED with the reason", () => {
    const failed = (extra: Record<string, unknown>) =>
      normalizeRazorpayEvent(
        {
          event: "payment.failed",
          payload: { payment: { entity: { id: "pay_1", order_id: "order_1", ...extra } } },
        },
        "ev_1"
      );
    expect(
      failed({ error_reason: "card_declined", error_code: "BAD_REQUEST_ERROR" })
    ).toMatchObject({
      type: "FAILED",
      orderRef: "order_1",
      paymentRef: "pay_1",
      failureReason: "card_declined",
    });
    expect(failed({ error_code: "BAD_REQUEST_ERROR" }).failureReason).toBe("BAD_REQUEST_ERROR");
    expect(failed({}).failureReason).toBe("PAYMENT_FAILED");
  });

  it("ignores unknown events", () => {
    expect(normalizeRazorpayEvent({ event: "refund.created" }, "ev_9")).toEqual({
      id: "ev_9",
      type: "IGNORED",
      rawType: "refund.created",
      orderRef: null,
      paymentRef: null,
      amountMinor: null,
      currency: null,
      failureReason: null,
    });
  });
});

describe("formEncode", () => {
  it("encodes nested objects and arrays with brackets and skips null and undefined", () => {
    const out = formEncode({
      mode: "payment",
      metadata: { topup_id: "t1" },
      line_items: [{ quantity: 1, price_data: { currency: "usd", unit_amount: 500 } }],
      skip: undefined,
      none: null,
    });
    expect([...new URLSearchParams(out)]).toEqual([
      ["mode", "payment"],
      ["metadata[topup_id]", "t1"],
      ["line_items[0][quantity]", "1"],
      ["line_items[0][price_data][currency]", "usd"],
      ["line_items[0][price_data][unit_amount]", "500"],
    ]);
  });
});
