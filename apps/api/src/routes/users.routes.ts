/** /api/users: your account, sessions, export and deletion. */
import { Router } from "express";
import * as ctrl from "../controllers/user.controller";
import { authenticate } from "../middleware/auth";
import { rateLimit } from "../middleware/rate-limit";

export const router = Router();

/** Your account (`Me`): identity, status and whether you may open /admin. */
router.get("/me", authenticate, ctrl.me);
/**
 * Edit your account: `{ displayName? }`. Names are cleaned (no emails or phone numbers). Returns `Me`.
 */
router.patch("/me", authenticate, ctrl.updateMe);
/**
 * Ask to delete your account: `{ password, totp? }` (or `recoveryCode`). Signs you out everywhere; after 14 days (unless
 * you sign in again) your identity is erased, your keys revoked and logged bodies deleted. Returns `{ purgeAfter }`.
 * 409 LAST_ADMIN.
 */
router.delete("/me", authenticate, rateLimit("account-delete", 5, 3600), ctrl.deleteMe);
/** Download your data (account, API keys without secrets, ledger, top-ups, request metadata) as JSON. 3 per day. */
router.get("/me/export", authenticate, rateLimit("account-export", 3, 86400), ctrl.exportMe);
/** Your signed-in sessions (`SessionInfo[]`). */
router.get("/me/sessions", authenticate, ctrl.mySessions);
/** Sign out one session (and every rotation of it). 204. */
router.delete("/me/sessions/:id", authenticate, ctrl.revokeSession);
