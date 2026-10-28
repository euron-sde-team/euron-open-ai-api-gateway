# Testing

Four layers, fast to slow:

| Layer | Command | Needs |
| --- | --- | --- |
| Unit tests (every package) | `make test` (`pnpm test`) | Node only |
| API integration tests | `make test-integration` | Postgres and Redis (started from compose if needed) |
| Integration under each mail backend | `make test-matrix` | The local stack (`make up`) |
| Browser end-to-end | `make e2e` | The local stack plus the demo (`make e2e` starts both) |

No test calls a real model provider or a real payment gateway, and no test needs a key: every
layer runs against the deterministic stubs in [`apps/stubs`](../../apps/stubs/server.mjs).

## Unit tests

```bash
make test                                  # every package, through turbo
pnpm --filter @open-gateway/api test       # one package
```

Vitest, no database, no network.

| Package | Files | Covers |
| --- | --- | --- |
| `apps/api` | [`test/unit`](../../apps/api/test/unit) | Pricing and margin arithmetic and rounding (`pricing.test.ts`, `billing-pricing.test.ts`), the OpenAI and Anthropic translation both ways including streams (`translate.test.ts`), token estimates (`tokens.test.ts`), payment signatures and event normalisation for Stripe and Razorpay (`payments.test.ts`), API key format and hashing (`api-keys.test.ts`), credential encryption (`credentials.test.ts`), IP allow-list matching (`ip-allowlist.test.ts`), logger redaction, HTTP helpers, the production config guard (`hardening.test.ts`), display name and username rules |
| `apps/web` | [`test`](../../apps/web/test) | Console and admin pages, auth forms, helpers in `lib` |
| `packages/api-client` | [`test`](../../packages/api-client/test) | Refresh and retry, native token mode, errors, pagination |
| `packages/ui` | [`test`](../../packages/ui/test) | Shared components |
| `apps/stubs` | [`test`](../../apps/stubs/test/stubs.test.mjs) | The stubs' wire formats and deterministic usage |

## Integration tests

```bash
make test-integration
```

This runs [`scripts/test-db.sh`](../../scripts/test-db.sh) (starts the compose Postgres and
Redis when nothing listens on 5522 and 6459), then:

```bash
TEST_DATABASE_URL=postgres://gw:gw@localhost:5522/gw_test \
TEST_REDIS_URL=redis://localhost:6459/1 pnpm test:integration
```

The suite mounts the real Express app in-process with supertest against a real Postgres and
Redis ([`vitest.integration.config.mts`](../../vitest.integration.config.mts)):

- **Safety.** `TEST_DATABASE_URL` is required and must name a database ending in `_test`
  ([`guard.ts`](../../apps/api/test/integration/guard.ts)). The global setup drops,
  recreates and migrates it once per run, and flushes only a numbered, non-zero Redis
  database.
- **Hermetic upstreams.** The stubs start in-process on an ephemeral port
  ([`global-setup.ts`](../../apps/api/test/integration/global-setup.ts)); `STUBS_URL` points
  the stub providers at them, and the starter catalogue with the stub models is inserted
  before the first test. Real gateway code (upstream calls, translation, streaming,
  failover) runs; only the base URL differs from production.
- **Deterministic jobs.** `JOBS_MODE=inline` runs job handlers right after commit. Rate
  limits on the console are off unless a test turns them on; the `/v1` limits come from the
  key and tier each test sets.
- **Shared database.** Files run one at a time. Every test creates its own users and keys;
  a test that changes shared state (settings, the default tier, the catalogue) restores it.

The fixed environment is in [`env.ts`](../../apps/api/test/integration/env.ts): `NODE_ENV=test`,
`BCRYPT_ROUNDS=4`, `FX_PROVIDER=fixed` at 80 INR per USD, and the payment settings below.

| File | Proves |
| --- | --- |
| `gateway.int.test.ts` | Public model ids, billing exactly once at cost plus margin, streaming and the usage chunk only when asked, 402 before any provider call, parallel requests never overspending, failover on 503 with both attempts recorded, no failover after the first byte and estimated billing of a cut stream, the circuit opening, translation both ways with the right error envelope, per-unit billing for embeddings, images, speech and transcription, margin precedence, auth errors, `/v1/models` filtering, unknown paths |
| `keys.int.test.ts` | Secrets shown once and stored hashed, validation, ownership, revoke, expiry, model and IP allow-lists, monthly budgets, suspended accounts, RPM and TPM 429s with `retry-after` |
| `billing.int.test.ts` | Stripe and Razorpay top-ups end to end, duplicate webhooks, bad signatures, tax, limits, the locked FX rate whichever of verify and webhook comes first, amount mismatches, the stub gateway, receipts, refunds, promo codes, the signup credit, admin grants |
| `admin.int.test.ts` | Admin-only access, encrypted credentials, `MODEL_UNPRICED`, aliases, margin changes on the next request, route tests, forced circuits, tiers, erasure, stats, settings, integrations |
| `jobs.int.test.ts` | The reservation sweeper, health probes opening a dead route's circuit, the low-balance email, retention |
| `secrets.int.test.ts` | A canary provider credential never appears in any response |
| `auth`, `native-auth`, `account`, `console`, `hardening` | Sessions and two-factor, native token mode, account deletion and export, console reads, security headers and limits |

