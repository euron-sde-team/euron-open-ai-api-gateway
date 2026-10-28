/** The developer console API: catalogue, keys, wallet and top-ups, usage. Owner-scoped: another account's ids are 404. */
import express, { Router } from "express";
import * as ctrl from "../controllers/console.controller";
import { authenticate, optionalAuth } from "../middleware/auth";
import { rateLimit } from "../middleware/rate-limit";

/** /api/meta: public facts a client reads before anyone signs in (`AppMeta`). Cached 30 seconds. */
export const meta = Router();
meta.get("/", ctrl.meta);

/** /api/catalog: every callable model with its price (`ModelInfo[]`): the account's prices when signed in, list prices otherwise. */
export const catalog = Router();
catalog.get("/", optionalAuth, ctrl.catalog);

/** /api/keys. */
export const keys = Router();
keys.use(authenticate);
/** Your keys (`ApiKey[]`) with this month's spend. Never a secret. */
keys.get("/", ctrl.listKeys);
/** `ApiKeyInput`. Returns `CreatedApiKey`: the secret, once. 409 KEY_LIMIT; 400 UNKNOWN_MODEL, EXPIRY_IN_PAST, IP_ALLOWLIST_INVALID. */
keys.post("/", rateLimit("key-create", 30, 3600), ctrl.createKey);
/** Any subset of `ApiKeyInput`. Takes effect on the next request. 409 KEY_REVOKED. */
keys.patch("/:id", ctrl.updateKey);
/** Revoke (permanent). 204. */
keys.delete("/:id", ctrl.revokeKey);

/** /api/billing. */
export const billing = Router();
billing.use(authenticate);
/** Your `Wallet`: balance, amount on hold for requests in flight, available, and the INR equivalent. */
billing.get("/wallet", ctrl.wallet);
/** Your ledger (`Page<LedgerEntry>`), newest first: `?type&cursor&limit`. */
billing.get("/ledger", ctrl.ledger);
/** Your top-ups (`Page<Topup>`). */
billing.get("/topups", ctrl.topups);
/** `{ currency: USD | INR, amount }` (major units, before tax). Returns `TopupOrder` with the checkout to open. 400 TOPUP_AMOUNT; 409 GATEWAY_UNAVAILABLE. */
billing.post("/topups", rateLimit("topup-create", 20, 3600), ctrl.createTopup);
billing.get("/topups/:id", ctrl.topup);
/** A PDF receipt for a paid top-up. */
billing.get("/topups/:id/receipt.pdf", ctrl.receipt);
/** Development only (PAYMENTS_STUB=true): confirm a stub top-up. 403 STUB_DISABLED otherwise. */
billing.post("/topups/:id/stub-confirm", ctrl.confirmStub);
/** Razorpay checkout.js success `{ orderId, paymentId, signature }`: verified, confirmed with Razorpay, credited once (the webhook may already have). */
billing.post("/razorpay/verify", rateLimit("razorpay-verify", 30, 3600), ctrl.verifyRazorpay);
/** Redeem `{ code }`. 404 PROMO_NOT_FOUND, 409 PROMO_USED, 410 PROMO_EXPIRED. */
billing.post("/promo", rateLimit("promo-redeem", 10, 3600), ctrl.redeem);

/** /api/usage. */
export const usage = Router();
usage.use(authenticate);
/** `UsageSummary` for `?from&to` (UTC dates, default the last 30 days) `&apiKeyId&modelId`. */
usage.get("/summary", ctrl.usageSummary);
/** Your request log (`Page<RequestRow>`): `?apiKeyId&modelId&status=ok|error&cursor&limit`. */
usage.get("/requests", ctrl.usageRequests);
/** One request (`RequestDetail`), with its bodies when the key logged them and they have not expired. */
usage.get("/requests/:id", ctrl.usageRequest);

/** /api/webhooks: payment gateways. Raw bodies (signatures are over the exact bytes); no session. */
export const webhooks = Router();
webhooks.use(express.raw({ type: "*/*", limit: "1mb" }));
/** Stripe events (Stripe-Signature). 200 once recorded, 400 for a bad signature. */
webhooks.post("/stripe", ctrl.webhook("STRIPE"));
/** Razorpay events (X-Razorpay-Signature). */
webhooks.post("/razorpay", ctrl.webhook("RAZORPAY"));
