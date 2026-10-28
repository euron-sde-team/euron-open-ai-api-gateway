# Security architecture

The controls Euron Open AI API Gateway relies on, where each lives in the code, and what it
does not cover. The STRIDE analysis is [threat-model.md](threat-model.md). How to report a
vulnerability: [SECURITY.md](../../SECURITY.md). Paths are relative to the repository root.

## 1. Authentication

| Control | Where | Detail |
| --- | --- | --- |
| Password hashing | [`apps/api/src/security/passwords.ts`](../../apps/api/src/security/passwords.ts) | bcrypt, cost `BCRYPT_ROUNDS` (12; below 12 refused in production) |
| Password policy | same | 10 to 128 characters, not one repeated character, not containing the email local part or the username (`WEAK_PASSWORD` otherwise) |
| Sign-in throttling | [`apps/api/src/services/auth.service.ts`](../../apps/api/src/services/auth.service.ts) | 5 failures per account and IP per 15 minutes, 50 per account per hour; once spent, every attempt is `429` whether the password is right or not |
| Generic answers | same | `INVALID_CREDENTIALS` for an unknown login and a wrong password alike; resend verification and forgot password always answer the same |
| Email verification | same | On by default (`REQUIRE_EMAIL_VERIFICATION`); single-use links valid 24 hours, stored as hashes |
| Password reset | same | Single-use links valid 1 hour, stored as hashes; a reset revokes every session |
| Two-factor | [`apps/api/src/security/totp.ts`](../../apps/api/src/security/totp.ts) | TOTP secret AES-256-GCM encrypted under `TOTP_ENCRYPTION_KEY`; each code works once; ten single-use recovery codes stored as HMACs |
| Registration control | [`apps/api/src/services/settings.service.ts`](../../apps/api/src/services/settings.service.ts) | `OPEN`, `INVITE_ONLY` (allowed email domains), `CLOSED` |
| Bootstrap admin | [`apps/api/src/cli.ts`](../../apps/api/src/cli.ts) | `admin:create` emails a set-password link and prints a password only with `--print-password` |

## 2. Sessions, cookies and CSRF

- **Access token**: HS256 JWT signed with `JWT_SECRET`, 15 minutes
  (`ACCESS_TOKEN_TTL_SECONDS`), with audience and issuer checked. The web app keeps it in
  memory only ([`apps/web/src/lib/session.ts`](../../apps/web/src/lib/session.ts)).
- **Refresh token**: random, 30 days (`REFRESH_TOKEN_TTL_DAYS`), in the `gw_refresh`
  cookie (`httpOnly`, `SameSite=Lax`, `Path=/api/auth`, `Secure` on https). Only its
  SHA-256 is stored.
- **Rotation and reuse detection**: every refresh rotates within a family; a rotated
  token presented 10 seconds or more after its rotation revokes the family.
- **Every request reloads the user**: a `token_version` mismatch (sign out everywhere,
  password change, ban, erase) invalidates outstanding access tokens at once.
- **Native token mode**: with `X-Client: native` the refresh token travels in the body
  instead of a cookie, through the same rotation code ([ADR 0009](adr/0009-native-token-mode.md)).
- **CSRF**: only `/api/auth/refresh` and `/api/auth/logout` use the cookie. They are covered
  by `SameSite=Lax`, the path scope, CORS (credentials only for allowed origins) and a
  check that refuses any non-GET request with a foreign `Origin`
  (`403 CORS_ORIGIN_DENIED`, [`apps/api/src/app.ts`](../../apps/api/src/app.ts)). Every
  other endpoint needs the bearer token.

## 3. Authorisation

### Roles

`USER` and `ADMIN`. Every admin service function starts with `requireAdmin`
(`403 FORBIDDEN_ADMIN`; a suspended admin has no powers)
([`apps/api/src/core/context.ts`](../../apps/api/src/core/context.ts)). Accounts that are
not `ACTIVE` can read but not write (`403 ACCOUNT_RESTRICTED`).

### Ownership is a 404

Every console route loads rows with the caller's id in the `WHERE` clause. Another
account's key, top-up, receipt, request or request bodies answer `404`, the same as a
missing id (`keys.int.test.ts`, `billing.int.test.ts`, `console.int.test.ts`).

### Admins never read bodies or secrets

No admin endpoint returns request or response bodies or a provider secret. Admins see
accounts, balances, ledgers, request metadata, the catalogue with costs, and credentials
as a label plus the last four characters. `console.int.test.ts` and
`secrets.int.test.ts` fetch every admin page and check.

### Strict bodies

Every console body is parsed with a strict zod schema: unknown fields are refused
(`400 VALIDATION_FAILED`), so a caller cannot send a margin, a credit amount or another
user's id where they are not expected (`hardening.int.test.ts` tries).

