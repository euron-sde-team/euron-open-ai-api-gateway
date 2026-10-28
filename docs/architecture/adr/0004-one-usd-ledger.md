# ADR 0004: One USD ledger; INR top-ups converted at a rate locked per order

## Status

Accepted.

## Context

Providers bill in US dollars. Buyers pay in US dollars (Stripe) or Indian rupees
(Razorpay: UPI, cards, netbanking). Keeping a balance per currency means pricing every
model twice and choosing which balance a request draws from. Converting at the current
rate when a payment lands (what the replaced system did) credits a different amount than
the buyer was shown when the rate moves between checkout and payment.

## Decision

- Every account has one balance, in micro-USD. Every price is in USD.
- A rupee top-up is converted into USD **at the rate in force when the order is created**.
  The rate (`fx_inr_per_usd`), the amount, the tax and the resulting credit are stored on
  the `topups` row and shown to the buyer before they pay; fulfilment credits exactly that,
  whenever the payment arrives. The conversion rounds down to the micro-dollar.
- The rate comes from the newest `fx_rates` row (fetched every six hours by the
  `gateway.fx-sync` job from open.er-api.com or Open Exchange Rates) when it is less than
  two days old, else `FX_FIXED_INR_PER_USD`. A failed fetch never blocks a top-up.
- The console shows rupee equivalents (balance, catalogue prices) for display only.
- Tax, when configured, is added on top of the amount and never credited.

Code: [`apps/api/src/services/billing.service.ts`](../../../apps/api/src/services/billing.service.ts),
[`apps/api/src/services/fx.service.ts`](../../../apps/api/src/services/fx.service.ts).

## Consequences

Positive:

- One price list, one balance, one ledger; pricing and margins have one meaning.
- A buyer is credited exactly what the checkout said (`billing.int.test.ts` moves the
  rate between order and payment and checks the credit did not move).

Trade-offs:

- Rupee buyers carry the exchange-rate risk between top-up and spend, as with any
  dollar-priced service.
- A refund debits the dollars that were credited, not a rupee amount at today's rate.

## Alternatives considered

- **A balance per currency.** Two price lists and a choice on every request.
- **Convert at payment time.** Credits differ from what the buyer saw.
