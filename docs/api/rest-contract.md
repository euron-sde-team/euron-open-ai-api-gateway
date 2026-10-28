# REST contract (`/api`)

The console and admin API: accounts, API keys, the wallet and top-ups, usage, payment
webhooks and the admin control plane. The developer console (`apps/web`) is its only
first-party client, through [`packages/api-client`](../../packages/api-client/src/index.ts);
the response types live in [`packages/types`](../../packages/types/src/index.ts).

This page is the map: conventions, the auth model, errors, and each area with the codes
worth handling. The field-level reference is [`openapi.yaml`](openapi.yaml), generated from
the route files' doc comments (`make openapi`). The data plane (`/v1`, API-key auth) is a
separate surface: [gateway.md](gateway.md).

Routers: [`apps/api/src/routes`](../../apps/api/src/routes) (mount points in
[`routes/index.ts`](../../apps/api/src/routes/index.ts); webhooks and `/v1` are mounted in
[`app.ts`](../../apps/api/src/app.ts)).

## Conventions

- **JSON in and out**, except the receipt (`application/pdf`) and the webhooks (raw bodies).
- **Strict bodies.** Every body schema rejects unknown keys:
  `400 VALIDATION_FAILED` with `details.fields: [{ path, message }]`.
- **Ids** in paths are ULIDs, except provider slugs (`openai`), model ids (`gpt-5.4-mini`,
  letters, digits and `. _ : / -`) and request ids (`req_<ULID>`). A malformed id is
  `400 VALIDATION_FAILED`.
- **Ownership.** Another account's key, top-up or request is `404`, never `403`.
- **Writes need an ACTIVE account.** A suspended account can sign in and read, but gets
  `403 ACCOUNT_RESTRICTED` when it creates or edits a key, starts a top-up, redeems a promo
  code or edits its display name. (A banned account cannot authenticate at all.)
- **Status codes.** Creates answer `201`; deletes and actions without a body answer `204`;
  sign-up with email verification on and resend verification answer `202`.
- **Caching.** Every `/api` response is `Cache-Control: no-store`, except `GET /api/meta`
  and the signed-out `GET /api/catalog` (`public, max-age=30`).
- **Origins.** Non-GET requests with an `Origin` header outside `CORS_ORIGINS` (default:
  `APP_WEB_URL`) are refused with `403 CORS_ORIGIN_DENIED`. Webhooks are exempt.
- **Request ids.** Every response has `X-Request-Id`. A well-formed incoming `x-request-id`
  (8 to 64 word characters or hyphens) is reused.

