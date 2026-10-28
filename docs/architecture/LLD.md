# Low-level design

How the code is organised and how each request travels through it. The big picture is in
[HLD.md](HLD.md); the HTTP contract is in [rest-contract.md](../api/rest-contract.md) (console) and [gateway.md](../api/gateway.md) (`/v1`).

## 1. API layers

Pattern: routes, controllers, services, repositories and presenters, with integrations at
the edge ([ADR 0001](adr/0001-monorepo-stack.md)).

| Layer | Folder | Rule |
| --- | --- | --- |
| Routes | `apps/api/src/routes/*.routes.ts` | Mount path, guards (`authenticate`, `rateLimit`) and a doc comment per endpoint. `scripts/gen-openapi.ts` reads these files and [`routes/index.ts`](../../apps/api/src/routes/index.ts) |
| Controllers | `apps/api/src/controllers` | Parse input with strict zod schemas (`core/validate.ts`), call one service, write the response. No business rules |
| Services | `apps/api/src/services` | Business rules and transactions. Take an `Actor`, never an Express request, so jobs and tests can call them |
| Repositories | `apps/api/src/repositories` | Reusable queries (users, sessions, tokens, audit, keyset cursors) |
| Presenters | `apps/api/src/presenters` | Database rows to DTOs from `packages/types` |
| Integrations | `apps/api/src/integrations` | Mail, Redis, HTTP helpers (SSE reader, secret masking) |
| Gateway | `apps/api/src/gateway` | The data plane: `auth`, `catalog`, `pricing`, `tokens`, `limits`, `breaker`, `upstream`, `translate`, `handlers`, `pipeline`, `probe`, `errors` |
| Billing | `apps/api/src/billing` | `wallet` (reserve, settle, release, credit, sweep) and `payments` (Stripe, Razorpay, stub) |
| Jobs | `apps/api/src/jobs` | Named handlers with typed payloads (`registry.ts`) |

Side effects that must wait for a commit (enqueueing a job) go through `Effects` in
[`core/effects.ts`](../../apps/api/src/core/effects.ts): `withTransaction(fn)` hands the
function a transaction and an `Effects` collector, and jobs are enqueued only after the
commit. A rolled-back transaction enqueues nothing.

### The gateway modules

| Module | Responsibility |
| --- | --- |
| [`gateway/auth.ts`](../../apps/api/src/gateway/auth.ts) | Key from `Authorization` or `x-api-key`, HMAC lookup, Redis-cached `KeyContext` (60 s), `last_used_at` at most once a minute, IP allow-list matching, cache invalidation |
| [`gateway/catalog.ts`](../../apps/api/src/gateway/catalog.ts) | Loads usable models and routes with decrypted credentials (5 s cache), resolves ids and aliases, round-robin credentials |
| [`gateway/pricing.ts`](../../apps/api/src/gateway/pricing.ts) | Margin precedence, price lists, token and unit charges (ceil) |
| [`gateway/tokens.ts`](../../apps/api/src/gateway/tokens.ts) | Input estimates for admission |
| [`gateway/limits.ts`](../../apps/api/src/gateway/limits.ts) | RPM and TPM sliding windows and the concurrency slot (Lua) |
| [`gateway/breaker.ts`](../../apps/api/src/gateway/breaker.ts) | Circuit state per route, admin overrides |
| [`gateway/upstream.ts`](../../apps/api/src/gateway/upstream.ts) | One upstream POST with per-kind auth headers, timeout plus caller abort, failure classification |
| [`gateway/translate.ts`](../../apps/api/src/gateway/translate.ts) | OpenAI and Anthropic requests, responses and streams, both directions |
| [`gateway/handlers.ts`](../../apps/api/src/gateway/handlers.ts) | One handler per endpoint: validation, estimate, execute on a route, stream relay |
| [`gateway/pipeline.ts`](../../apps/api/src/gateway/pipeline.ts) | `runCall`: the fixed order of checks, routing loop, settlement ([data-plane.md](data-plane.md)) |
| [`gateway/probe.ts`](../../apps/api/src/gateway/probe.ts) | Free probes and real test calls for one route |
| [`gateway/errors.ts`](../../apps/api/src/gateway/errors.ts) | `GatewayError` and the OpenAI and Anthropic envelopes |

The `/v1` router ([`routes/v1.routes.ts`](../../apps/api/src/routes/v1.routes.ts)) is
mounted in `app.ts` before the console middleware: any origin, no credentials, its own body
limit, multer for audio, and errors in the provider envelopes. The payment webhooks
([`routes/console.routes.ts`](../../apps/api/src/routes/console.routes.ts)) are mounted
before the JSON parser too, with `express.raw`, because their signatures cover the exact
bytes.

## 2. Jobs and schedules

Handlers in [`jobs/gateway.jobs.ts`](../../apps/api/src/jobs/gateway.jobs.ts) and
[`jobs/maintenance.jobs.ts`](../../apps/api/src/jobs/maintenance.jobs.ts); schedules in
[`worker.ts`](../../apps/api/src/worker.ts). `JOBS_MODE=inline` runs them in-process
(tests); `queue` runs them on BullMQ.

