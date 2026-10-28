/**
 * Typed, validated configuration. Every environment variable the API reads is declared
 * here and nowhere else, so docs/guides/configuration.md can be checked against it.
 *
 * Outside production the security-critical values fall back to development defaults
 * so `make up` works with zero setup. In production `assertProductionConfig` refuses
 * to boot while any of them is still a committed default.
 *
 * Three groups are not read from the parsed `config` object, and why:
 *   - RATE_LIMITS, RATE_LIMIT_STORE: read live through `rateLimitEnv()` so a test can
 *     switch limits on for one case; the schema below still validates them.
 *   - DATABASE_URL, DATABASE_SECRET_ARN, DB_*: also read by db/connection-config.ts,
 *     which the migration runner imports without this module.
 *   - MIGRATIONS_DIR: read only by db/migrate.ts (outside the API); declared here so the
 *     list of variables stays complete.
 */
import crypto from "node:crypto";
import { z } from "zod";

export const DEV_DEFAULTS = {
  JWT_SECRET: "change-me-open-gateway-local-access-token-secret",
  REFRESH_SECRET: "change-me-open-gateway-local-refresh-token-secret",
  // 32 bytes, base64, derived from a public constant: fine for a laptop, refused in production.
  TOTP_ENCRYPTION_KEY: crypto.createHash("sha256").update("change-me-open-gateway-local-totp-encryption-key").digest("base64"),
  CREDENTIALS_KEY: crypto.createHash("sha256").update("change-me-open-gateway-local-credentials-key").digest("base64"),
  API_KEY_PEPPER: "change-me-open-gateway-local-api-key-pepper",
} as const;

/** A base64 string that decodes to exactly 32 bytes (an AES-256 key). */
const key32 = z.string().refine((v) => Buffer.from(v, "base64").length === 32, "must be 32 bytes, base64 encoded (openssl rand -base64 32)");

const bool = z
  .enum(["true", "false", "1", "0", ""])
  .optional()
  .transform((v) => v === "true" || v === "1");