Health endpoints outside `/api`'s auth: `GET /up` (the process is up, `{ "ok": true }`) and
`GET /api/ready` (Postgres and Redis answer; `503 { "ok": false }` otherwise; the load
balancer's health check).

## Auth model

| | Access token | Refresh token |
| --- | --- | --- |
| Web (default) | Returned in the body of every session response (`accessToken`, `expiresIn`); send as `Authorization: Bearer <token>`; keep in memory | `gw_refresh` cookie: httpOnly, `SameSite=Lax`, `Path=/api/auth`, `Secure` when `COOKIE_SECURE` says so (`auto`: when `APP_WEB_URL` is https) |
| Native (`X-Client: native`) | Same | In the body as `refreshToken` and `refreshExpiresAt`; sent back as `{ refreshToken }` to `/auth/refresh` and `/auth/logout`; no cookie is ever set ([mobile-clients.md](../guides/mobile-clients.md)) |

Access tokens live `ACCESS_TOKEN_TTL_SECONDS` (900). Refresh tokens live
`REFRESH_TOKEN_TTL_DAYS` (30) and rotate on every use; replaying a rotated one revokes the
whole session family. Each request reloads the account, so a ban, a deactivation or "sign out
everywhere" takes effect on the next request, not when the token expires.

| Response | Meaning | Client action |
| --- | --- | --- |
| `401 UNAUTHENTICATED` | No token | Sign in |
| `401 TOKEN_INVALID` | Bad, expired or revoked access token | Refresh, then retry once |
| `401 SESSION_EXPIRED` (from `/auth/refresh`) | The refresh token is revoked, expired or replayed | Sign in again |
| `403 ACCOUNT_BANNED`, `403 ACCOUNT_DEACTIVATED` | The account cannot be used | Sign out |
| `403 ACCOUNT_RESTRICTED` | Suspended: reads work, the writes listed above do not | Show the restriction |
| `403 FORBIDDEN_ADMIN` | Not an admin, on `/api/admin/*` | |

The console API never accepts a `gw-` API key, and `/v1` never accepts an access token.

## Errors

Every non-2xx body:

```json
{ "error": "Top up between 5 and 1000 USD", "code": "TOPUP_AMOUNT", "details": { "min": 5, "max": 1000 }, "requestId": "01J..." }
```

Switch on `code`; `error` is for people and may change. `details` is present only when the
code carries data. Generic codes: `BAD_REQUEST`, `VALIDATION_FAILED`, `INVALID_CURSOR`,
`PAYLOAD_TOO_LARGE` (bodies over 2 MB), `NOT_FOUND`, `CONFLICT`, `RATE_LIMITED`, `INTERNAL`
(500, nothing internal in the message; the request id is in the server log).

**Rate limits** answer `429 RATE_LIMITED` with a `Retry-After` header and
`details.retryAfterSeconds`. They are kept in Redis (shared by every API task; per task in
memory while Redis is down), keyed by account when signed in and by IP otherwise:

| Limiter | Budget |
| --- | --- |
| Sign-up, verify-email, login, reset-password, change-password, two-factor changes | 10 a minute per IP |
| Resend verification, forgot password | 5 an hour per IP |
| Refresh | 60 a minute per IP |
| Failed sign-ins | 5 per account and IP per 15 minutes, 50 per account per hour |
| Create a key | 30 an hour |
| Create a top-up | 20 an hour |
| Razorpay verify | 30 an hour |
| Redeem a promo code | 10 an hour |
| Account deletion request | 5 an hour |
| Data export | 3 a day |
| Admin: erase an account | 20 an hour |
| Admin: credit an account | 60 an hour |
| Admin: route test | 30 a minute |

## Pagination

Lists are keyset pages: `{ "items": [...], "nextCursor": "..." | null }`, with `?cursor=`
and `?limit=`. A cursor is opaque base64url of the last row's `(created_at, id)`; pass
`nextCursor` back unchanged until it is `null`. A tampered cursor is `400 INVALID_CURSOR`.
There are no totals and no offsets ([`repositories/keyset.ts`](../../apps/api/src/repositories/keyset.ts)).

| Lists | Default and max `limit` |
| --- | --- |
| Console: ledger, top-ups, request log | 25, 50 |
| Admin: users, top-ups, audit | 30, 100 |

Keys, sessions, tiers, providers, models, health rows and promo codes are plain arrays.

## Auth: `/api/auth`

| Method and path | Auth | Notes |
| --- | --- | --- |
| `POST /signup` | public | `{ email, username, displayName, password }`. `202 { verificationRequired }` when `REQUIRE_EMAIL_VERIFICATION` is on, else `201` with a session. `403 REGISTRATION_CLOSED`, `403 REGISTRATION_DOMAIN_NOT_ALLOWED`, `409 EMAIL_TAKEN`, `409 USERNAME_TAKEN`, `409 USERNAME_RESERVED`, `400 WEAK_PASSWORD` |
| `POST /verify-email` | public | `{ token }` from the email; signs in. The signup credit is granted here, once |
| `POST /resend-verification` | public | `202` whatever the address |
| `POST /login` | public | `{ login (email or username), password, totp?, recoveryCode? }`. `{ totpRequired: true }` when a second factor is needed. `401 INVALID_CREDENTIALS`, `401 INVALID_TOTP`, `401 INVALID_RECOVERY_CODE`, `403 EMAIL_NOT_VERIFIED` |
| `POST /refresh` | cookie or body token | New access token (and refresh token, rotated). `204` when there is no cookie |
| `POST /logout` | cookie or body token | `204` |
| `POST /logout-all` | bearer | Revokes every session and access token. `204` |
| `POST /forgot-password`, `POST /reset-password` | public | Reset by emailed token. New passwords are 10 to 128 characters |
| `POST /change-password` | bearer | |
| `GET /me` | bearer | The signed-in account |
| `POST /totp/setup`, `/totp/enable`, `/totp/disable`, `/totp/recovery-codes` | bearer | Two-factor enrolment; `enable` returns ten recovery codes once. `409 TOTP_ALREADY_ENABLED`, `409 TOTP_NOT_ENABLED` |

## Your account: `/api/users`

| Method and path | Notes |
| --- | --- |
| `GET /me`, `PATCH /me` | Identity, status, role; edit `displayName` |
| `DELETE /me` | `{ password, totp? or recoveryCode? }`. Signs out everywhere; after 14 days without a sign-in the identity is erased, keys revoked and logged bodies deleted. `409 LAST_ADMIN` |
| `GET /me/export` | JSON: account, keys (no secrets), ledger, top-ups, request metadata |
| `GET /me/sessions`, `DELETE /me/sessions/{id}` | Signed-in sessions; revoke one |

## Public: `/api/meta` and `/api/catalog`

| Method and path | Auth | Returns |
| --- | --- | --- |
| `GET /api/meta` | public | `AppMeta`: app name, tagline, registration mode, `gatewayBaseUrl`, `keyPrefix`, payable currencies with their min and max, tax, signup credit, the current INR per USD rate, support email |
| `GET /api/catalog` | optional bearer | `ModelInfo[]`: every callable model with its price. Signed out: list prices (the model's margin, else the default). Signed in: prices at the account's margin. A key margin, if an admin set one, is not reflected here |

## API keys: `/api/keys`

| Method and path | Notes |
| --- | --- |
| `GET /` | Your keys with this month's spend each. Never a secret |
| `POST /` | `{ name, expiresAt?, allowedModels?, monthlyBudgetMicros?, rpm?, tpm?, ipAllowlist?, logBodies? }`. `201` with `secret`, shown once. `409 KEY_LIMIT` (50 active keys), `400 UNKNOWN_MODEL`, `400 EXPIRY_IN_PAST`, `400 IP_ALLOWLIST_INVALID` |
| `PATCH /{id}` | Any subset of the create body; effective on the next `/v1` request. `409 KEY_REVOKED`, `404 KEY_NOT_FOUND` |
| `DELETE /{id}` | Revoke, permanently. `204` |

## Billing: `/api/billing`

| Method and path | Notes |
| --- | --- |
| `GET /wallet` | `balanceMicros`, `reservedMicros` (held by requests in flight), `availableMicros`, `balanceInr`, `inrPerUsd` |
| `GET /ledger` | Every balance change, newest first; `?type=TOPUP\|GRANT\|PROMO\|SIGNUP\|USAGE\|REFUND\|ADJUSTMENT` |
| `GET /topups`, `GET /topups/{id}` | Your top-ups |
| `POST /topups` | `{ currency: "USD" \| "INR", amount }` in major units before tax. Returns the order and the checkout to open (`redirect` URL for Stripe, `razorpay` order for checkout.js, `stub` in development). `400 TOPUP_AMOUNT` (with `min`, `max`), `409 GATEWAY_UNAVAILABLE` |
| `GET /topups/{id}/receipt.pdf` | PDF receipt for a paid or refunded top-up. `409 TOPUP_NOT_PAID` |
| `POST /razorpay/verify` | `{ orderId, paymentId, signature }` from checkout.js. Verified, confirmed with Razorpay (captured if only authorised), credited once. `400 SIGNATURE_INVALID`, `409 PAYMENT_PENDING`, `404 TOPUP_NOT_FOUND` |
| `POST /topups/{id}/stub-confirm` | Development only (`PAYMENTS_STUB=true`). `403 STUB_DISABLED` otherwise |
| `POST /promo` | `{ code }`. `404 PROMO_NOT_FOUND`, `409 PROMO_USED`, `410 PROMO_EXPIRED` (expired or fully redeemed) |

The payment flow end to end is in [payments.md](../guides/payments.md).

## Usage: `/api/usage`

| Method and path | Notes |
| --- | --- |
| `GET /summary` | Totals, by day, by model and by key for `?from&to` (UTC dates, default the last 30 days, at most 400 days), filterable by `apiKeyId` and `modelId`. `400 INVALID_RANGE` |
| `GET /requests` | The request log, newest first; `?apiKeyId&modelId&status=ok\|error` |
| `GET /requests/{id}` | One request (`req_<ULID>`): model, endpoint, key, tokens or units, price charged, latency, time to first byte, attempts, status and error code, whether usage was estimated, and the bodies when the key logged them and they have not expired. `404 REQUEST_NOT_FOUND` |

## Webhooks: `/api/webhooks`

Mounted before the JSON parser and the origin check: the body arrives raw (up to 1 MB),
because the signature covers the exact bytes. No session.

| Path | Signature | Events acted on |
| --- | --- | --- |
| `POST /api/webhooks/stripe` | `Stripe-Signature: t=<unix>,v1=<hex>`, `v1 = HMAC-SHA256(STRIPE_WEBHOOK_SECRET, "<t>.<raw body>")`; refused when `t` is more than 300 s away; any of several `v1` values may match (secret rolling) | `checkout.session.completed` and `checkout.session.async_payment_succeeded` (credit when `payment_status` is `paid`), `checkout.session.async_payment_failed` and `checkout.session.expired` (mark failed) |
| `POST /api/webhooks/razorpay` | `X-Razorpay-Signature` = `HMAC-SHA256(RAZORPAY_WEBHOOK_SECRET, raw body)` | `payment.captured`, `order.paid` (credit), `payment.failed` (mark failed) |

Responses:

| Status | When |
| --- | --- |
| `200 { "received": true }` | Recorded. Includes duplicates, events of other types, and events for an unknown order |
| `400 { "received": false }` | Bad or missing signature, the webhook secret is unset (or `set-me`), or the body is not JSON |
| `500 { "received": false }` | Fulfilment failed; the event is not marked seen, so the gateway's retry gets another chance |

Idempotency, in layers ([`services/billing.service.ts`](../../apps/api/src/services/billing.service.ts)):

1. The event id (Stripe's `id`; Razorpay's `X-Razorpay-Event-Id`, or a hash of the signed
   body) is inserted into `payment_webhook_events` in the same transaction as the
   fulfilment. A repeat delivery stops there. Ids are kept 90 days.
2. Fulfilment locks the top-up row and does nothing if it is already `PAID` or `REFUNDED`,
   so the webhook and Razorpay's browser-side verify can race and still credit once.
3. The amount and currency in the event must equal the top-up's total; otherwise the
   top-up is marked `FAILED` (`AMOUNT_MISMATCH`) and nothing is credited.
4. The ledger credit is unique per `(ref_type, ref_id, type)`.

## Admin: `/api/admin`

Admins only (`403 FORBIDDEN_ADMIN`). Admins see accounts, money, usage metadata and
configuration; no endpoint returns request bodies or provider secrets. Every change is
written to the audit log in the same transaction.

### Overview

| Method and path | Notes |
| --- | --- |
| `GET /me` | `{ role }` |
| `GET /stats` | `?from&to` (UTC dates, default the last 30 days, at most a year): accounts, active accounts, requests and errors, revenue (`price_micros`), provider cost (`cost_micros`), margin, top-ups and free credits booked, by day, by model and by provider (with failovers and latency). `400 RANGE_INVALID`, `400 RANGE_TOO_LONG` |

### Accounts and tiers

| Method and path | Notes |
| --- | --- |
| `GET /users` | `?q&status&role&tierId`, with balance and this month's spend |
| `GET /users/{id}` | Balance, keys with their margins, totals, 30 days of spend. `404 USER_NOT_FOUND` |
| `PATCH /users/{id}/role` | `{ role: USER \| ADMIN }`. `403 SELF_ACTION`, `409 LAST_ADMIN` |
| `POST /users/{id}/suspend` | `{ days (1 to 365), reason? }`. Keys stop working until it ends. `403 TARGET_PROTECTED` for admins, `400 DAYS_INVALID` |
| `POST /users/{id}/unsuspend`, `/ban`, `/unban` | Ban signs the account out everywhere and stops its keys. `409 INVALID_STATUS`, `409 USER_ERASED` |
| `POST /users/{id}/erase` | `{ reason }`: identity anonymised, keys revoked, logged bodies deleted; financial records kept. `409 ALREADY_ERASED` |
| `PUT /users/{id}/tier` | `{ tierId }` (null: the default tier). `404 TIER_NOT_FOUND` |
| `PUT /users/{id}/margin` | `{ marginBps }` (0 to 100 000; null falls back to the model, then the default) |
| `PUT /users/{id}/keys/{keyId}/margin` | `{ marginBps }`: the highest-precedence margin |
| `POST /users/{id}/credit` | `{ type: GRANT \| ADJUSTMENT, amountMicros, reason }`. A grant must be positive; an adjustment may be negative; zero is refused (`400 AMOUNT_INVALID`) |
| `GET /tiers` | Tiers with how many accounts use each |
| `POST /tiers`, `PUT /tiers/{id}` | `{ name, rpm, tpm, concurrency, isDefault? }` (null: unlimited). `409 TIER_EXISTS` |
| `DELETE /tiers/{id}` | Its accounts fall back to the default. `409 TIER_DEFAULT` |

Status, tier and margin changes drop the account's cached key contexts, so `/v1` sees them on
the next request.

### Providers, models, routes and health

| Method and path | Notes |
| --- | --- |
| `GET /providers` | Providers with credentials (label, last four characters, enabled) and route counts |
| `POST /providers`, `PUT /providers/{id}`, `DELETE /providers/{id}` | `{ id (slug), kind: OPENAI_COMPATIBLE \| ANTHROPIC \| GEMINI \| STUB, displayName, baseUrl, enabled }`. `400 BASE_URL_REQUIRED` (OpenAI-compatible without a URL), `400 BASE_URL_INVALID`, `409 PROVIDER_EXISTS` |
| `POST /providers/{id}/credentials` | `{ label, secret }`: encrypted on arrival, never returned. `400 SECRET_INVALID` (under 8 characters) |
| `PATCH /providers/{id}/credentials/{credentialId}`, `DELETE ...` | `{ enabled }`; delete |
| `GET /models` | Models with routes (cost, circuit, last check), the margin in force and the price callers pay |
| `POST /models`, `PUT /models/{id}`, `DELETE /models/{id}` | Kind, names, aliases, limits, capability flags, `marginBps`, `enabled`, `sortOrder`. `409 MODEL_EXISTS`, `409 ALIAS_TAKEN` |
| `POST /models/{id}/routes`, `PUT .../routes/{routeId}`, `DELETE ...` | `{ providerId, upstreamModel, priority (1 to 100), timeoutMs? (1 000 to 600 000, default 120 000), inputMicrosPerMtok, outputMicrosPerMtok, cachedMicrosPerMtok?, unitMicros?, enabled? }`. `409 ROUTE_EXISTS` |
| `POST /models/{id}/routes/{routeId}/test` | One tiny real call through the route: `{ ok, latencyMs, message }`. Recorded as a health check |
| `GET /health` | Every route with its circuit, 24-hour success rate and median latency, and its recent probes |
| `POST /health/{routeId}/circuit` | `{ state: open \| closed }`: take a route out of rotation, or clear a trip. `204` |

Any change that would leave an enabled model without an enabled, priced route on an enabled
provider with an enabled credential is refused with `409 MODEL_UNPRICED` (with
`details.models`). See [providers.md](../guides/providers.md).

### Money, settings and audit

| Method and path | Notes |
| --- | --- |
| `GET /topups` | Every top-up; `?status&userId` |
| `POST /topups/{id}/refund` | `{ reason }`: marks a paid top-up `REFUNDED` and debits its credit. The money goes back in the gateway's dashboard. `409 TOPUP_NOT_PAID`. `204` |
| `GET /promos`, `POST /promos`, `PATCH /promos/{id}` | `{ code (3 to 40 letters, digits, - or _), amountMicros, maxRedemptions?, expiresAt? }`; `{ active }`. `409 PROMO_EXISTS` |
| `GET /settings`, `PATCH /settings` | Deployment settings; groups merge key by key; audited with before and after. `400 SETTINGS_INVALID` ([configuration.md](../guides/configuration.md#admin-settings-in-the-database)) |
| `GET /integrations` | Mail mode, which payment gateways are on, the FX rate and its source, whether `CREDENTIALS_KEY` is set. Never a secret |
| `GET /audit` | `?action=` (a prefix) `&actorId&entityType&entityId`, newest first |
