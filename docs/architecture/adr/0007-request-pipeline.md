# ADR 0007: One request pipeline, in a fixed order, cheapest checks first

## Status

Accepted.

## Context

Every data-plane request must be authenticated, checked against key controls and limits,
priced, paid for and logged, across several endpoints and two formats. Doing this per
endpoint drifts; doing it in the wrong order lets an unauthenticated or over-limit request
cost a database write or, worse, a provider call.

## Decision

Every `/v1` endpoint builds a `CallSpec` (how to estimate the call and how to execute it
on one route) and hands it to one function, `runCall`, which does, in order:

1. Authenticate the key (hash, Redis-cached context, key and account status, expiry).
2. Resolve the model by id or alias; check its kind fits the endpoint.
3. Key controls: model allow-list, IP allow-list.
4. Price: margin by precedence, list price, worst-case price.
5. Monthly key budget (Redis counter, seeded from the requests table).
6. Rate limits: RPM and TPM per key, concurrency per account (Redis, Lua).
7. Reserve the worst case in the wallet (402 if it does not fit).
8. Try routes in priority order, skipping open circuits; fail over on retryable errors
   (connection, timeout, 408/409/425/429/5xx) only while nothing has been sent to the
   caller.
9. Settle in one transaction with the request row (and bodies, when the key logs them).

Failures before step 8 cost nothing and touch no provider. Failures in step 8 release the
hold and record a failed request row with no charge.

Code: [`apps/api/src/gateway/pipeline.ts`](../../../apps/api/src/gateway/pipeline.ts).

## Consequences

Positive:

- One place to read, test and change the order of checks.
- New endpoints are a `CallSpec`, not a copy of the checks.

Trade-offs:

- Budget and rate-limit counters are in Redis; if Redis is down they fail open and the
  wallet reservation alone bounds spend.
- The monthly budget check uses a counter updated after settlement, so a burst of parallel
  requests can overshoot a key's budget by the requests already in flight.

## Alternatives considered

- **Express middleware per concern.** Order is implicit and the estimate is needed by
  several steps.
