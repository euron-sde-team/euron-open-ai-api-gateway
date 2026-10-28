# Threat model

A STRIDE pass over the gateway: what is worth stealing or abusing, where trust changes,
what stops each threat, and what is left. The controls themselves are in
[security.md](security.md).

## Assets

| Asset | Why it matters |
| --- | --- |
| Account balances and the ledger | Real money; a bug or abuse here is a direct loss |
| Provider credentials | Each one can spend the operator's provider account without limit |
| API keys | Each one spends its owner's balance |
| Request bodies (when kept) | May contain customers' prompts and data |
| The catalogue and prices | A wrong price or margin bills every caller wrongly |
| Accounts and sessions | Control of keys, balance and top-ups |
| Payment webhooks | The path by which money is created |

## Trust boundaries

1. **Caller to `/v1`**: anyone on the internet with or without a key.
2. **Browser to the console API**: a signed-in user, or an admin.
3. **Gateway to providers**: the operator's credentials leave the system; provider answers
   come back untrusted.
4. **Payment gateways to webhooks**: unauthenticated HTTP that must prove itself by
   signature.
5. **API to Postgres and Redis**: trusted, inside private subnets.

## STRIDE

| Threat | Example | Mitigation |
| --- | --- | --- |
| **Spoofing** | Using a guessed or leaked key | 238-bit keys; HMAC lookup; per-key IP allow-list, model allow-list, expiry, budget; instant revocation (cache dropped) |
| | Forging a webhook to credit a wallet | Signature over the raw body before parsing; Stripe timestamp tolerance; amount and currency checked against the stored order; event ids deduped |
| | Forging a Razorpay success in the browser | Signature verified with the key secret, then the payment fetched from Razorpay and its captured amount compared |
| **Tampering** | Sending a margin, credit or another user's id in a body | Strict schemas refuse unknown fields; ownership in every `WHERE` |
| | Changing the price of a request after the fact | Price, cost and margin snapshotted on the request row; ledger append-only |
| **Repudiation** | An admin grants credit or refunds and denies it | Audit log with actor, reason, before and after |
| **Information disclosure** | Reading provider keys from the admin UI or a dump | Never returned; encrypted at rest with a key outside the database |
| | Reading another account's usage or bodies | 404 for other owners; admins never get bodies; bodies opt-in with short retention |
| | Provider error bodies echoing secrets to callers | Upstream errors are logged masked and answered generically |
| **Denial of service** | Flooding `/v1` | RPM, TPM and concurrency limits per key, tier and account; body size limits |
| | Spending past a balance with parallel requests | Worst-case reservation in one conditional update |
| | A failing provider slowing every request | Route timeouts, circuit breaker, failover, health probes |
| **Elevation of privilege** | A user reaching admin routes | `requireAdmin` in every admin service; role change bumps the token version |
| | A suspended account still spending through its keys | Key contexts carry the account status and are dropped on every status change |

## Residual risks

### Overshoot on estimates and budgets

The reservation uses an estimate. A provider that counts many more tokens than the
estimate can push a balance slightly negative; new requests are then refused. A key's
monthly budget is checked against a counter updated after settlement, so requests already
in flight when the budget is reached can overshoot it.

### Redis outage

Rate limits, budgets and circuit state fail open while Redis is unreachable. Spend stays
bounded by the wallet reservation in Postgres.

### Backup routes that cost more

The caller pays the primary route's price. If an operator orders routes so a dearer
provider is the backup, failover serves at a loss. The overview shows cost next to revenue.

### Compromised `CREDENTIALS_KEY` with a database dump

Together they reveal every provider credential. Keep the key in the secrets manager,
rotate provider keys after any suspected leak, and restrict who can read both.

### Prompt content

The gateway does not inspect prompts or completions. Abuse of the providers' terms by a
caller is the operator's to police (suspend or ban the account; every request is logged
with its key and IP).

### Payment disputes

A chargeback after credit has been spent is a loss the gateway cannot prevent; refunds
through `/admin` debit what remains and may leave a negative balance.
