/**
 * Payment gateways for wallet top-ups: Stripe takes USD (a hosted Checkout Session),
 * Razorpay takes INR (an Order paid through checkout.js), and with PAYMENTS_STUB=true a
 * stub gateway confirms in the browser for development. Plain REST, no SDKs; the API
 * base URLs come from config so apps/stubs stands in for both gateways in tests.
 *
 * Rules every gateway keeps:
 *   - a webhook's signature is verified over the exact raw bytes first, in constant
 *     time; nothing is parsed before that (WebhookSignatureError otherwise);
 *   - an event says *that* money moved and for which order; the amount and currency are
 *     checked against the top-up row by billing.service (fulfilTopup), never trusted;
 *   - secrets never appear in errors, logs or return values.
 *
 * Stripe-Signature: `t=<unix>,v1=<hex>` with v1 = HMAC-SHA256(secret, "<t>.<raw body>"),
 * refused when older than 300 seconds. Razorpay: HMAC-SHA256(webhook secret, raw body)
 * in X-Razorpay-Signature, and checkout.js returns HMAC-SHA256(key secret,
 * "<order_id>|<payment_id>").
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { Currency, PaymentGateway as GatewayName, TopupOrder } from "@open-gateway/types";
import { config, isRealKey, razorpayEnabled, stripeEnabled } from "../core/config";
import { HttpError } from "../core/errors";

export const STRIPE_TOLERANCE_SECONDS = 300;

export class WebhookSignatureError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "WebhookSignatureError";
  }
}

/** A gateway call failed. Safe to show: no secrets inside. */
export class PaymentGatewayError extends HttpError {
  constructor(message: string) {
    super(502, message, "GATEWAY_ERROR");
  }
}

export interface PaymentEvent {
  /** The gateway's event id: the dedupe key in payment_webhook_events. */
  id: string;
  type: "PAID" | "FAILED" | "IGNORED";
  rawType: string;
  /** topups.gateway_order_id: a Checkout Session id or a Razorpay order id. */
  orderRef: string | null;
  paymentRef: string | null;
  amountMinor: number | null;
  currency: string | null;
  failureReason: string | null;
}

export interface CheckoutInput {
  topupId: string;
  currency: Currency;
  totalMinor: number;
  description: string;
  email: string;
}

export interface Checkout {
  orderRef: string;
  checkout: TopupOrder["checkout"];
}

export interface Gateway {
  readonly name: GatewayName;
  createCheckout(input: CheckoutInput): Promise<Checkout>;
  parseWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): PaymentEvent;
}

function header(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
  const v = headers[name.toLowerCase()] ?? headers[name];
  return Array.isArray(v) ? v[0] : v;
}

function hmacHex(secret: string, payload: string | Buffer): string {
  return createHmac("sha256", secret).update(payload).digest("hex");
}

function sameHex(expected: string, given: string | undefined): boolean {
  if (!given) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(given.trim().toLowerCase());
  return a.length === b.length && timingSafeEqual(a, b);
}

const str = (v: unknown) => (typeof v === "string" && v ? v : null);
const upper = (v: unknown) => (typeof v === "string" ? v.toUpperCase() : null);
const ignored = (id: string, rawType: string): PaymentEvent => ({ id, type: "IGNORED", rawType, orderRef: null, paymentRef: null, amountMinor: null, currency: null, failureReason: null });

async function gatewayFetch(label: string, url: string, init: RequestInit): Promise<any> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, redirect: "error", signal: AbortSignal.timeout(15_000) });
  } catch {
    throw new PaymentGatewayError(`${label} is not reachable`);
  }
  const text = await res.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (!res.ok) throw new PaymentGatewayError(`${label}: ${String(body?.error?.message ?? body?.error?.description ?? `answered ${res.status}`).slice(0, 200)}`);
  return body;
}

// ─── Stripe ─────────────────────────────────────────────────────────────────

/** Stripe's bracket form encoding: { a: { b: [1] } } to "a[b][0]=1". */
export function formEncode(obj: Record<string, unknown>): string {
  const out = new URLSearchParams();
  const walk = (prefix: string, v: unknown) => {
    if (v === undefined || v === null) return;
    if (Array.isArray(v)) v.forEach((x, i) => walk(`${prefix}[${i}]`, x));
    else if (typeof v === "object") for (const [k, x] of Object.entries(v as Record<string, unknown>)) walk(prefix ? `${prefix}[${k}]` : k, x);
    else out.append(prefix, String(v));
  };
  walk("", obj);
  return out.toString();
}