| Job | Every | Does |
| --- | --- | --- |
| `gateway.sweep-reservations` | 1 min | Releases wallet holds past their expiry |
| `gateway.health-probes` | 5 min | `GET {base}/models` on every usable route, records `health_checks`, feeds the breaker |
| `gateway.fx-sync` | 6 h | Fetches the INR per USD rate into `fx_rates` (unless `FX_PROVIDER=fixed`) |
| `gateway.low-balance` | 10 min | Emails accounts below `lowBalanceMicros` once per drop |
| `maintenance.lift-suspensions` | 5 min | Ends timed suspensions |
| `maintenance.purge-accounts` | 6 h | Erases accounts past their deletion grace period and drops their cached keys |
| `maintenance.retention` | 6 h | Deletes expired bodies, request rows past `requestRetentionDays`, probes older than 14 days, webhook ids older than 90 days |

Every step is safe to run twice or on two workers at once.

## 3. Request flows

### 3.1 A data-plane call

See [data-plane.md](data-plane.md). In short: `handlers.chatCompletions` validates the
body and calls `runCall` with a spec whose `execute(route)` either passes the request
through to an OpenAI-format route (forcing `stream_options.include_usage`, rewriting
`model` in every chunk) or translates it for an Anthropic route. `runCall` authenticates,
resolves, checks controls, budget and limits, reserves, loops over routes and settles.

### 3.2 Creating a key

`POST /api/keys` (strict body) -> `keys.service.createKey`: validates models against the
catalogue (aliases resolved to ids), expiry and IP entries, caps active keys at 50,
generates the secret, stores its HMAC and display hint, audits, and returns the secret
once. Updates and revocation drop the key's cached context so the next request sees them.

### 3.3 A top-up

`POST /api/billing/topups` -> `billing.service.createTopup` -> the gateway's
`createCheckout` -> `topups` row. Fulfilment runs from the webhook
(`/api/webhooks/stripe|razorpay` -> `handleWebhook`), from Razorpay's verify
(`/api/billing/razorpay/verify`) or from the stub confirm, always through `fulfilTopup`
under the top-up row lock ([billing-and-ledger.md](billing-and-ledger.md)).

### 3.4 Usage views

`GET /api/usage/summary` aggregates `requests` in SQL by day, model and key for the range
(empty days filled). `GET /api/usage/requests` pages with a keyset cursor on
`(created_at, id)`; `GET /api/usage/requests/:id` adds bodies when the key logged them and
they have not expired.

### 3.5 Admin catalogue edits

`admin-catalog.service.ts`: every write runs in a transaction that ends with
`assertEnabledModelsPriced` (no enabled model may be left without a usable, priced route),
is audited, and clears the catalogue cache. Credential secrets are encrypted before the
insert with the new row's id as additional data.

## 4. Web app

| Path | Page |
| --- | --- |
| `/` | Overview: balance, spend, requests, tokens, latency, charts, by model and key; first-run steps |
| `/keys` | API keys: create (limits, budget, IPs, expiry, body logging), edit, revoke; secret shown once |
| `/usage` | Request log with filters and a detail sheet (bodies when kept) |
| `/models` | The catalogue with your prices, in USD or INR |
| `/playground` | Chat with any model using one of your keys, streamed, with latency, tokens and price |
| `/billing` | Balance, top-up (Stripe, Razorpay, stub), promo codes, ledger, top-ups with receipts |
| `/docs` | Base URL, SDK snippets, endpoints, billing, errors |
| `/settings` | Account (profile, security, sessions, export, delete) and appearance |
| `/admin/*` | Overview, users, providers, models, health, billing, limits, settings, audit |

Server state lives in React Query; money is formatted in one module
([`apps/web/src/lib/money.ts`](../../apps/web/src/lib/money.ts)). The playground calls
`/v1` at the web origin (proxied to the API), so the CSP keeps `connect-src 'self'`.
Runtime configuration reaches the browser through `/env.js`
([`apps/web/src/lib/runtime-env.ts`](../../apps/web/src/lib/runtime-env.ts)), so one image
serves every environment.

## 5. Console rate limits

Redis with an in-memory fallback ([`middleware/rate-limit.ts`](../../apps/api/src/middleware/rate-limit.ts)),
keyed by user when signed in, by IP otherwise. The data plane's limits are separate
([rate-limits.md](rate-limits.md)).

| Name | Budget | Key |
| --- | --- | --- |
| `auth` (signup, login, verify, reset, change password, TOTP) | 10 per minute | IP |
| `auth-mail` (resend verification, forgot password) | 5 per hour | IP |
| `auth-refresh` | 60 per minute | IP |
| `key-create` | 30 per hour | user |
| `topup-create` | 20 per hour | user |
| `razorpay-verify` | 30 per hour | user |
| `promo-redeem` | 10 per hour | user |
| `account-delete` | 5 per hour | user |
| `account-export` | 3 per day | user |
| `admin-credit` | 60 per hour | user |
| `admin-erase` | 20 per hour | user |
| `admin-route-test` | 30 per minute | user |

Sign-in also has failure budgets: 5 per account and IP per 15 minutes, 50 per account per
hour. `RATE_LIMITS=off` disables these (the default under `NODE_ENV=test`).

## 6. Errors

Console: services throw `HttpError` subclasses from
[`core/errors.ts`](../../apps/api/src/core/errors.ts); the handler in
[`app.ts`](../../apps/api/src/app.ts) answers `{ error, code, details?, requestId }`. Body
parser errors become `400 BAD_REQUEST` or `413 PAYLOAD_TOO_LARGE`. Anything unexpected is
logged with the request id and answered `500 INTERNAL` without the underlying message.

Data plane: `GatewayError` answered in the OpenAI envelope
(`{ error: { message, type, code, param } }`) or, on `/v1/messages`, the Anthropic one
(`{ type: "error", error: { type, message } }`). The full table is in
[gateway.md](../api/gateway.md).
