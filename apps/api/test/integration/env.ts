/**
 * Runs before each test file imports anything, so the API's config module sees test
 * values. Backend choices (MAIL_MODE, AWS endpoint) come from the environment so
 * scripts/test-matrix.sh can vary them.
 *
 * The payment gateways point at the stubs with the stubs' default secrets, so the real
 * Stripe and Razorpay clients run end to end. CANARY_KEY is stored as a provider
 * credential by secrets.int.test.ts: no response the suite fetches may ever contain it.
 */
import os from "node:os";
import path from "node:path";
import { inject } from "vitest";
import { testDatabaseUrl, testRedisUrl } from "./guard";

export const CANARY_KEY = "sk-test-canary-value";

process.env.TZ = "UTC";
process.env.NODE_ENV = "test";
process.env.DATABASE_URL = testDatabaseUrl();
process.env.REDIS_URL = testRedisUrl();
process.env.JOBS_MODE = "inline";
process.env.BCRYPT_ROUNDS = "4";
process.env.REQUIRE_EMAIL_VERIFICATION ??= "true";
process.env.MAIL_MODE ??= "outbox";
process.env.DATA_DIR ??= path.join(os.tmpdir(), `open-gateway-test-${process.pid}`);
process.env.APP_WEB_URL ??= "http://localhost:3560";
process.env.PUBLIC_API_URL ??= "http://localhost:5056";
process.env.CORS_ORIGINS ??= "http://localhost:3560";
process.env.LOG_LEVEL ??= "silent";
process.env.STUBS_URL = inject("stubsUrl");
process.env.STRIPE_API_BASE = `${inject("stubsUrl")}/stripe`;
process.env.STRIPE_SECRET_KEY = "sk_test_stub";
process.env.STRIPE_WEBHOOK_SECRET = "whsec_stub";
process.env.RAZORPAY_API_BASE = `${inject("stubsUrl")}/razorpay`;
process.env.RAZORPAY_KEY_ID = "rzp_test_stub";
process.env.RAZORPAY_KEY_SECRET = "rzp_secret_stub";
process.env.RAZORPAY_WEBHOOK_SECRET = "rzp_whsec_stub";
process.env.PAYMENTS_STUB = "true";
process.env.FX_PROVIDER = "fixed";
process.env.FX_FIXED_INR_PER_USD = "80";