/** null when the header verifies, else the reason. Any of several v1 signatures may match (a secret being rolled). */
export function verifyStripeSignature(rawBody: Buffer, signatureHeader: string | undefined, secret: string, nowSeconds = Math.floor(Date.now() / 1000)): string | null {
  if (!signatureHeader) return "missing Stripe-Signature";
  let t: number | null = null;
  const v1: string[] = [];
  for (const part of signatureHeader.split(",")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k === "t") t = Number(v);
    else if (k === "v1") v1.push(v);
  }
  if (t === null || !Number.isFinite(t) || !v1.length) return "malformed Stripe-Signature";
  if (Math.abs(nowSeconds - t) > STRIPE_TOLERANCE_SECONDS) return "timestamp outside tolerance";
  const expected = hmacHex(secret, Buffer.concat([Buffer.from(`${t}.`), rawBody]));
  return v1.some((sig) => sameHex(expected, sig)) ? null : "signature mismatch";
}

/** A verified Stripe event to a PaymentEvent. Pure. */
export function normalizeStripeEvent(event: any): PaymentEvent {
  const type = String(event?.type ?? "");
  const obj = event?.data?.object ?? {};
  const base = ignored(String(event?.id ?? ""), type);
  switch (type) {
    case "checkout.session.completed":
    case "checkout.session.async_payment_succeeded":
      if (obj.payment_status !== "paid") return base;
      return { ...base, type: "PAID", orderRef: str(obj.id), paymentRef: typeof obj.payment_intent === "string" ? obj.payment_intent : str(obj.payment_intent?.id), amountMinor: Number(obj.amount_total ?? 0), currency: upper(obj.currency) };
    case "checkout.session.async_payment_failed":
      return { ...base, type: "FAILED", orderRef: str(obj.id), failureReason: "PAYMENT_FAILED" };
    case "checkout.session.expired":
      return { ...base, type: "FAILED", orderRef: str(obj.id), failureReason: "CHECKOUT_EXPIRED" };
    default:
      return base;
  }
}

class StripeGateway implements Gateway {
  readonly name = "STRIPE" as const;

  async createCheckout(input: CheckoutInput): Promise<Checkout> {
    const web = config.APP_WEB_URL.replace(/\/$/, "");
    const s = await gatewayFetch("Stripe", `${config.STRIPE_API_BASE.replace(/\/$/, "")}/v1/checkout/sessions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.STRIPE_SECRET_KEY ?? ""}`, "Content-Type": "application/x-www-form-urlencoded", "Idempotency-Key": `topup-${input.topupId}` },
      body: formEncode({
        mode: "payment",
        success_url: `${web}/billing?topup=${input.topupId}`,
        cancel_url: `${web}/billing?topup=${input.topupId}&cancelled=1`,
        client_reference_id: input.topupId,
        customer_email: input.email,
        metadata: { topup_id: input.topupId },
        payment_intent_data: { metadata: { topup_id: input.topupId }, description: input.description.slice(0, 200) },
        line_items: [{ quantity: 1, price_data: { currency: input.currency.toLowerCase(), unit_amount: input.totalMinor, product_data: { name: input.description.slice(0, 120) } } }],
      }),
    });
    return { orderRef: String(s.id), checkout: { kind: "redirect", url: String(s.url) } };
  }

  parseWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): PaymentEvent {
    // The Terraform placeholder "set-me" is public knowledge: never accept it as a signing key.
    if (!isRealKey(config.STRIPE_WEBHOOK_SECRET)) throw new WebhookSignatureError("Stripe webhooks are not configured");
    const problem = verifyStripeSignature(rawBody, header(headers, "stripe-signature"), config.STRIPE_WEBHOOK_SECRET);
    if (problem) throw new WebhookSignatureError(problem);
    let body: unknown;
    try {
      body = JSON.parse(rawBody.toString("utf8"));
    } catch {
      throw new WebhookSignatureError("body is not JSON");
    }
    const e = normalizeStripeEvent(body);
    if (!e.id) throw new WebhookSignatureError("event has no id");
    return e;
  }
}

// ─── Razorpay ───────────────────────────────────────────────────────────────

export function verifyRazorpayPaymentSignature(orderId: string, paymentId: string, signature: string, keySecret: string): boolean {
  return sameHex(hmacHex(keySecret, `${orderId}|${paymentId}`), signature);
}

export function verifyRazorpayWebhookSignature(rawBody: Buffer, signature: string | undefined, secret: string): boolean {
  return sameHex(hmacHex(secret, rawBody), signature);
}

