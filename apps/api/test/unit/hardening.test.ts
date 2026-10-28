import { Redis } from "ioredis";
import { afterAll, describe, expect, test } from "vitest";
import { assertProductionConfig, DEV_DEFAULTS, isRealKey, loadConfig, productionWarnings, razorpayEnabled, stripeEnabled } from "../../src/core/config";
import { LOCAL_DATABASE_URL, resolveConnectionConfig } from "../../src/db/connection-config";
import { redisLimiter } from "../../src/middleware/rate-limit";
import { decryptTotpSecret, encryptTotpSecret, hashRecoveryCode, newRecoveryCodes } from "../../src/security/totp";

const prodBase = {
  NODE_ENV: "test",
  JWT_SECRET: "a".repeat(40),
  REFRESH_SECRET: "b".repeat(40),
  CORS_ORIGINS: "https://gateway.example.com",
  APP_WEB_URL: "https://gateway.example.com",
  GATEWAY_PUBLIC_URL: "https://api.example.com/v1",
  MAIL_MODE: "ses",
  MAIL_FROM: "Gateway <no-reply@example.com>",
  TOTP_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64"),
  CREDENTIALS_KEY: Buffer.alloc(32, 7).toString("base64"),
  API_KEY_PEPPER: "p".repeat(40),
  STRIPE_SECRET_KEY: "sk_test_fake_stripe_key_0001",
  STRIPE_WEBHOOK_SECRET: "whsec_test",
};

describe("production guard", () => {
  test("a complete production config has no problems and no warnings", () => {
    expect(assertProductionConfig(loadConfig(prodBase))).toEqual([]);
    expect(productionWarnings(loadConfig(prodBase))).toEqual([]);
  });

  test("TOTP_ENCRYPTION_KEY is required: the derived development default is refused; a wrong length does not parse", () => {
    const { TOTP_ENCRYPTION_KEY: _k, ...rest } = prodBase;
    const c = loadConfig(rest);
    expect(c.TOTP_ENCRYPTION_KEY).toBe(DEV_DEFAULTS.TOTP_ENCRYPTION_KEY);
    expect(assertProductionConfig(c).join("\n")).toMatch(/TOTP_ENCRYPTION_KEY/);
    expect(() => loadConfig({ ...prodBase, TOTP_ENCRYPTION_KEY: "c2hvcnQ=" })).toThrow(/TOTP_ENCRYPTION_KEY/);
  });

  test("development secrets, short secrets and identical secrets are refused", () => {
    expect(assertProductionConfig(loadConfig({ ...prodBase, JWT_SECRET: DEV_DEFAULTS.JWT_SECRET })).join("\n")).toMatch(/JWT_SECRET is still the committed development default/);
    expect(assertProductionConfig(loadConfig({ ...prodBase, REFRESH_SECRET: "short" })).join("\n")).toMatch(/REFRESH_SECRET must be at least 32/);
    expect(assertProductionConfig(loadConfig({ ...prodBase, REFRESH_SECRET: prodBase.JWT_SECRET })).join("\n")).toMatch(/must differ/);
  });

  test("local shortcuts are refused: inline jobs, outbox mail, weak bcrypt, a localhost web URL, no CORS origins", () => {
    const problems = assertProductionConfig(loadConfig({ ...prodBase, JOBS_MODE: "inline", MAIL_MODE: "outbox", BCRYPT_ROUNDS: "10", APP_WEB_URL: "http://localhost:3560", CORS_ORIGINS: "" })).join("\n");
    for (const re of [/JOBS_MODE=inline/, /MAIL_MODE=outbox/, /BCRYPT_ROUNDS/, /APP_WEB_URL points at localhost/, /CORS_ORIGINS is not set/]) expect(problems).toMatch(re);
  });

  test("a non-outbox mail mode needs MAIL_FROM", () => {
    const { MAIL_FROM: _f, ...noFrom } = prodBase;
    expect(assertProductionConfig(loadConfig(noFrom)).join("\n")).toMatch(/MAIL_FROM is not set/);
  });

  test("NODE_ENV=production throws with the list; the message never contains a key", () => {
    const err = (() => {
      try {
        assertProductionConfig(loadConfig({ ...prodBase, NODE_ENV: "production", JOBS_MODE: "inline" }));
      } catch (e) {
        return e as Error;
      }
      return null;
    })();
    expect(err?.message).toMatch(/Refusing to start/);
    expect(err?.message).not.toContain(prodBase.STRIPE_SECRET_KEY);
    expect(err?.message).not.toContain(prodBase.API_KEY_PEPPER);
  });

  test("gateway secrets are required: credentials key, API key pepper, no payment stub, a public gateway URL", () => {
    const { CREDENTIALS_KEY: _c, API_KEY_PEPPER: _p, GATEWAY_PUBLIC_URL: _g, ...rest } = prodBase;
    const problems = assertProductionConfig(loadConfig({ ...rest, PAYMENTS_STUB: "true" })).join("\n");
    for (const re of [/CREDENTIALS_KEY/, /API_KEY_PEPPER/, /PAYMENTS_STUB/, /GATEWAY_PUBLIC_URL points at localhost/]) expect(problems).toMatch(re);
    expect(assertProductionConfig(loadConfig({ ...prodBase, API_KEY_PEPPER: "short" })).join("\n")).toMatch(/API_KEY_PEPPER/);
  });

  test("a missing payment gateway is a warning, not a boot failure", () => {
    const { STRIPE_SECRET_KEY: _s, STRIPE_WEBHOOK_SECRET: _w, ...noGateway } = prodBase;
    expect(assertProductionConfig(loadConfig(noGateway))).toEqual([]);
    expect(productionWarnings(loadConfig(noGateway)).join("\n")).toMatch(/no payment gateway/);
    expect(productionWarnings(loadConfig({ ...noGateway, STRIPE_SECRET_KEY: "set-me" })).join("\n")).toMatch(/no payment gateway/);
    expect(productionWarnings(loadConfig({ ...noGateway, STRIPE_SECRET_KEY: "sk_test_fake" })).join("\n")).toMatch(/STRIPE_WEBHOOK_SECRET/);
    expect(productionWarnings(loadConfig({ ...noGateway, RAZORPAY_KEY_ID: "rzp_test_fake", RAZORPAY_KEY_SECRET: "rzp_secret_fake" })).join("\n")).toMatch(/RAZORPAY_WEBHOOK_SECRET/);
  });

  test("the env vars the API reads outside config.ts are declared in it", () => {
    const c = loadConfig({ RATE_LIMITS: "off", RATE_LIMIT_STORE: "redis", DEMO_PASSWORD: "x", MIGRATIONS_DIR: "/m" });
    expect(c).toMatchObject({ RATE_LIMITS: "off", RATE_LIMIT_STORE: "redis", DEMO_PASSWORD: "x", MIGRATIONS_DIR: "/m" });
  });
});