## 4. API keys

| Control | Where | Detail |
| --- | --- | --- |
| Generation | [`apps/api/src/security/api-keys.ts`](../../apps/api/src/security/api-keys.ts) | `API_KEY_PREFIX` plus 40 base62 characters (about 238 bits) from the CSPRNG, uniform by rejection sampling |
| Storage | same | HMAC-SHA256 with `API_KEY_PEPPER`; a database dump cannot be turned into working keys. Shown once at creation |
| Lookup | [`apps/api/src/gateway/auth.ts`](../../apps/api/src/gateway/auth.ts) | One indexed equality on the hash. The key context (controls, account status, tier, margin) is cached in Redis for 60 seconds under the hash and dropped on every change to the key or its account |
| Controls | [`apps/api/src/gateway/pipeline.ts`](../../apps/api/src/gateway/pipeline.ts) | Expiry, revocation, model allow-list, IP allow-list (IPv4/IPv6 and CIDRs, compared numerically), monthly budget, RPM and TPM overrides |
| Account status | same | A suspended, banned or erased account's keys stop at the next request (`403 account_restricted` or `401`) |
| Browser use | [`apps/web/src/components/console/playground.tsx`](../../apps/web/src/components/console/playground.tsx) | The playground keeps a pasted key in `sessionStorage` for that tab only and sends it straight to `/v1` |

## 5. Provider credentials

Encrypted at rest with AES-256-GCM under a key derived from `CREDENTIALS_KEY`, the
credential id bound as additional data, decrypted only into the catalogue's in-memory
cache ([ADR 0008](adr/0008-provider-credentials-encrypted.md),
[`apps/api/src/security/credentials.ts`](../../apps/api/src/security/credentials.ts)).
Provider error bodies are logged truncated with key-shaped strings masked and are never
returned to callers ([`apps/api/src/gateway/upstream.ts`](../../apps/api/src/gateway/upstream.ts)).
`secrets.int.test.ts` sends real traffic through a canary credential and checks it
appears in no response and no table in clear.

## 6. Money

| Risk | Control |
| --- | --- |
| Spending past the balance | Worst-case reservation with one conditional update before any provider call ([ADR 0003](adr/0003-wallet-reservations-ledger.md)) |
| Double credit (webhook racing the browser) | One fulfilment path under the top-up row lock; unique indexes on the gateway order and payment ids and on the ledger reference |
| Forged payment | Stripe and Razorpay webhook signatures checked over the raw body in constant time before parsing; Stripe events older than 300 seconds refused; Razorpay checkout returns verified with the key secret and the payment fetched from Razorpay |
| Wrong amount | Fulfilment compares the paid amount and currency with the stored order and refuses a mismatch (marked `FAILED`, `AMOUNT_MISMATCH`) |
| Exchange-rate games | The INR rate is locked into the order at creation ([ADR 0004](adr/0004-one-usd-ledger.md)) |
| Billing at zero | A model cannot be enabled without a priced route ([ADR 0005](adr/0005-pricing-primary-route-and-margin.md)) |
| Free money in production | `PAYMENTS_STUB` is refused with `NODE_ENV=production`; Terraform placeholders (`set-me`) are never accepted as webhook secrets |
| Admin abuse | Grants, adjustments, refunds and margin changes are audited with the actor and reason |

## 7. Request bodies and privacy

By default the gateway stores request **metadata** only: model, route, tokens, latency,
status, price and the caller's IP. Bodies are stored only for keys whose owner turned on
"Keep request and response bodies", only for `bodyRetentionDays` (7 by default, 1 to 90),
and are shown only to that owner. The retention job deletes expired bodies; erasing an
account deletes them at once. Request ids are generated by the server (`req_` plus a
ULID); a client's `x-request-id` is not trusted on `/v1`.

## 8. Upstream calls

- Provider base URLs are set by admins; the gateway never follows a URL from a caller.
- Each route has a timeout (1 to 600 seconds); the caller's disconnect aborts the
  upstream call.
- Retryable failures fail over; caller errors (400, 401, 403, 404, 413, 422) do not, and
  are answered with a generic gateway error, not the provider's body.

## 9. Headers and CSP

The API answers JSON with Helmet defaults and `default-src 'none'`,
`frame-ancestors 'none'`. Console responses are `Cache-Control: no-store` unless a
handler opts in (meta, the public catalogue). `/v1` allows any origin without credentials
(API keys, not cookies, authenticate it).

The web app sets a per-request CSP with a nonce in
[`apps/web/src/middleware.ts`](../../apps/web/src/middleware.ts):

