/**
 * /api/admin: the control plane. Admins only (403 FORBIDDEN_ADMIN otherwise). Admins see
 * accounts, money, usage metadata and configuration; never request bodies or provider secrets.
 */
import { Router } from "express";
import * as ctrl from "../controllers/admin.controller";
import { authenticate } from "../middleware/auth";
import { rateLimit } from "../middleware/rate-limit";

export const router = Router();
router.use(authenticate);

/** `AdminSession`. */
router.get("/me", ctrl.me);
/** The overview (`AdminStats`) for `?from=&to=` (UTC dates, default the last 30 days, at most a year): requests, revenue, provider cost, margin, latency per model and provider. */
router.get("/stats", ctrl.stats);

/** Accounts (`Page<AdminUserRow>`): `?q&status&role&tierId&cursor&limit`. */
router.get("/users", ctrl.users);
/** One account (`AdminUserDetail`): balance, keys with their margins, totals, 30 days of spend. */
router.get("/users/:id", ctrl.user);
/** `{ role: USER | ADMIN }`. 403 SELF_ACTION; 409 LAST_ADMIN. Demoting signs the account out of admin at once. */
router.patch("/users/:id/role", ctrl.setRole);
/** `{ days, reason? }` (1 to 365): the account's keys stop working until it ends. 403 TARGET_PROTECTED for admins. */
router.post("/users/:id/suspend", ctrl.status("suspend"));
router.post("/users/:id/unsuspend", ctrl.status("unsuspend"));
/** `{ reason? }`: signed out everywhere, keys stop working. */
router.post("/users/:id/ban", ctrl.status("ban"));
router.post("/users/:id/unban", ctrl.status("unban"));
/** Erase now `{ reason }`: identity anonymised, keys revoked, logged bodies deleted; financial records kept. 204. */
router.post("/users/:id/erase", rateLimit("admin-erase", 20, 3600), ctrl.erase);
/** Put an account on a rate-limit tier `{ tierId }` (null = the default tier). */
router.put("/users/:id/tier", ctrl.setTier);
/** Account margin `{ marginBps }` (0 and up; null = the model's margin, then the default). `AdminUserDetail`. */
router.put("/users/:id/margin", ctrl.setUserMargin);
/** Key margin `{ marginBps }`: the highest-precedence override. `AdminUserDetail`. */
router.put("/users/:id/keys/:keyId/margin", ctrl.setKeyMargin);
/** Book `{ type: GRANT | ADJUSTMENT, amountMicros, reason }` on the account's ledger. `AdminUserDetail`. */
router.post("/users/:id/credit", rateLimit("admin-credit", 60, 3600), ctrl.credit);

/** Rate-limit tiers (`LimitTier[]`) with how many accounts use each. */
router.get("/tiers", ctrl.tiers);
/** `{ name, rpm, tpm, concurrency, isDefault? }` (null = unlimited). Returns every tier. */
router.post("/tiers", ctrl.createTier);
router.put("/tiers/:id", ctrl.updateTier);
/** Delete a tier (its accounts fall back to the default). 409 TIER_DEFAULT. */
router.delete("/tiers/:id", ctrl.deleteTier);

/** Providers (`AdminProvider[]`) with their credentials (label and last four only). */
router.get("/providers", ctrl.providers);
/** `{ id (slug), kind, displayName, baseUrl, enabled }`. Returns every provider. */
router.post("/providers", ctrl.createProvider);
router.put("/providers/:id", ctrl.updateProvider);
router.delete("/providers/:id", ctrl.deleteProvider);
/** `{ label, secret }`: encrypted on arrival, never returned. Several credentials per provider are used round robin. */
router.post("/providers/:id/credentials", ctrl.addCredential);
router.patch("/providers/:id/credentials/:credentialId", ctrl.setCredentialEnabled);
router.delete("/providers/:id/credentials/:credentialId", ctrl.deleteCredential);

/** The catalogue (`AdminModel[]`): models, their routes with cost and circuit, the margin in force and the price callers pay. */
router.get("/models", ctrl.models);
/** `{ id, kind, displayName, ..., marginBps, enabled }`. 409 MODEL_UNPRICED when enabling a model without a priced route. */
router.post("/models", ctrl.createModel);
router.put("/models/:id", ctrl.updateModel);
router.delete("/models/:id", ctrl.deleteModel);
/** `{ providerId, upstreamModel, priority, timeoutMs?, inputMicrosPerMtok, outputMicrosPerMtok, cachedMicrosPerMtok?, unitMicros?, enabled? }`. */
router.post("/models/:id/routes", ctrl.addRoute);
router.put("/models/:id/routes/:routeId", ctrl.updateRoute);
router.delete("/models/:id/routes/:routeId", ctrl.deleteRoute);
/** One tiny real call through the route (`ModelTestResult`). */
router.post("/models/:id/routes/:routeId/test", rateLimit("admin-route-test", 30, 60), ctrl.testRoute);

/** Every route with its circuit, 24-hour success rate and latency, and recent probes (`HealthRow[]`). */
router.get("/health", ctrl.health);
/** Force a route's circuit `{ state: open | closed }`. 204. */
router.post("/health/:routeId/circuit", ctrl.setCircuit);

/** Every top-up (`Page<AdminTopupRow>`): `?status&userId`. */
router.get("/topups", ctrl.topups);
/** Mark a paid top-up refunded `{ reason }` and debit its credit. The money goes back in the gateway's dashboard. 204. */
router.post("/topups/:id/refund", ctrl.refundTopup);

/** Promo codes (`PromoCode[]`). */
router.get("/promos", ctrl.promos);
/** `{ code, amountMicros, maxRedemptions?, expiresAt? }`. */
router.post("/promos", ctrl.createPromo);
/** `{ active }`. */
router.patch("/promos/:id", ctrl.setPromoActive);

/** Deployment settings (`AppSettings`). */
router.get("/settings", ctrl.getSettings);
/** Any subset of `AppSettings` (groups merge key by key). Audited with before and after. */
router.patch("/settings", ctrl.patchSettings);
/** What the server has configured (`IntegrationStatus`): mail, payment gateways, the FX rate. Never a secret. */
router.get("/integrations", ctrl.integrations);

/** The audit trail (`Page<AuditEntry>`), newest first: `?action=` (a prefix) `&actorId&entityType&entityId`. */
router.get("/audit", ctrl.audit);
