# Rate limits

Code: [`apps/api/src/gateway/limits.ts`](../../apps/api/src/gateway/limits.ts).

| Limit | Scope | Window | Counted |
| --- | --- | --- | --- |
| RPM | per key | one minute, sliding (two fixed windows, the previous one weighted by what remains of it) | one per request at admission |
| TPM | per key | same | the estimated input plus maximum output at admission; corrected upward with the actual tokens after settlement |
| Concurrency | per account | requests in flight | a slot taken at admission and returned when the request ends (with a 15 minute safety expiry) |

## Where the numbers come from

For each limit, the first that is set of: the key's own value (RPM and TPM), the
account's tier, the default tier. A null value means unlimited. Tiers are edited in
`/admin/tiers`; exactly one is the default (60 RPM, 200 000 TPM, 8 concurrent on a fresh
install).

## Answers

`429` with `retry-after` (seconds to the next window, 1 for concurrency) and the code
`rate_limit_exceeded` (RPM), `tokens_rate_limit_exceeded` (TPM) or
`concurrency_limit_exceeded`. Nothing is reserved or charged.

## Properties

- Every check-and-count is one Lua script, so parallel requests cannot all slip through.
- Limits are shared by every API process through Redis.
- If Redis is unreachable the limits fail open and the error is logged; the wallet
  reservation still bounds spend.
- A key's monthly budget is not a rate limit: it is checked before the limits against a
  monthly spend counter ([data-plane.md](data-plane.md)).

## The console

The console API has its own per-route limits (sign-in, key creation, top-ups, promo
redemption, admin actions) keyed by user or IP, configured with `RATE_LIMITS`, with an
in-memory fallback during a Redis outage.