| Directive | Value | Why |
| --- | --- | --- |
| `script-src` | `'self' 'nonce-...' 'strict-dynamic'` (plus `'unsafe-eval'` in development) | `strict-dynamic` lets the app's own nonced code load its chunks and, on the billing page, Razorpay's checkout.js |
| `connect-src` | `'self'` | The playground calls the gateway at this origin's `/v1` |
| `frame-src` | `https://api.razorpay.com https://checkout.razorpay.com` | Razorpay's payment window |
| `style-src` | `'self' 'unsafe-inline'` | Radix positions popovers with inline styles |
| `frame-ancestors`, `object-src` | `'none'` | |
| `base-uri`, `form-action` | `'self'` | |

Static headers from [`apps/web/next.config.ts`](../../apps/web/next.config.ts): `nosniff`,
`Referrer-Policy: strict-origin-when-cross-origin`, `X-Frame-Options: DENY`,
`Cross-Origin-Opener-Policy: same-origin`, and a `Permissions-Policy` that grants nothing
but the Payment Request API to this origin and Razorpay.

## 10. Rate limits

Data plane: RPM and TPM per key and concurrency per account in Redis Lua scripts, from
the key, the account's tier or the default tier ([rate-limits.md](rate-limits.md)).
Console: Redis-backed limits on sign-in, key creation, top-ups, Razorpay verification,
promo redemption and admin actions, with an in-memory fallback during a Redis outage.
JSON bodies are capped at 2 MB on the console and `GATEWAY_MAX_BODY_MB` on `/v1`; audio
uploads at `GATEWAY_MAX_AUDIO_MB`.

## 11. The production guard

`assertProductionConfig` ([`apps/api/src/core/config.ts`](../../apps/api/src/core/config.ts))
refuses to boot with `NODE_ENV=production` when, among others:

- `JWT_SECRET`, `REFRESH_SECRET`, `TOTP_ENCRYPTION_KEY`, `CREDENTIALS_KEY` or
  `API_KEY_PEPPER` is a committed development default or too short;
- `PAYMENTS_STUB=true`;
- `APP_WEB_URL` or `GATEWAY_PUBLIC_URL` points at localhost, or `CORS_ORIGINS` is empty;
- `MAIL_MODE=outbox`, `JOBS_MODE=inline`, or `BCRYPT_ROUNDS` below 12.

`productionWarnings` logs, without refusing, a deployment with no payment gateway or a
gateway without its webhook secret.

## 12. Infrastructure

| Control | Where |
| --- | --- |
| Private subnets for every task; one ALB with TLS | [`infra/terraform/modules`](../../infra/terraform/modules) (network, edge) |
| Optional CloudFront with WAF; `/api` and `/v1` never cached | same (cdn, deployment) |
| RDS encrypted with the deployment's KMS key | same (database) |
| ElastiCache with encryption in transit and at rest | same (cache) |
| Secrets (signing keys, `CREDENTIALS_KEY`, `API_KEY_PEPPER`, payment secrets) in Secrets Manager, injected by ECS | same (secrets) |
| Read-only root filesystem for containers | same (service) |
| Alarms and encrypted logs | same (observability) |

## 13. Supply chain and CI

- `pnpm install --frozen-lockfile`.
- CI runs lint, typecheck, unit and integration tests, the OpenAPI drift check, the
  sanitization scan, gitleaks and the Terraform checks ([`.github/workflows`](../../.github/workflows)).
- [`scripts/check-sanitization.sh`](../../scripts/check-sanitization.sh) refuses credentials,
  account ids, real emails and public IPs in committable files.

## 14. Problems of the system this replaces, fixed by design

| Before | Now |
| --- | --- |
| Wallet admission was "balance above zero"; debits after the call, capped, fire-and-forget | Reservation before the call, settlement in one transaction |
| Verify and webhook could both credit a top-up; USD credited at the current FX rate | One idempotent fulfilment; the rate locked per order |
| Admin margins never applied; unpriced models billed at zero | Margin by precedence on every request; enabling needs a priced route |
| Provider keys in plain text in admin rows | Encrypted at rest, never returned |
| Full prompts and completions stored and shown | Metadata by default; bodies opt-in per key, short retention, owner only |
| Client-controlled request ids | Server-generated ids |
| No rate limits, unused key controls | Limits per key, tier and account; every key control enforced |

## 15. Known limitations

- Rate limits and key budgets fail open when Redis is unreachable; the wallet reservation
  still bounds spend.
- A key's monthly budget can be overshot by requests already in flight when it is reached.
- Token estimates for reservations can run low for unusual inputs; the settled price is
  charged in full and the balance can dip slightly below zero.
- There is no per-account spend alert beyond the low-balance email.
