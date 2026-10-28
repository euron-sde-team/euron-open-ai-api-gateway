# @open-gateway/stubs

Deterministic stand-ins for every third party the gateway talks to: AI providers in the
OpenAI format and the Anthropic format, and the Stripe and Razorpay APIs. One
dependency-free Node script (`node:http`, `node:crypto`), state in memory, port 5149.

The API runs its real upstream calls and payment clients against it; only the base URL
differs from production. The starter catalogue adds stub providers outside production
only, and the admin API refuses to create a stub provider in production.

```bash
PORT=5149 node apps/stubs/server.mjs            # or: pnpm --filter @open-gateway/stubs start
pnpm --filter @open-gateway/stubs test          # wire-format and payment-signature tests
```

## What it answers

| Path | Stands in for |
| --- | --- |
| `GET /v1/models`, `POST /v1/chat/completions` (streaming, usage on request, a tool call when the last user message says `STUB_TOOL`), `/v1/embeddings`, `/v1/images/generations`, `/v1/audio/speech`, `/v1/audio/transcriptions` | An OpenAI-compatible provider (`STUB` provider kind, base `STUBS_URL/v1`) |
| `GET /anthropic/v1/models`, `POST /anthropic/v1/messages` (streaming and not) | Anthropic (an `ANTHROPIC` provider with base URL `STUBS_URL/anthropic/v1`) |
| `POST /stripe/v1/checkout/sessions`, `GET /stripe/checkout/<id>` | Stripe Checkout: the page's Pay button marks the session paid, sends the signed `checkout.session.completed` webhook to `STUBS_API_URL/api/webhooks/stripe` and redirects to the session's `success_url` |
| `POST /razorpay/v1/orders`, `GET /razorpay/v1/payments/<id>`, `POST .../capture` | Razorpay Orders and Payments |

## Determinism

- Prompt tokens are the characters of every message divided by 4, rounded up, plus 4 per
  message (plus the system prompt). The reply is `Stub reply to: <the last user text, first
  80 characters>`; its tokens are its characters divided by 4, rounded up. Tests compute
  exact prices from this.
- Transcription reports one minute of audio per 100 KB uploaded.

## Failure switches

| Upstream model name | Answer |
| --- | --- |
| `fail-500`, `fail-503`, `fail-429`, `fail-401`, any `fail-<status>` | that status |
| `slow-<ms>` | waits that long first |

`STUB_CUT` in the last user message ends a stream half way, without usage (for the
"bills an estimate for a cut stream" path). The demo model `stub-failover` uses a
`fail-503` primary route to show failover.

## Test helpers

Never used in production; for the integration tests and local experiments.

| Path | Does |
| --- | --- |
| `GET /__/requests` | Every request received, newest first (authorization headers reduced to "present") |
| `POST /__/reset` | Clears the request log |
| `POST /__/stripe/pay { sessionId }` | Marks a Checkout Session paid and returns the signed webhook body and `Stripe-Signature` |
| `POST /__/razorpay/pay { orderId, amount?, authorizeOnly? }` | Creates a captured payment and returns the checkout.js signature and a signed webhook |

## Environment

| Variable | Default | Used for |
| --- | --- | --- |
| `PORT` | 5149 | Listen port |
| `STUBS_PUBLIC_URL` | `http://localhost:5149` | The Checkout URL handed to browsers |
| `STUBS_API_URL` | `http://localhost:5056` | Where the Checkout page delivers the Stripe webhook |
| `APP_WEB_URL` | `http://localhost:3560` | Fallback redirect when a session has no return URL |
| `STRIPE_WEBHOOK_SECRET` | `whsec_stub` | Signs Stripe events; must match the API's |
| `RAZORPAY_KEY_SECRET` | `rzp_secret_stub` | Signs checkout.js returns; must match the API's |
| `RAZORPAY_WEBHOOK_SECRET` | `rzp_whsec_stub` | Signs Razorpay webhooks; must match the API's |
