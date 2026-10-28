# Configuration

Two layers:

- **Environment variables**, read once at boot. Every variable the API and worker read is
  declared and validated in [`apps/api/src/core/config.ts`](../../apps/api/src/core/config.ts)
  (zod); an invalid value stops the process with a list of problems.
- **Admin settings**, one JSON document in the `settings` table, edited in `/admin`,
  **Settings** and applied within seconds without a restart
  ([below](#admin-settings-in-the-database)).

Provider API keys are neither: admins add them in `/admin`, **Providers**, and they are stored
encrypted in Postgres ([providers.md](providers.md)).

## Development defaults and the production guard

Outside production every security-critical value has a development default, so `make up`
works with no setup. With `NODE_ENV=production`, `assertProductionConfig` refuses to start
while any of these is true:

| Problem | Fix |
| --- | --- |
| `JWT_SECRET` or `REFRESH_SECRET` is the committed default, or shorter than 32 characters | Random values of 32+ characters |
| `JWT_SECRET` equals `REFRESH_SECRET` | Different values |
| `TOTP_ENCRYPTION_KEY` is the default | 32 random bytes, base64 (`openssl rand -base64 32`) |
| `CREDENTIALS_KEY` is the default | 32 random bytes, base64 |
| `API_KEY_PEPPER` is the default or shorter than 32 characters | 32+ random characters |
| `CORS_ORIGINS` is empty | The console's origin |
| `APP_WEB_URL` or `GATEWAY_PUBLIC_URL` points at localhost | The public URLs |
| `MAIL_MODE=outbox` | `smtp` or `ses` |
| `MAIL_MODE` is `smtp` or `ses` without `MAIL_FROM` | A sender address |
| `JOBS_MODE=inline` | `queue` and a worker |
| `BCRYPT_ROUNDS` below 12 | 12 or more |
| `PAYMENTS_STUB=true` | Off; configure Stripe or Razorpay |

Outside production the same checks only log warnings. Separately, the API and the worker log
these at boot in every environment (`productionWarnings`); they never stop a deployment:

- no payment gateway configured (neither Stripe nor Razorpay, and no stub): accounts cannot top up;
- Stripe on without `STRIPE_WEBHOOK_SECRET`: Stripe top-ups would never be confirmed;
- Razorpay on without `RAZORPAY_WEBHOOK_SECRET`: Razorpay relies on the browser's verify call only;
- `FX_PROVIDER=openexchangerates` without `FX_API_KEY`: the fixed rate is used.

A secret holding the Terraform placeholder `set-me` counts as unset for every payment and FX key.

## Environment variables

### Server and URLs

| Variable | Default | Notes |
| --- | --- | --- |
| `NODE_ENV` | `development` | `development`, `test` or `production`. Production enables the guard above and keeps the stub providers out of the starter catalogue |
| `PORT` | `5056` | API listen port |
| `PRODUCT_NAME` | `Euron Open AI API Gateway` | Default app name (Settings `appName` overrides it in emails and pages) |
| `APP_WEB_URL` | `http://localhost:3560` | The console's origin: emailed links, Stripe return URLs, the default CORS origin |
| `PUBLIC_API_URL` | `http://localhost:5056` | Declared for the API but not read by it. The web container reads its own `PUBLIC_API_URL` as the API base it hands the browser (default `/api`) |
| `CORS_ORIGINS` | (empty: `APP_WEB_URL`) | Comma-separated origins allowed to call `/api` with credentials. Required in production. `/v1` allows any origin regardless |
| `TRUST_PROXY` | `1` | Proxy hops to trust for the client IP (key IP allow-lists and rate limits use it). 1 behind a load balancer; 2 behind CloudFront plus a load balancer |
| `LOG_LEVEL` | `info` | `fatal`, `error`, `warn`, `info`, `debug`, `trace`, `silent` |

### Gateway

| Variable | Default | Notes |
| --- | --- | --- |
| `GATEWAY_PUBLIC_URL` | `http://localhost:5056/v1` | The base URL developers point their SDK at, including `/v1`. The default for Settings `gatewayBaseUrl`. Must not be localhost in production |
| `API_KEY_PREFIX` | `gw-` | 1 to 8 lowercase letters and a hyphen. Changing it invalidates every issued key |
| `API_KEY_PEPPER` | dev default | HMAC pepper for stored API key hashes. 32+ characters in production. Changing it invalidates every issued key |
| `CREDENTIALS_KEY` | dev default | 32 bytes, base64. Encrypts provider credentials (AES-256-GCM). Changing it makes every stored credential undecryptable ([operations.md](operations.md#credentials_key-rotation)) |
| `GATEWAY_MAX_BODY_MB` | `20` | Largest `/v1` JSON body, 1 to 100 |
| `GATEWAY_MAX_AUDIO_MB` | `25` | Largest transcription upload, 1 to 100 |
| `STUBS_URL` | `http://localhost:5149` | Where providers of kind `STUB` live |

### Database

| Variable | Default | Notes |
| --- | --- | --- |
| `DATABASE_URL` | (local compose Postgres) | A static URL. Local and CI |
| `DATABASE_SECRET_ARN` | | On AWS instead of a URL: the password is read from this RDS-managed secret for every new connection (cached 60 s), so RDS password rotation needs no restart |
| `DB_HOST`, `DB_PORT` (`5432`), `DB_NAME`, `DB_USER` | | With `DATABASE_SECRET_ARN` |
| `DB_SSL` | `require` | With `DATABASE_SECRET_ARN`: `disable`, `require` (encrypted, unverified) or `verify-full` |
| `DB_SSL_CA_FILE` | | CA bundle for `verify-full` |
| `DB_POOL_MAX` | `10` | Connections per process. Keep `DB_POOL_MAX` times the number of API and worker tasks under the database's limit |
| `MIGRATE_ON_BOOT` | `false` | Run migrations when the API starts. Off in compose and on AWS (a one-off task runs them) |
| `MIGRATIONS_DIR` | `db/migrations` | Read only by the migration runner |

### Redis and jobs

| Variable | Default | Notes |
| --- | --- | --- |
| `REDIS_URL` | `redis://localhost:6459` | Queues, rate limits, circuit breakers, key cache, monthly key spend |
| `JOBS_MODE` | `queue` | `queue`: BullMQ, run by the worker. `inline`: handlers run in-process after commit (tests only; refused in production) |

### Accounts and sessions

| Variable | Default | Notes |
| --- | --- | --- |
| `JWT_SECRET` | dev default | Signs access tokens |
| `REFRESH_SECRET` | dev default | Signs refresh tokens; must differ from `JWT_SECRET` |
| `ACCESS_TOKEN_TTL_SECONDS` | `900` | |
| `REFRESH_TOKEN_TTL_DAYS` | `30` | |
| `COOKIE_SECURE` | `auto` | `auto` sets `Secure` on the refresh cookie when `APP_WEB_URL` is https; `true` or `false` force it |
| `BCRYPT_ROUNDS` | `12` | 4 to 15; at least 12 in production |
| `REQUIRE_EMAIL_VERIFICATION` | `true` | New accounts confirm their email before signing in (and before the signup credit) |
| `TOTP_ENCRYPTION_KEY` | dev default | 32 bytes, base64. Encrypts two-factor secrets and keys the recovery-code HMAC |
| `RATE_LIMITS` | on (off under `NODE_ENV=test`) | `off` disables every console rate limit. Does not affect the `/v1` RPM, TPM and concurrency limits |
| `RATE_LIMIT_STORE` | | Under `NODE_ENV=test` limits use memory unless this is `redis` |

### Mail

| Variable | Default | Notes |
| --- | --- | --- |
| `MAIL_MODE` | `outbox` | `outbox` writes `.eml` files under `DATA_DIR` (development), `smtp`, or `ses` |
| `MAIL_FROM` | | Sender; required for `smtp` and `ses` in production |
| `SMTP_HOST`, `SMTP_PORT` (`587`), `SMTP_USER`, `SMTP_PASS` | | For `smtp` |
| `SES_REGION`, `SES_CONFIGURATION_SET` | | For `ses` (`SES_REGION` falls back to `AWS_REGION`) |
| `DATA_DIR` | `./data` | Where the outbox lives |
| `AWS_REGION` | `us-east-1` | For SES and Secrets Manager |
| `AWS_ENDPOINT_URL` | | Points every AWS client at an emulator (Floci locally) |

Mail the gateway sends: email verification, password reset, the admin set-password link, and
the low-balance warning.

### Payments and FX

| Variable | Default | Notes |
| --- | --- | --- |
| `STRIPE_SECRET_KEY` | | Unset or `set-me`: Stripe off |
| `STRIPE_WEBHOOK_SECRET` | | The webhook endpoint's signing secret |
| `STRIPE_API_BASE` | `https://api.stripe.com` | Pointed at the stubs in tests |
| `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET` | | Both set: Razorpay on |
| `RAZORPAY_WEBHOOK_SECRET` | | The webhook secret you chose in Razorpay |
| `RAZORPAY_API_BASE` | `https://api.razorpay.com` | Pointed at the stubs in tests |
| `PAYMENTS_STUB` | `false` | A browser-confirmed stand-in gateway; development and tests only, refused in production |
| `FX_PROVIDER` | `fixed` | `fixed`, `exchangerate` (open.er-api.com, no key) or `openexchangerates` (needs `FX_API_KEY`) |
| `FX_API_KEY` | | For `openexchangerates` |
| `FX_API_BASE` | (the provider's) | Override the FX provider URL |
| `FX_FIXED_INR_PER_USD` | `85` | The rate with `fixed`, and the fallback when no fetched rate is under 48 hours old |

Setup steps for both gateways: [payments.md](payments.md).

### CLI only

| Variable | Notes |
| --- | --- |
| `DEMO_PASSWORD` | `demo:seed`: the password every demo account gets (random and printed when unset) |

### Web app (`apps/web`)

| Variable | Default | Notes |
| --- | --- | --- |
| `API_INTERNAL_URL` | `http://localhost:5056` | Where the Next server proxies `/api/*` and `/v1/*` (the local stack; on AWS the load balancer routes them before Next) |
| `PUBLIC_API_URL` | `/api` | The API base the browser uses, served at request time in `/env.js` |
| `PRODUCT_NAME` | `Euron Open AI API Gateway` | The name before `/api/meta` loads |

## Admin settings (in the database)

`GET` and `PATCH /api/admin/settings`, the **Settings** page. Stored as one document merged
over the defaults in [`services/settings.service.ts`](../../apps/api/src/services/settings.service.ts),
cached 5 seconds per process. Every save is validated and written to the audit log with the
before and after values.

| Key | Default | Range and effect |
| --- | --- | --- |
| `appName` | `PRODUCT_NAME` | 1 to 60 characters. Page titles, emails, receipts, the Stripe line item |
| `tagline` | `One API key for every AI model.` | Up to 160 characters |
| `registration` | `OPEN` | `OPEN`, `INVITE_ONLY` (only `allowedEmailDomains`; needs at least one), `CLOSED` (admins create accounts) |
| `allowedEmailDomains` | `[]` | Domains for `INVITE_ONLY`; subdomains match |
| `supportEmail` | `null` | Shown to developers and on receipts |
| `gatewayBaseUrl` | `GATEWAY_PUBLIC_URL` | The base URL the console shows developers |
| `defaultMarginBps` | `0` | 0 to 100 000. The margin when neither key, account nor model sets one |
| `signupCreditMicros` | `1000000` (1 USD) | 0 to 1 000 USD. Credit booked once when a new account becomes active |
| `taxBps` | `0` | 0 to 5000. Added on top of every top-up, never credited |
| `taxLabel` | `Tax` | On receipts |
| `topupLimits` | USD 5 to 1000, INR 500 to 100 000 | Per currency, in major units. A minimum above its maximum is refused |
| `lowBalanceMicros` | `1000000` (1 USD) | Email an account (that has made requests) once when its available balance falls below this; again only after a credit. 0 turns it off |
| `bodyRetentionDays` | `7` | 1 to 90. How long bodies logged by opt-in keys are kept |
| `requestRetentionDays` | `null` (forever) | 30 to 3650. Request log rows older than this are deleted |
| `minSupportedVersion` | `null` | `major.minor.patch`, published in `/api/meta` for native clients; not enforced by the server |

Groups merge key by key, so `PATCH { "topupLimits": { "usdMax": 5000 } }` changes only that
limit. Unknown keys are refused.
