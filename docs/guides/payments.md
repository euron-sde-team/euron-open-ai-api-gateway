# Payments: Stripe, Razorpay and the wallet

Every account has one prepaid wallet in US dollars (integer micro-USD). Requests are paid from
it; money comes in through top-ups, and free credit through the signup credit, promo codes and
admin grants. Two gateways take top-ups:

| Currency | Gateway | Checkout |
| --- | --- | --- |
| USD | Stripe | A hosted Checkout Session (the browser is redirected) |
| INR | Razorpay | An Order paid through Razorpay's checkout.js (UPI, cards, netbanking) |

Either gateway is optional. A currency is offered only when its gateway is configured (or the
development stub is on). With neither, the console says top-ups are not available, the API
logs a warning at boot, and accounts live on free credit only.

The code: [`billing/payments.ts`](../../apps/api/src/billing/payments.ts) (gateway clients,
signature checks), [`services/billing.service.ts`](../../apps/api/src/services/billing.service.ts)
(top-ups, fulfilment, refunds, receipts), [`billing/wallet.ts`](../../apps/api/src/billing/wallet.ts)
(the ledger). The design: [billing-and-ledger.md](../architecture/billing-and-ledger.md).

## How a top-up works

1. The developer picks a currency and an amount in **Billing** (`POST /api/billing/topups`).
   The amount must be within the Settings limits.
2. The API prices it: tax on top (`taxBps`, rounded up), and the credit in micro-USD. USD
   credits one to one. INR credits at the INR per USD rate in force **now**, rounded down to
   the micro-dollar, and that rate is stored on the top-up row. The console shows "You pay"
   and "Added to your balance" before checkout.
3. The API opens the gateway's checkout and stores the top-up as `CREATED`.
4. The developer pays. The gateway confirms by webhook (and, for Razorpay, checkout.js's
   success callback too).
5. One fulfilment path, in one transaction: lock the top-up row; stop if it is already `PAID`
   or `REFUNDED`; check that the paid amount and currency equal the top-up's total and
   currency (otherwise mark it `FAILED` with `AMOUNT_MISMATCH` and credit nothing); mark it
   `PAID`; book a `TOPUP` ledger entry. Whichever confirmation arrives second changes
   nothing.

Tax is charged and shown on the receipt but never credited: a 100 USD top-up at 18% tax
charges 118 USD and credits 100 USD.

## Stripe (USD)

### Setup

1. In the Stripe dashboard, take the **secret key** (`sk_live_...`, or `sk_test_...` for test
   mode).
2. Add a webhook endpoint:
   - URL: `https://<domain>/api/webhooks/stripe`
   - Events: `checkout.session.completed`, `checkout.session.async_payment_succeeded`,
     `checkout.session.async_payment_failed`, `checkout.session.expired`
