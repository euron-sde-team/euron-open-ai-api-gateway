# ADR 0005: Price = primary route cost x (1 + margin); margin by precedence

## Status

Accepted.

## Context

A model can be served by several routes (providers) with different costs, so the
gateway's cost for a request depends on which route served it, and that is only known
after failover. Operators want a margin on top, from zero (at cost, for partners or
internal teams) upwards, and want to set it per model, per account and per key. In the
system this replaces, margin settings existed but were never applied, and models without
a price were billed at zero.

## Decision

- Each route stores what it costs the platform: micro-USD per million input, output and
  cached-input tokens, or per unit (per image, per million characters of speech, per
  minute of transcription).
- The **list price** of a model is its primary route's cost (the enabled route with the
  lowest priority number) plus the margin. A request is charged the list price **whichever
  route served it**; the request row records the served route's cost separately, so the
  overview shows real gross margin.
- Margin is basis points, 0 and up. The margin in force is the first set value of: the
  key's override, the account's override, the model's override, the deployment default.
- Every multiplication rounds up to the micro-dollar.
- A model can be enabled only while its primary route (the first usable one) is priced
  (`MODEL_UNPRICED` otherwise), and changes that would break that for an enabled model are
  refused.
- Each request row snapshots `price_micros`, `cost_micros` and `margin_bps`.

Code: [`apps/api/src/gateway/pricing.ts`](../../../apps/api/src/gateway/pricing.ts),
[`apps/api/src/services/admin-catalog.service.ts`](../../../apps/api/src/services/admin-catalog.service.ts).

## Consequences

Positive:

- Callers see one stable price per model, not a price that depends on provider health.
- Failover to a cheaper backup raises the margin; to a dearer one lowers it. The overview
  reports both revenue and cost, so this is visible.
- Unpriced models cannot be billed at zero by accident.

Trade-offs:

- A backup route that costs more than the primary can serve requests at a loss. Operators
  should order routes so the primary is the dearest, or price models accordingly.

## Alternatives considered

- **Charge the served route's cost plus margin.** Prices change with failover; callers
  cannot predict a bill.
- **Fixed price per model independent of cost.** Loses the link between provider price
  changes and caller prices.
