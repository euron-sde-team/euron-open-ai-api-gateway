# Pricing and margins

Decision: [ADR 0005](adr/0005-pricing-primary-route-and-margin.md). Code:
[`apps/api/src/gateway/pricing.ts`](../../apps/api/src/gateway/pricing.ts).

## Cost

Each route stores what one call costs the platform:

| Model kind | Cost fields used |
| --- | --- |
| CHAT | `input_micros_per_mtok`, `output_micros_per_mtok`, optional `cached_micros_per_mtok` (falls back to the input price) |
| EMBEDDING | `input_micros_per_mtok` |
| IMAGE | `unit_micros` per image |
| SPEECH | `unit_micros` per million characters |
| TRANSCRIPTION | `unit_micros` per minute |

A route is **priced** when the field its model bills on is above zero. A model can be
enabled only while its **primary** route (the first usable route by priority: route and
provider enabled, a credential enabled unless it is the stub) is priced; otherwise
`409 MODEL_UNPRICED`. A free primary in front of a priced backup is refused too.

## Margin

Basis points, 0 and up (0 is "at cost", 2 000 is 20 %, 10 000 doubles the cost). The
margin in force for a request is the first that is set of:

1. the key's margin (set by an admin on the user panel),
2. the account's margin,
3. the model's margin,
4. the deployment default (`defaultMarginBps` in Settings, 0 by default).

## Price

```
price per unit = ceil(cost per unit x (10 000 + margin) / 10 000)
charge         = ceil(sum over billed quantities of quantity x price per unit / 1 000 000)   (tokens, speech)
               = price per unit x quantity                                                    (images, minutes)
```

The cost per unit is the **primary route's** (the enabled route with the lowest priority
number), whichever route served the request. The served route's own cost is computed the
same way at margin zero and stored as `cost_micros`, next to `price_micros` and
`margin_bps`, on every request row. Revenue minus cost is the gross margin on the admin
overview.

## Example

`stub-chat`: input $0.50, output $1.50 per million tokens; default margin 20 %.

| | Input | Output |
| --- | --- | --- |
| Cost per million | 500 000 | 1 500 000 |
| Price per million | 600 000 | 1 800 000 |
| A request with 1 200 input and 300 output tokens | | |
| Charge | ceil((1 200 x 600 000 + 300 x 1 800 000) / 1 000 000) = 1 260 micro-USD ($0.00126) | |
| Cost | ceil((1 200 x 500 000 + 300 x 1 500 000) / 1 000 000) = 1 050 micro-USD | |

## What callers see

- `GET /api/catalog` signed out: list prices at the model margin or default.
- Signed in: prices at the account's margin (a key override is not reflected there).
- The console's Models page shows the same in USD or INR (display only).
- Each request's exact price is on the Usage page and in the ledger.