describe("provider keys", () => {
  test("isRealKey drops empty values and the Terraform placeholder", () => {
    expect(isRealKey(undefined)).toBe(false);
    expect(isRealKey("")).toBe(false);
    expect(isRealKey("   ")).toBe(false);
    expect(isRealKey("set-me")).toBe(false);
    expect(isRealKey(" set-me ")).toBe(false);
    expect(isRealKey("sk-abc")).toBe(true);
  });

  test("Stripe needs a secret key; Razorpay needs both the key id and the key secret", () => {
    expect(stripeEnabled({ STRIPE_SECRET_KEY: "sk_test_fake" })).toBe(true);
    expect(stripeEnabled({ STRIPE_SECRET_KEY: "set-me" })).toBe(false);
    expect(razorpayEnabled({ RAZORPAY_KEY_ID: "rzp_test_fake", RAZORPAY_KEY_SECRET: "rzp_secret_fake" })).toBe(true);
    expect(razorpayEnabled({ RAZORPAY_KEY_ID: "rzp_test_fake", RAZORPAY_KEY_SECRET: undefined })).toBe(false);
  });
});

describe("database connection default", () => {
  test("with nothing set it falls back to the local compose Postgres, nothing else", () => {
    expect(resolveConnectionConfig({})).toEqual({ connectionString: LOCAL_DATABASE_URL });
    expect(LOCAL_DATABASE_URL).toBe("postgres://gw:gw@localhost:5522/gw");
  });
});

describe("TOTP at rest", () => {
  test("ciphertext round-trips only for the same user, and tampering is rejected", () => {
    const enc = encryptTotpSecret("JBSWY3DPEHPK3PXP", "user-a");
    expect(enc).toMatch(/^v1:/);
    expect(decryptTotpSecret(enc, "user-a")).toBe("JBSWY3DPEHPK3PXP");
    expect(decryptTotpSecret(enc, "user-b")).toBeNull();
    expect(decryptTotpSecret(`${enc.slice(0, -2)}AA`, "user-a")).toBeNull();
    expect(decryptTotpSecret("JBSWY3DPEHPK3PXP", "user-a")).toBeNull();
  });

  test("recovery codes: ten distinct codes, hashes ignore case and dashes and differ per user", () => {
    const codes = newRecoveryCodes();
    expect(new Set(codes).size).toBe(10);
    for (const c of codes) expect(c).toMatch(/^[a-z2-9]{5}-[a-z2-9]{5}$/);
    const c = codes[0]!;
    expect(hashRecoveryCode(c.toUpperCase().replace("-", " "), "u1")).toBe(hashRecoveryCode(c, "u1"));
    expect(hashRecoveryCode(c, "u2")).not.toBe(hashRecoveryCode(c, "u1"));
  });
});

describe("rate limiter during a Redis outage", () => {
  const dead = new Redis("redis://127.0.0.1:1", { lazyConnect: true, enableOfflineQueue: false, maxRetriesPerRequest: 0, retryStrategy: () => null });
  afterAll(() => dead.disconnect());

  test("falls back to the in-memory insurance limiter: still limits, never throws a store error", async () => {
    const l = redisLimiter(dead, `outage-${Date.now()}`, 2, 60);
    await expect(l.consume("k")).resolves.toBeDefined();
    await expect(l.consume("k")).resolves.toBeDefined();
    const third = await l.consume("k").catch((e) => e);
    expect(third).not.toBeInstanceOf(Error);
    expect(third.remainingPoints).toBe(0);
  });
});