/** A verified Razorpay webhook body to a PaymentEvent. Pure. */
export function normalizeRazorpayEvent(body: any, eventId: string): PaymentEvent {
  const type = String(body?.event ?? "");
  const payment = body?.payload?.payment?.entity ?? null;
  const order = body?.payload?.order?.entity ?? null;
  const base = ignored(eventId, type);
  switch (type) {
    case "payment.captured":
      if (!payment?.order_id) return base;
      return { ...base, type: "PAID", orderRef: str(payment.order_id), paymentRef: str(payment.id), amountMinor: Number(payment.amount ?? 0), currency: upper(payment.currency) };
    case "order.paid":
      if (!order) return base;
      return { ...base, type: "PAID", orderRef: str(order.id), paymentRef: str(payment?.id), amountMinor: Number(payment?.amount ?? order.amount_paid ?? 0), currency: upper(payment?.currency ?? order.currency) };
    case "payment.failed":
      if (!payment?.order_id) return base;
      return { ...base, type: "FAILED", orderRef: str(payment.order_id), paymentRef: str(payment.id), failureReason: str(payment.error_reason) ?? str(payment.error_code) ?? "PAYMENT_FAILED" };
    default:
      return base;
  }
}

class RazorpayGateway implements Gateway {
  readonly name = "RAZORPAY" as const;

  private call(method: "GET" | "POST", path: string, body?: Record<string, unknown>): Promise<any> {
    const auth = Buffer.from(`${config.RAZORPAY_KEY_ID ?? ""}:${config.RAZORPAY_KEY_SECRET ?? ""}`).toString("base64");
    return gatewayFetch("Razorpay", `${config.RAZORPAY_API_BASE.replace(/\/$/, "")}${path}`, { method, headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  }

  async createCheckout(input: CheckoutInput): Promise<Checkout> {
    const o = await this.call("POST", "/v1/orders", { amount: input.totalMinor, currency: input.currency, receipt: input.topupId, notes: { topup_id: input.topupId } });
    return { orderRef: String(o.id), checkout: { kind: "razorpay", orderId: String(o.id), keyId: config.RAZORPAY_KEY_ID ?? "", amount: input.totalMinor, currency: input.currency } };
  }

  /** The captured amount of a payment (capturing it when only authorised), after checkout.js returns. */
  async fetchPayment(paymentId: string): Promise<{ captured: boolean; amountMinor: number; currency: string; orderRef: string | null }> {
    let p = await this.call("GET", `/v1/payments/${encodeURIComponent(paymentId)}`);
    if (p.status === "authorized") p = await this.call("POST", `/v1/payments/${encodeURIComponent(paymentId)}/capture`, { amount: p.amount, currency: p.currency });
    return { captured: p.status === "captured", amountMinor: Number(p.amount ?? 0), currency: String(p.currency ?? "").toUpperCase(), orderRef: str(p.order_id) };
  }

  parseWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): PaymentEvent {
    if (!isRealKey(config.RAZORPAY_WEBHOOK_SECRET)) throw new WebhookSignatureError("Razorpay webhooks are not configured");
    if (!verifyRazorpayWebhookSignature(rawBody, header(headers, "x-razorpay-signature"), config.RAZORPAY_WEBHOOK_SECRET)) throw new WebhookSignatureError("signature mismatch");
    let body: unknown;
    try {
      body = JSON.parse(rawBody.toString("utf8"));
    } catch {
      throw new WebhookSignatureError("body is not JSON");
    }
    // Razorpay always sends an event id; a hash of the signed body is the fallback key.
    const eventId = header(headers, "x-razorpay-event-id")?.trim() || `body_${createHash("sha256").update(rawBody).digest("hex").slice(0, 40)}`;
    return normalizeRazorpayEvent(body, eventId.slice(0, 120));
  }
}

// ─── Stub (development only) ────────────────────────────────────────────────

class StubGateway implements Gateway {
  readonly name = "STUB" as const;

  async createCheckout(input: CheckoutInput): Promise<Checkout> {
    return { orderRef: `stub_${input.topupId}`, checkout: { kind: "stub", confirmUrl: `/billing/topups/${input.topupId}/stub-confirm` } };
  }

  parseWebhook(): PaymentEvent {
    throw new WebhookSignatureError("the stub gateway has no webhooks");
  }
}

export const stripeGateway = new StripeGateway();
export const razorpayGateway = new RazorpayGateway();
export const stubGateway = new StubGateway();

/** Which gateway takes a currency: Razorpay for INR, Stripe for USD, the stub for both when PAYMENTS_STUB is on and the real one is not configured. */
export function gatewayFor(currency: Currency): Gateway | null {
  if (currency === "INR" && razorpayEnabled()) return razorpayGateway;
  if (currency === "USD" && stripeEnabled()) return stripeGateway;
  return config.PAYMENTS_STUB ? stubGateway : null;
}

export function gatewayByName(name: GatewayName): Gateway {
  return name === "STRIPE" ? stripeGateway : name === "RAZORPAY" ? razorpayGateway : stubGateway;
}

/** Currencies that can be paid right now, for the console's top-up form. */
export function payableCurrencies(): Currency[] {
  return (["USD", "INR"] as const).filter((c) => gatewayFor(c) !== null);
}