### How payments are faked

The integration suite runs the **real** Stripe and Razorpay clients against the stubs:
`STRIPE_API_BASE` and `RAZORPAY_API_BASE` point at the stub server, with test secrets
(`sk_test_stub`, `whsec_stub`, `rzp_test_stub`, `rzp_secret_stub`, `rzp_whsec_stub`). The
stubs create Checkout Sessions and Orders, and two helpers play the gateway:

| Stub endpoint | Returns |
| --- | --- |
| `POST /__/stripe/pay { sessionId }` | A `checkout.session.completed` event body and its `Stripe-Signature`, signed with `STRIPE_WEBHOOK_SECRET` |
| `POST /__/razorpay/pay { orderId }` | The checkout.js result (order id, payment id, signature with the key secret) and a `payment.captured` webhook body signed with the webhook secret |

The test then posts the webhook (or the verify call) to the app, exactly as the gateway would.
`PAYMENTS_STUB=true` is also set for the stub-gateway tests. Read the stubs' own header comment
in [`apps/stubs/server.mjs`](../../apps/stubs/server.mjs) for the full list, including
`GET /__/requests` and `POST /__/reset`.

### Stub failure switches

| Switch | Effect |
| --- | --- |
| Upstream model `fail-500`, `fail-503`, `fail-429`, `fail-401` | The stub answers that status |
| Upstream model `slow-<ms>` | The stub waits before answering (timeouts) |
| `STUB_CUT` in the last user message | The stream ends half way, without usage |

Stub usage is deterministic: prompt tokens are the characters of every message divided by 4,
rounded up, plus 4 per message; the reply is `Stub reply to: <last user text>` and its tokens
are its characters divided by 4, rounded up. Tests assert exact prices with `priceOf` from the
harness.

## The mail matrix

```bash
make up            # the matrix uses the stack's Postgres, Redis, Mailpit and Floci
make test-matrix
ONLY=ses make test-matrix          # one row
FILTER=auth make test-matrix       # only matching test files
```

[`scripts/test-matrix.sh`](../../scripts/test-matrix.sh) runs the whole integration suite three
times, once per `MAIL_MODE` (`outbox`, `smtp` to Mailpit, `ses` through Floci), each with a
fresh `*_test` database and its own Redis database, and prints a table. It exits non-zero if
any row fails.

## End-to-end tests

```bash
make e2e                                   # make up, make demo, then pnpm e2e
E2E_HEADED=1 pnpm e2e                      # watch it
```

Playwright with Chromium against the running stack
([`e2e/playwright.config.ts`](../../e2e/playwright.config.ts)): the web app on 3560 (which
proxies `/api` and `/v1`), the API, the worker and the stubs. The global setup waits for
`/api/ready` and the web app. Specs live in `e2e/tests/`; the helpers in
[`e2e/helpers.ts`](../../e2e/helpers.ts) create users through the API, sign in, grant credit
as the demo admin, create keys and read request details, so specs can run in parallel without
sharing state. Environment: `E2E_BASE_URL`, `E2E_API_URL` (with `/api`), `E2E_GATEWAY_URL`
(default `<web>/v1`), `E2E_DEMO_PASSWORD` (defaults to `GW_DEMO_PASSWORD`).

## CI

[`.github/workflows/checks.yml`](../../.github/workflows/checks.yml) runs on every push and pull
request: lint, typecheck, unit tests, `pnpm openapi --check` (the OpenAPI document matches the
routes), the sanitization scan, and `terraform fmt` and `validate`. The full pipeline
(integration tests on Postgres and Redis, image builds, Terraform security, gitleaks, e2e) is
in [`.github/workflows-full`](../../.github/workflows-full/README.md), ready to enable.

## Adding a test

An integration test, using the harness ([`harness.ts`](../../apps/api/test/integration/harness.ts)):

```ts
import { describe, expect, it } from "vitest";
import { createKey, createUser, gw, requestRow, walletOf } from "./harness";

describe("my feature", () => {
  it("bills a chat completion", async () => {
    const ada = await createUser({ balanceMicros: 5_000_000 });   // ACTIVE, verified, 5 USD
    const key = await createKey(ada);                              // a gw- secret
    const res = await gw(key.secret).post("/v1/chat/completions").send({ model: "stub-chat", messages: [{ role: "user", content: "hi" }] });
    expect(res.status).toBe(200);
    const row = await requestRow(res);                             // the request log row, by x-request-id
    expect((await walletOf(ada.id)).balance).toBe(5_000_000 - Number(row.price_micros));
  });
});
```

Rules that keep the suite reliable:

- Create your own users, keys and catalogue entries; never depend on another test's data.
- If you change settings, the default tier or the catalogue, restore them (`resetSettings`,
  `resetGatewayState`) in the same test or an `afterEach`.
- Use the stubs' switches for failures rather than mocking modules.
- Assert on stable `code` values, not on messages.

A unit test goes next to the others in `apps/api/test/unit` and must not touch the network or a
database. Run one file with `pnpm --filter @open-gateway/api exec vitest run test/unit/pricing.test.ts`.