const list = z
  .string()
  .optional()
  .transform((v) =>
    (v ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(5056),
  PRODUCT_NAME: z.string().default("Euron Open AI API Gateway"),
  /** The web app origin; emailed links and CORS default to it. */
  APP_WEB_URL: z.string().url().default("http://localhost:3560"),
  /** The public origin the browser reaches this API on (receipts and links that point at the API use it). */
  PUBLIC_API_URL: z.string().url().default("http://localhost:5056"),
  CORS_ORIGINS: list,
  TRUST_PROXY: z.coerce.number().int().min(0).default(1),

  /** Local and CI. On AWS leave it unset: the API reads the RDS-managed secret instead (db/connection-config.ts). */
  DATABASE_URL: z.string().optional(),
  DATABASE_SECRET_ARN: z.string().optional(),
  DB_HOST: z.string().optional(),
  DB_PORT: z.coerce.number().int().positive().default(5432),
  DB_NAME: z.string().optional(),
  DB_USER: z.string().optional(),
  DB_SSL: z.enum(["disable", "require", "verify-full"]).optional(),
  DB_SSL_CA_FILE: z.string().optional(),
  DB_POOL_MAX: z.coerce.number().int().positive().default(10),
  MIGRATE_ON_BOOT: bool,

  REDIS_URL: z.string().default("redis://localhost:6459"),
  /** inline: run job handlers in-process after commit (tests, tiny installs). queue: BullMQ. */
  JOBS_MODE: z.enum(["queue", "inline"]).default("queue"),

  JWT_SECRET: z.string().default(DEV_DEFAULTS.JWT_SECRET),
  REFRESH_SECRET: z.string().default(DEV_DEFAULTS.REFRESH_SECRET),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),
  /** Set to false only for plain-http local development. */
  COOKIE_SECURE: z
    .enum(["true", "false", "auto"])
    .default("auto")
    .transform((v) => v),
  /** bcrypt cost. 12 in production; the test suite lowers it to keep thousands of sign-ups fast. */
  BCRYPT_ROUNDS: z.coerce.number().int().min(4).max(15).default(12),
  REQUIRE_EMAIL_VERIFICATION: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  /** Encrypts TOTP secrets at rest and keys the recovery-code HMAC. Required in production. */
  TOTP_ENCRYPTION_KEY: key32.default(DEV_DEFAULTS.TOTP_ENCRYPTION_KEY),
  /** off disables every rate limit (default off under NODE_ENV=test). Read live: see rateLimitEnv(). */
  RATE_LIMITS: z.string().optional(),
  /** Under NODE_ENV=test limits use memory unless this is "redis". Read live: see rateLimitEnv(). */
  RATE_LIMIT_STORE: z.string().optional(),

  /** Where the mail outbox lives when MAIL_MODE=outbox (default ./data). */
  DATA_DIR: z.string().optional(),
  AWS_REGION: z.string().default("us-east-1"),
  AWS_ENDPOINT_URL: z.string().optional(),

  MAIL_MODE: z.enum(["outbox", "smtp", "ses"]).default("outbox"),
  MAIL_FROM: z.string().optional(),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  SES_REGION: z.string().optional(),
  SES_CONFIGURATION_SET: z.string().optional(),

  /**
   * Encrypts provider credentials at rest (AES-256-GCM, security/credentials.ts): 32 bytes,
   * base64. Admins add provider keys in /admin; they are encrypted on arrival with this key
   * and never returned. Rotating it means re-entering the provider keys. Required in production.
   */
  CREDENTIALS_KEY: key32.default(DEV_DEFAULTS.CREDENTIALS_KEY),
  /** The HMAC pepper API keys are hashed with (security/api-keys.ts). Required in production. */
  API_KEY_PEPPER: z.string().default(DEV_DEFAULTS.API_KEY_PEPPER),
  /** The prefix every API key starts with. */
  API_KEY_PREFIX: z.string().regex(/^[a-z]{1,8}-$/, "lowercase letters and a trailing hyphen").default("gw-"),
  /** The base URL developers point their SDK at, including /v1 (shown in the console and docs). */
  GATEWAY_PUBLIC_URL: z.string().url().default("http://localhost:5056/v1"),
  /** Largest request body the data plane accepts, in megabytes (images in vision requests count). */
  GATEWAY_MAX_BODY_MB: z.coerce.number().int().min(1).max(100).default(20),
  /** Largest audio file for transcription, in megabytes. */
  GATEWAY_MAX_AUDIO_MB: z.coerce.number().int().min(1).max(100).default(25),
  /** Where providers of kind STUB live (the deterministic fakes in apps/stubs). */
  STUBS_URL: z.string().default("http://localhost:5149"),

  /** Stripe takes USD top-ups. Unset STRIPE_SECRET_KEY = Stripe off. STRIPE_API_BASE points at the stubs in development. */
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  STRIPE_API_BASE: z.string().url().default("https://api.stripe.com"),
  /** Razorpay takes INR top-ups (UPI, cards, netbanking). Unset RAZORPAY_KEY_ID = Razorpay off. */
  RAZORPAY_KEY_ID: z.string().optional(),
  RAZORPAY_KEY_SECRET: z.string().optional(),
  RAZORPAY_WEBHOOK_SECRET: z.string().optional(),
  RAZORPAY_API_BASE: z.string().url().default("https://api.razorpay.com"),
  /**
   * A local stand-in for both gateways: top-ups are confirmed by a button in the console.
   * For development and tests only; refused in production.
   */
  PAYMENTS_STUB: bool,

  /** Where the INR per USD rate comes from: exchangerate (open.er-api.com, no key), openexchangerates (needs FX_API_KEY) or fixed. */
  FX_PROVIDER: z.enum(["exchangerate", "openexchangerates", "fixed"]).default("fixed"),
  FX_API_KEY: z.string().optional(),
  FX_API_BASE: z.string().url().optional(),
  /** The rate with FX_PROVIDER=fixed, and the fallback before the first fetch. */
  FX_FIXED_INR_PER_USD: z.coerce.number().positive().default(85),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),

  /** demo:seed only: the password every demo account gets (random and printed when unset). */
  DEMO_PASSWORD: z.string().optional(),
  /** db/migrate.ts only: where the .sql files live (default db/migrations next to the runner). */
  MIGRATIONS_DIR: z.string().optional(),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`);
    throw new Error(`Invalid configuration:\n${lines.join("\n")}`);
  }
  return parsed.data;
}

export const config: Config = loadConfig();

export const isProd = config.NODE_ENV === "production";
export const isTest = config.NODE_ENV === "test";

/** The two rate-limit switches, read from the environment on every call (tests flip them). */
export function rateLimitEnv(env: NodeJS.ProcessEnv = process.env): { enabled: boolean; store: "memory" | "redis" } {
  const parsed = schema.pick({ RATE_LIMITS: true, RATE_LIMIT_STORE: true }).parse({ RATE_LIMITS: env.RATE_LIMITS, RATE_LIMIT_STORE: env.RATE_LIMIT_STORE });
  return {
    enabled: (parsed.RATE_LIMITS ?? (isTest ? "off" : "on")) !== "off",
    store: isTest && parsed.RATE_LIMIT_STORE !== "redis" ? "memory" : "redis",
  };
}

/** Origins allowed to call the API with credentials. */
export function allowedOrigins(c: Config = config): string[] {
  return c.CORS_ORIGINS.length ? c.CORS_ORIGINS : [c.APP_WEB_URL];
}

export function cookieSecure(c: Config = config): boolean {
  if (c.COOKIE_SECURE === "auto") return c.APP_WEB_URL.startsWith("https://");
  return c.COOKIE_SECURE === "true";
}

/**
 * Production guard. Returns the problems; throws in production so a misconfigured
 * deployment fails at boot instead of on the first request.
 */
export function assertProductionConfig(c: Config = config): string[] {
  const problems: string[] = [];
  const secrets: ["JWT_SECRET" | "REFRESH_SECRET", string][] = [
    ["JWT_SECRET", c.JWT_SECRET],
    ["REFRESH_SECRET", c.REFRESH_SECRET],
  ];
  for (const [key, value] of secrets) {
    if (value === DEV_DEFAULTS[key]) problems.push(`${key} is still the committed development default`);
    else if (value.length < 32) problems.push(`${key} must be at least 32 characters`);
  }
  if (c.JWT_SECRET === c.REFRESH_SECRET) problems.push("JWT_SECRET and REFRESH_SECRET must differ");
  if (c.TOTP_ENCRYPTION_KEY === DEV_DEFAULTS.TOTP_ENCRYPTION_KEY) problems.push("TOTP_ENCRYPTION_KEY is not set (the development default is derived from a public constant)");
  if (!c.CORS_ORIGINS.length) problems.push("CORS_ORIGINS is not set");
  if (/localhost|127\.0\.0\.1/.test(c.APP_WEB_URL)) problems.push("APP_WEB_URL points at localhost");
  if (c.MAIL_MODE === "outbox") problems.push("MAIL_MODE=outbox writes mail to disk instead of sending it");
  if (c.MAIL_MODE !== "outbox" && !c.MAIL_FROM) problems.push("MAIL_FROM is not set");
  if (c.JOBS_MODE === "inline") problems.push("JOBS_MODE=inline runs background work on the request path");
  if (c.BCRYPT_ROUNDS < 12) problems.push("BCRYPT_ROUNDS below 12 weakens stored passwords");
  if (c.CREDENTIALS_KEY === DEV_DEFAULTS.CREDENTIALS_KEY) problems.push("CREDENTIALS_KEY is not set (the development default is derived from a public constant)");
  if (c.API_KEY_PEPPER === DEV_DEFAULTS.API_KEY_PEPPER || c.API_KEY_PEPPER.length < 32) problems.push("API_KEY_PEPPER must be set to at least 32 random characters");
  if (c.PAYMENTS_STUB) problems.push("PAYMENTS_STUB=true lets anyone credit their own wallet");
  if (/localhost|127\.0\.0\.1/.test(c.GATEWAY_PUBLIC_URL)) problems.push("GATEWAY_PUBLIC_URL points at localhost");
  if (c.NODE_ENV === "production" && problems.length) {
    throw new Error(`Refusing to start with an insecure configuration:\n  - ${problems.join("\n  - ")}`);
  }
  return problems;
}

/**
 * Things worth fixing that must not stop a deployment: the app runs (and an admin can
 * sign in to fix it) before any provider key is set.
 */
export function productionWarnings(c: Config = config): string[] {
  const warnings: string[] = [];
  if (!stripeEnabled(c) && !razorpayEnabled(c) && !c.PAYMENTS_STUB) warnings.push("no payment gateway is configured (STRIPE_SECRET_KEY or RAZORPAY_KEY_ID): accounts cannot top up");
  if (stripeEnabled(c) && !isRealKey(c.STRIPE_WEBHOOK_SECRET)) warnings.push("STRIPE_WEBHOOK_SECRET is not set: Stripe top-ups would never be confirmed by webhook");
  if (razorpayEnabled(c) && !isRealKey(c.RAZORPAY_WEBHOOK_SECRET)) warnings.push("RAZORPAY_WEBHOOK_SECRET is not set: Razorpay top-ups rely on the browser's verify call only");
  if (c.FX_PROVIDER === "openexchangerates" && !isRealKey(c.FX_API_KEY)) warnings.push("FX_PROVIDER=openexchangerates needs FX_API_KEY: the fixed rate is used");
  return warnings;
}

export function stripeEnabled(c: Pick<Config, "STRIPE_SECRET_KEY"> = config): boolean {
  return isRealKey(c.STRIPE_SECRET_KEY);
}

export function razorpayEnabled(c: Pick<Config, "RAZORPAY_KEY_ID" | "RAZORPAY_KEY_SECRET"> = config): boolean {
  return isRealKey(c.RAZORPAY_KEY_ID) && isRealKey(c.RAZORPAY_KEY_SECRET);
}

/** Set, and not the Terraform placeholder "set-me". */
export function isRealKey(v: string | undefined): v is string {
  const k = v?.trim();
  return !!k && k !== "set-me";
}
