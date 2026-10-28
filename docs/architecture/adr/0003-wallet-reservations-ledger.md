# ADR 0003: Reserve before calling, settle after, one append-only ledger

## Status

Accepted.

## Context

A gateway pays providers for every call and charges its callers afterwards. Two things
go wrong in naive designs, and both appeared in the system this project replaces: a
wallet check of "balance above zero" lets any number of parallel requests start, so an
account can spend far past its balance; and debits written after the call, outside a
transaction and capped at the balance, silently lose money when the call costs more than
what is left. Credits have the opposite problem: a webhook and a browser callback for the
same payment can both credit it.

## Decision

- Money is integer micro-USD (`bigint`), everywhere, end to end. No floats.
- One `wallets` row per account holds `balance_micros` and `reserved_micros`.
- Before calling a provider the gateway **reserves** the worst-case price of the request
  (the estimated input plus the request's maximum output, at the caller's price) with one
  conditional update: `UPDATE wallets SET reserved = reserved + x WHERE balance - reserved >= x`.
  If no row matches, the request is refused with 402 before any provider sees it.
- After the call it **settles**: in one transaction it debits the actual price, drops the
  hold, inserts the `requests` row and books one `USAGE` ledger row with the balance after
  it. If the call failed before anything billable happened it **releases** the hold.
- A hold that is neither settled nor released (a process died mid-call) expires after 15
  minutes and the sweeper job releases it.
- Every change to a balance is one `ledger` row (`TOPUP`, `GRANT`, `PROMO`, `SIGNUP`,
  `USAGE`, `REFUND`, `ADJUSTMENT`), never updated or deleted. A unique index on
  `(ref_type, ref_id, type)` makes every credit and debit happen at most once for its
  reference (a top-up id, a request id, a promo redemption), so retries and races are
  harmless.

Code: [`apps/api/src/billing/wallet.ts`](../../../apps/api/src/billing/wallet.ts),
[`apps/api/src/gateway/pipeline.ts`](../../../apps/api/src/gateway/pipeline.ts).

## Consequences

Positive:

- Parallel requests cannot spend past the balance (`gateway.int.test.ts` fires six at once
  against a balance that covers two).
- The ledger explains every balance: the sum of an account's entries is its balance.
- Webhook and verify racing for one payment credit once (`billing.int.test.ts`).

Trade-offs:

- The worst case is pessimistic: a request with a large `max_tokens` holds more than it
  will cost, so an account near zero is refused requests it could have afforded. Callers
  control this with `max_tokens`.
- When an estimate runs low (a provider counts input tokens differently), the actual price
  is still charged in full and the balance may dip slightly below zero. New requests are
  then refused until the account tops up. This is preferred to losing the difference.
- Settlement happens just after the response is written, so the usage row appears a few
  milliseconds after the caller has its answer.

## Alternatives considered

- **Debit after the call only.** Unbounded spend under concurrency.
- **A Redis balance.** Fast, but not durable or auditable; the ledger must be in Postgres.
- **Pre-paid "credits" per model.** Simpler to explain, worse when prices change.