3. Copy the endpoint's **signing secret** (`whsec_...`).
4. Set `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` (on AWS: the `<name_prefix>/billing`
   secret, then roll the API; see [deploy-aws.md](deploy-aws.md#payments)).

Stripe is on when `STRIPE_SECRET_KEY` is set to anything other than empty or the Terraform
placeholder `set-me`. Without `STRIPE_WEBHOOK_SECRET` the API boots with a warning, and every
Stripe webhook is refused with 400, so Stripe top-ups are never credited.

### Flow

The API creates a Checkout Session (`mode=payment`, one line item for the total in USD,
`client_reference_id` and `metadata.topup_id` set to the top-up id, an `Idempotency-Key` of
`topup-<id>`). The browser goes to Stripe and comes back to
`APP_WEB_URL/billing?topup=<id>` (or `&cancelled=1`).

| Event | Effect |
| --- | --- |
| `checkout.session.completed` with `payment_status: paid` | Credit |
| `checkout.session.completed` with another status (a delayed method) | Nothing yet |
| `checkout.session.async_payment_succeeded` | Credit |
| `checkout.session.async_payment_failed` | Top-up `FAILED` (`PAYMENT_FAILED`) |
| `checkout.session.expired` | Top-up `FAILED` (`CHECKOUT_EXPIRED`) |
| Anything else | Recorded and ignored |

The signature (`Stripe-Signature: t=...,v1=...`) is an HMAC-SHA256 of `<t>.<raw body>` with
the signing secret, checked in constant time over the exact bytes, and refused when `t` is more
than 300 seconds from the server clock. During a secret roll Stripe sends several `v1`
values; any match is accepted.

## Razorpay (INR)

### Setup

1. In the Razorpay dashboard, generate an API key: the **key id** (`rzp_live_...` or
   `rzp_test_...`) and **key secret**.
2. Add a webhook:
   - URL: `https://<domain>/api/webhooks/razorpay`
   - A secret of your choice
   - Events: `payment.captured`, `order.paid`, `payment.failed`
3. Set `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET` and `RAZORPAY_WEBHOOK_SECRET`.

Razorpay is on when both the key id and key secret are set (and not `set-me`). Without
`RAZORPAY_WEBHOOK_SECRET` the API boots with a warning and top-ups rely only on the browser's
verify call: a buyer who closes the tab before it runs is not credited until you mark it by
hand.

### Flow

1. The API creates a Razorpay Order for the total in paise (`receipt` and `notes.topup_id`
   are the top-up id) and returns the order id, the amount and the key id.
2. The console loads `https://checkout.razorpay.com/v1/checkout.js` and opens the checkout.
3. On success checkout.js returns `razorpay_order_id`, `razorpay_payment_id` and
   `razorpay_signature`; the console posts them to `POST /api/billing/razorpay/verify`.
4. The API checks the signature (HMAC-SHA256 of `<order_id>|<payment_id>` with the key
   secret), fetches the payment from Razorpay, captures it if it is only authorised, and
   fulfils with the captured amount. A payment not captured yet answers
   `409 PAYMENT_PENDING`.
5. Razorpay's webhook arrives too, in any order.

| Event | Effect |
| --- | --- |
| `payment.captured` (with an order id) | Credit |
| `order.paid` | Credit |
| `payment.failed` (with an order id) | Top-up `FAILED` with Razorpay's error reason, if it is still `CREATED` |
| Anything else | Recorded and ignored |

The webhook signature (`X-Razorpay-Signature`) is an HMAC-SHA256 of the raw body with the
webhook secret. The event id is Razorpay's `X-Razorpay-Event-Id` header (a hash of the signed
body if it is missing).

The console's Content Security Policy and Permissions-Policy already allow Razorpay's checkout
origins ([`apps/web/next.config.ts`](../../apps/web/next.config.ts)).

## Webhook idempotency

Each webhook is recorded by event id in `payment_webhook_events` in the same transaction as
its fulfilment. A repeat delivery is answered 200 and does nothing. If fulfilment throws, the
transaction rolls back, the endpoint answers 500, and the gateway's retry gets another chance.
A bad signature is 400 and is never recorded. Event ids are kept 90 days. The full response
table is in [rest-contract.md](../api/rest-contract.md#webhooks-apiwebhooks).

## The INR rate (FX)

INR top-ups are converted into the USD wallet at the rate locked when the order is created
([`services/fx.service.ts`](../../apps/api/src/services/fx.service.ts)), so a payment that
lands an hour later credits exactly what the buyer was shown. The receipt prints the rate.

| `FX_PROVIDER` | Rate |
| --- | --- |
| `fixed` (the code default) | `FX_FIXED_INR_PER_USD` (default 85) |
| `exchangerate` (the Terraform default) | `open.er-api.com`, no key |
| `openexchangerates` | openexchangerates.org, needs `FX_API_KEY` (without it the fixed rate is used, with a boot warning) |

With a live provider, the worker's `gateway.fx-sync` job fetches the rate every 6 hours and
stores it in `fx_rates`; a rate outside 10 to 1000 is treated as a provider fault and ignored.
The API uses the newest stored rate while it is less than 48 hours old, else
`FX_FIXED_INR_PER_USD`, and caches it for a minute per process. A fetch failure never blocks
a top-up. `FX_API_BASE` overrides the provider's URL. **Settings**, **Integrations** shows the
rate in force, its source and when it was fetched.

Example: a 500 INR top-up at 85 INR per USD credits floor(50 000 x 10 000 / 85) =
5 882 352 micro-USD, 5.882352 USD.

## Tax and limits

In **Settings**, **Top-ups**:

| Setting | Default | Notes |
| --- | --- | --- |
| Tax (`taxBps`) | 0 | Basis points added on top of the amount, 0 to 5000 (50%) |
| Tax label (`taxLabel`) | `Tax` | On receipts, for example `GST` or `VAT` |
| USD minimum and maximum | 5 and 1000 | In dollars |
| INR minimum and maximum | 500 and 100 000 | In rupees |

An amount outside the limits is `400 TOPUP_AMOUNT` with the bounds in `details`.

## Receipts

Every paid (or refunded) top-up has a PDF receipt (`GET /api/billing/topups/{id}/receipt.pdf`,
**Billing**, **Top-ups**): app name, receipt id, date, who it was billed to, the gateway, the
credit, the tax line, the total charged, the locked exchange rate for INR, the USD credited,
"Refunded" when it was, and the support email when one is set.

## Refunds

Refunds have two halves, done in this order:

1. **Return the money in the gateway's dashboard** (Stripe or Razorpay). This platform never calls
   a gateway's refund API, and refund webhooks are not processed.
2. **Mark it refunded in `/admin`**, **Billing**, **Refund** (`POST /api/admin/topups/{id}/refund`
   with a reason). The top-up becomes `REFUNDED` and a negative `REFUND` ledger entry debits
   its full credit. Only `PAID` top-ups can be refunded (`409 TOPUP_NOT_PAID`).

The debit applies even if the credit has been spent, so the balance can go below zero; a
negative balance refuses new requests until it is topped up. For a partial refund, refund in
the gateway's dashboard and book a negative **adjustment** on the account sheet instead.

## Free credit

| Source | How | Ledger type |
| --- | --- | --- |
| Signup credit | Settings `signupCreditMicros` (default 1 USD), booked once when a new account becomes active (on email verification) | `SIGNUP` |
| Promo codes | Admin creates a code with an amount, optional cap and expiry; each account may redeem it once | `PROMO` |
| Grants | Admin, account sheet, **Credit**, type Grant (positive) | `GRANT` |
| Adjustments | Admin, type Adjustment (positive or negative, never zero) | `ADJUSTMENT` |

The admin overview reports top-ups and free credits separately, so revenue from paid credit is
never confused with credit you gave away.

## PAYMENTS_STUB for development

`PAYMENTS_STUB=true` adds a stub gateway for any currency whose real gateway is not configured.
Its checkout is a **Test payment** dialog in the console; confirming calls
`POST /api/billing/topups/{id}/stub-confirm`, which credits the wallet through the same
fulfilment path as a real payment. Receipts say "Test gateway".

Production refuses to boot with it: `assertProductionConfig` reports
"PAYMENTS_STUB=true lets anyone credit their own wallet", because any signed-in user could
top up without paying. With the stub off, the confirm endpoint answers `403 STUB_DISABLED`.

## Testing against the real gateways

Use each gateway's test mode keys (`sk_test_...`, `rzp_test_...`) on a staging deployment
with a public URL, so their webhooks can reach `/api/webhooks/*`. For Stripe on a laptop, the
Stripe CLI can forward events (`stripe listen --forward-to localhost:5056/api/webhooks/stripe`)
and prints the signing secret to use. The integration tests run the real Stripe and Razorpay
clients against the stubs instead ([testing.md](testing.md#how-payments-are-faked)).
