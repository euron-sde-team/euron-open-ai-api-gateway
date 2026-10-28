# Troubleshooting

Symptoms, causes and fixes. Every `/v1` response carries an `x-request-id`. For a request that
was served or failed at the providers it is the `req_...` id of its row in the console's
**Usage** log, which shows the status, attempts, error code and whether usage was estimated
(the route and provider are in the `requests` table, for operators).
Refusals before any provider call (401, 402, 403, 404, 429) are not logged there. Server logs
carry the same id. The full error table is in [gateway.md](../api/gateway.md#errors).

## 402 Payment Required

| Code | Cause | Fix |
| --- | --- | --- |
| `insufficient_balance` | The available balance (balance minus holds for requests in flight) is below this request's worst-case price | Top up, or lower `max_tokens`: the hold is input estimate plus the maximum output |
| `budget_exceeded` | The key's monthly budget would be passed by this request's worst case | Raise the budget on the key, or wait for the next calendar month (UTC) |

Things that make the available balance lower than expected:

- **Holds from requests in flight.** Each running request holds its worst case. Many parallel
  requests with a large `max_tokens` (or none: the hold then uses the model's maximum
  output) can hold most of a small balance.
- **Holds from a crashed process.** If an API task died mid-request, its holds stay until the
  worker's sweeper releases them, 15 minutes after they were taken. If the worker is down they
  stay until it is back. **Billing** shows the amount on hold.
- **A negative balance.** The actual price can exceed the hold (a provider that ignored
  `max_tokens`), and an admin refund debits the full credit even if it was spent. A negative
  balance refuses every request until a top-up covers it.

Failed requests are never charged, so retrying after a 402 costs nothing.

## 429 Too Many Requests

| Code | Limit |
| --- | --- |
| `rate_limit_exceeded` | The key's requests per minute |
| `tokens_rate_limit_exceeded` | The key's tokens per minute |
| `concurrency_limit_exceeded` | The account's requests in flight |

Honour `retry-after` (seconds). The limits come from the key's own RPM and TPM, else the
account's tier, else the default tier (`Default`: 60 RPM, 200 000 TPM, 8 at once).

- **A request that is always refused with `tokens_rate_limit_exceeded`**: TPM counts the input
  estimate plus the maximum output at admission. One request with `max_tokens: 128000` against
  a 100 000 TPM limit can never pass. Lower `max_tokens` or raise the limit (key or tier).
- **429s from far fewer requests than the limit**: long streams hold concurrency slots for
  their whole duration. Raise the tier's concurrency.
- **A 403 from CloudFront instead of a JSON error on the console**: with the CDN on, the WAF
  blocks an IP after 2000 console requests in 5 minutes (`/v1` is exempt; the gateway limits
  per key). See [deploy-aws.md](deploy-aws.md#streams-and-the-network).
- **429 on the console** (`RATE_LIMITED`): the console API's own limits, such as 10 sign-ins
  a minute per IP. Not related to `/v1`.

## 503 no_route_available

Every route of the model has an open circuit, so no provider was tried. Causes:

- The provider is failing: five retryable failures (timeouts, connection errors, 429, 5xx) or
  401/403 answers within a minute opened each route's circuit for 30 seconds.
- An admin forced the circuit open on the Health page.

Check `/admin/health`. If the provider recovered, a circuit half-opens after 30 seconds and the
next success closes it; force it **closed** to clear it at once. For important models, add a
second route on another provider or credential.

## 502 upstream_error and upstream_unavailable

| Code | Meaning | Look at |
| --- | --- | --- |
| `upstream_error` | The provider refused in a way a retry will not fix: 401 or 403 (bad credential), 404 (wrong upstream model name or base URL) | Press **Test** on the route; the message says which. Fix the credential, the upstream model or the base URL |
| `upstream_unavailable` | Every route tried failed with a retryable error | Health page, the provider's status page, the route timeout |

The provider's own error text is in the API logs (masked), never in the response.

## 400 upstream_rejected

The provider answered 400, 413 or 422: a parameter this model does not support, a context that
is too long, or a body the provider will not take. The gateway passes OpenAI-format requests
through unchanged, so a parameter that one OpenAI-compatible host accepts may be rejected by
another. An embeddings, image, speech or transcription model with an Anthropic route also ends
here.

## 404 model_not_found

- The id or alias is misspelt (matching is case-insensitive). `GET /v1/models` with the same
  key lists what it can call.
- The model is disabled.
- The model has no usable route: every route is disabled, its provider is disabled, or the
  provider has no enabled credential that decrypts. After a `CREDENTIALS_KEY` change, every
  model on real providers looks like this ([operations.md](operations.md#credentials_key-rotation)).

A key with an allow-list gets `403 model_not_allowed` for other existing models, not 404.

## 409 MODEL_UNPRICED in the admin

An enabled model must keep at least one enabled route with a cost above zero (input or output
for chat, input for embeddings, unit for the others), on an enabled provider with an enabled
credential. The change you tried would break that for the models in `details.models`. Add or
enable a priced route, enable the provider or a credential, or turn the model off first
([providers.md](providers.md#enabling-a-model-model_unpriced)).

## Keys stopped working

| Response | Cause |
| --- | --- |
| `401 invalid_api_key` | Revoked, mistyped, or issued under a different `API_KEY_PEPPER` or `API_KEY_PREFIX` (changing either invalidates every key) |
| `401 expired_api_key` | Past the key's expiry |
| `403 account_restricted` | The account is suspended, banned or erased. A suspension ends on its date, but keys work again only when the worker's job lifts it (every 5 minutes), plus up to a minute of key cache |
| `403 ip_not_allowed` | The caller's address is not on the key's IP allow-list. Behind a proxy the gateway sees the client address through `TRUST_PROXY` hops; a wrong value makes every caller look like the load balancer |
| `402 budget_exceeded` | The monthly budget |

## Webhooks not crediting

A top-up stuck in `CREATED` after the buyer paid:

1. **Check the gateway's webhook log** (Stripe: Developers, Webhooks; Razorpay: Webhooks).
   - **400**: the signature did not verify. The webhook secret in the server
     (`STRIPE_WEBHOOK_SECRET`, `RAZORPAY_WEBHOOK_SECRET`) does not match the endpoint's, is
     unset, or is still `set-me`. A Stripe event older than 300 seconds (a server clock that is
     off, or a replay) is also refused. Something that rewrites the body on the way in (a proxy
     that re-encodes JSON) breaks the signature too.
   - **500**: fulfilment failed; the API log has the error with the event id. The gateway
     retries.
   - **No delivery**: the endpoint URL is wrong or not public, or the event types are not
     subscribed. Stripe needs `checkout.session.completed` (and the async ones);
     Razorpay `payment.captured` or `order.paid`.
2. **200 but no credit**: the event may be for an order the server does not know (a webhook
   from another environment sharing the gateway account), or the amount or currency did not
   match the top-up (it is then `FAILED` with `AMOUNT_MISMATCH` and the API logs
   "top-up amount mismatch"). Stripe events with `payment_status` other than `paid` wait for
   the async event.
3. **Razorpay**: even without webhooks, the browser's verify call credits the top-up. A buyer
   who closed the tab before it ran is credited only by the webhook.
4. **The console shows "Top-ups are not available"**: no gateway is configured for any
   currency. **Settings**, **Integrations** shows what the server sees.

If the money was taken and cannot be credited automatically, book a **grant** for the credit
amount on the account with a reason, and keep the gateway's payment id in it.

## INR rate questions

- **"Why did I get fewer dollars than the rate today?"** The credit uses the rate locked when
  checkout started, rounded down to the micro-dollar, and tax is never credited. The receipt
  shows the locked rate.
- **The rate never changes.** `FX_PROVIDER` is `fixed` (the code default; the Terraform default
  is `exchangerate`), or the worker is not running `gateway.fx-sync`, or every fetch fails and
  the newest stored rate is over 48 hours old, so `FX_FIXED_INR_PER_USD` is used.
  **Settings**, **Integrations** shows the rate, its source and when it was fetched.
- **openexchangerates without a key** falls back to the fixed rate, with a boot warning.
- A fetched rate outside 10 to 1000 INR per USD is treated as a provider fault and ignored.

## Streams cut short

- **The stream stops after about 60 seconds of silence** behind an AWS load balancer: the idle
  timeout is too low. The Terraform sets 300 s (`alb_idle_timeout`); an older or hand-made load
  balancer may still have 60 s.
- **A stream from a proxy you run yourself stops after a silence**: the gateway sends an SSE
  comment (`: keep-alive`) every 15 seconds while a stream is open, which keeps the load
  balancer and CloudFront from closing it; a proxy that buffers or strips comments can still
  cut it. Turn buffering off for `/v1`.
- **The stream stops at the route timeout**: each route has a timeout (default 120 s) that
  covers the whole provider call, including a long stream. Raise it in Admin, Models for slow
  models.
- **A proxy buffers the stream**: the gateway sends `X-Accel-Buffering: no` and
  `Cache-Control: no-cache, no-transform`. A proxy that ignores them delivers the stream in one
  piece at the end.
- **A rolling deploy**: old API tasks finish in-flight requests for up to 25 seconds, then
  exit.

A cut stream ends without `data: [DONE]` (OpenAI format) or `message_stop` (Anthropic format).
It is billed for what was delivered: the provider's usage if any arrived, else an estimate,
flagged in the request log with `error_code = stream_interrupted`.

## Usage marked estimated

The provider returned no usage (some OpenAI-compatible hosts omit it, especially when
streaming), so the gateway billed its estimate: about four characters a token for text, 1200
tokens per image in the input, and for transcription about one minute per megabyte when no
duration came back. Prefer providers that report usage; the gateway always asks for it.

## The request is not in Usage yet

Settlement is written just after the response is sent. A request appears in the log a moment
after its response ends; for a stream, after the stream ends.

## Admin and setup

| Symptom | Fix |
| --- | --- |
| The API refuses to start with "Refusing to start with an insecure configuration" | Fix each listed variable ([configuration.md](configuration.md#development-defaults-and-the-production-guard)) |
| No models in `/v1/models` on a new deployment | The starter models start disabled: add credentials, check costs, **Test**, enable ([providers.md](providers.md#the-starter-catalogue)) |
| `make aws-admin` exits non-zero | The set-password email could not be sent: verify the SES identity and, in the SES sandbox, the recipient |
| No verification emails locally | They are in Mailpit at http://localhost:8076 |
| Test top-ups do nothing locally | No gateway is configured and `PAYMENTS_STUB` is off; turn it on for development ([payments.md](payments.md#payments_stub-for-development)) |
