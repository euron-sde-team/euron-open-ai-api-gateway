# Operations

Running a deployment day to day: background jobs, provider health, the money numbers,
refunds and credits, accounts, secrets, backups and retention. The admin pages are toured in
[walkthrough.md](walkthrough.md); failure diagnosis is in
[troubleshooting.md](troubleshooting.md).

## Jobs and schedules

The worker (`node dist/worker.js`, same image as the API) runs BullMQ jobs on two queues and
registers these schedules on boot ([`worker.ts`](../../apps/api/src/worker.ts),
[`jobs/`](../../apps/api/src/jobs)). Repeatable jobs are keyed by name and interval, so every
worker task registering them leaves one schedule. Every handler is safe to run twice or on two
workers at once.

| Job | Every | Does |
| --- | --- | --- |
| `gateway.sweep-reservations` | 1 minute | Releases wallet holds older than 15 minutes whose request never settled (a process died mid-call) |
| `gateway.health-probes` | 5 minutes | `GET {base}/models` with the credential, for every usable route of an enabled model, 8 at a time; records a health check and feeds the circuit breaker |
| `gateway.fx-sync` | 6 hours | Fetches the INR per USD rate (does nothing with `FX_PROVIDER=fixed`) |
| `gateway.low-balance` | 10 minutes | Emails ACTIVE accounts that have made requests and whose available balance is below `lowBalanceMicros`, once; again only after a credit |
| `maintenance.lift-suspensions` | 5 minutes | Timed suspensions that have run out become ACTIVE |
| `maintenance.purge-accounts` | 6 hours | Erases accounts whose deletion request is 14 days old |
| `maintenance.retention` | 6 hours | Deletes expired request bodies, request rows past `requestRetentionDays`, health checks older than 14 days, webhook event ids older than 90 days |

If the worker is down, nothing on the request path breaks: holds wait to be swept (the
available balance looks lower meanwhile), probes stop, the FX rate ages out to the fixed one
after 48 hours, and suspensions are not lifted on time.

## Health and circuits

**Health** (`/admin/health`) lists every route with its circuit, its 24-hour success rate and
median latency from real traffic, and its last probes. The circuit breaker
([`gateway/breaker.ts`](../../apps/api/src/gateway/breaker.ts)) lives in Redis, shared by every
API task:

| State | Meaning | Leaves it when |
| --- | --- | --- |
| closed | In use. Retryable failures (connection errors, timeouts, 429, 5xx) and provider 401 or 403 answers are counted in a one-minute window | 5 failures in the window: open |
| open | Skipped; requests fail over to the next route | After 30 s: half-open |
| half-open | One request (or probe) at a time may try it | Success: closed. Failure: open for another 30 s |

Forcing a circuit:

- **Open** takes the route out of rotation until you clear it, for example while a provider
  has an incident or before deleting a credential. Requests use the model's other routes; a
  model whose only route is forced open answers `503 no_route_available`.
- **Closed** clears a trip and any override.

Probes and the **Test** button write to the same health-check history. A route failing with
"The provider refused the credential (401)" needs a new credential; "does not know this model
or endpoint (404)" usually means a wrong upstream model name or base URL.

## Reading the overview

`/admin` (`GET /api/admin/stats`) for a date range of UTC days:

| Number | Source | Meaning |
| --- | --- | --- |
| Revenue | Sum of `requests.price_micros` | What callers were charged for requests in the range |
| Provider cost | Sum of `requests.cost_micros` | What those requests cost at the cost of the route that **served** each one |
| Margin | Revenue minus cost | Your gross margin on traffic |
| Top-ups | `TOPUP` ledger entries | Paid money booked in the range (cash in, not revenue) |
| Free credits | `GRANT`, `PROMO`, `SIGNUP` entries | Credit you gave away |
| Failovers (per provider) | Requests with more than one attempt | Requests that moved past a failing route, counted against the provider that finally served them |

Things to know when reading it:

- Callers pay the primary route's price; cost is the serving route's cost. Heavy failover to a
  more expensive backup shows up as a lower margin, not a higher price.
- Revenue counts requests, top-ups count cash. Spending free credit produces revenue with no
  cash behind it; compare revenue with top-ups and free credits.
- Requests billed on estimates (cut streams, providers without usage) are in revenue and cost
  at the estimate. The request log flags them.
- Provider cost is what your routes say the provider charges. Reconcile it against the
  provider's invoice now and then, and fix route costs that drifted.
- Refunds and adjustments are not subtracted from revenue; they are ledger entries on the
  account.

## Refunds

1. Refund the payment in the Stripe or Razorpay dashboard. The platform does not call a
   gateway's refund API.
2. In `/admin`, **Billing**, find the top-up and press **Refund** with a reason. It becomes
   `REFUNDED` and a `REFUND` entry debits its full credit; the balance can go negative, which
   blocks new requests until topped up.

For a partial refund, refund the part in the gateway and book a negative **adjustment** on the
account sheet. Details: [payments.md](payments.md#refunds).

## Promo codes and grants

**Billing**, **Promo codes**: a code (3 to 40 letters, digits, `-` or `_`), a credit in USD,
an optional maximum number of redemptions and an expiry. Each account can redeem a code once.
Turning a code off stops new redemptions; it cannot be edited or deleted, so make a new one.

For one account, use the account sheet's **Credit**: a **grant** (positive, free credit) or an
**adjustment** (positive or negative, for corrections). Both need a reason and are audited.

## Tiers

**Limits** holds rate-limit tiers: requests a minute, tokens a minute and requests at once,
each blank for unlimited. One tier is the default (the migration seeds `Default`: 60, 200 000,
8). Put an account on a tier from its account sheet; it applies on the next request. A key's
own RPM and TPM override the tier; concurrency is per account and comes from the tier only.
Deleting a tier moves its accounts to the default; the default cannot be deleted.

## Suspending, banning and erasing

| Action | Console | API keys |
| --- | --- | --- |
| Suspend (1 to 365 days) | Can sign in and read; writes answer `403 ACCOUNT_RESTRICTED` | Stop at once: `403 account_restricted`. Lifted by the job within 5 minutes after the end date (a key's cached context may take up to a minute more) |
| Unsuspend | Normal | Work again on the next request |
| Ban | Signed out everywhere; cannot sign in | Stop at once |
| Unban | Can sign in again | Work again |
| Erase | Identity anonymised | Revoked permanently; logged bodies deleted. Ledger, top-ups and request metadata are kept |

Keys are not revoked by a suspension or ban; they stop because the gateway checks the
account's status on every request (from a key cache that every status change clears). Admins
must be demoted before they can be suspended or banned.

## Credential rotation

To rotate a provider key without downtime:

1. Create the new key at the provider.
2. `/admin`, **Providers**: add it as a new credential. Enabled credentials are used round
   robin, so both now serve.
3. Disable the old credential, watch Health and the request log, then delete it.
4. Revoke the old key at the provider.

Changes reach every API task within the catalogue cache's 5 seconds.

## CREDENTIALS_KEY rotation

`CREDENTIALS_KEY` encrypts every stored provider credential. There is no re-encryption tool.
If the key changes (a new value in `<name_prefix>/gateway`, or a new deployment without the
old value):

- Every credential that no longer decrypts is skipped and logged; nothing crashes.
- A route whose provider has no decryptable credential is unusable, and a model with no usable
  route disappears from the catalogue: callers get `404 model_not_found`, not a 5xx.
- The admin pages still list the credentials (label and last four), and the `MODEL_UNPRICED`
  check still counts them as enabled.

To rotate deliberately: set the new key, roll the API and worker, then delete and re-add every
provider credential in `/admin`. Plan it as an outage of the affected models, or keep the old
key.

## Rotating other secrets

| Secret | How | Effect |
| --- | --- | --- |
| `JWT_SECRET` | New value in `<name_prefix>/app`, roll api and worker | Every access token is invalid; the console refreshes silently |
| `REFRESH_SECRET` | Same | Everyone is signed out |
| `TOTP_ENCRYPTION_KEY` | Do not rotate casually | Every enrolled authenticator stops working; users need recovery codes |
| `API_KEY_PEPPER` | Do not rotate casually | Every issued API key stops working; developers must create new keys |
| Stripe, Razorpay, FX keys | New JSON in `<name_prefix>/billing`, roll api and worker | Rotate at the gateway first. Stripe accepts several signing secrets during a roll |
| Database password | RDS rotates the managed secret | New connections read the new password (cached 60 s) |

## Retention

| Data | Kept | Setting |
| --- | --- | --- |
| Request and response bodies (opt-in keys only) | `bodyRetentionDays` (default 7) | Settings, **Data** |
| Request log rows | Forever, or `requestRetentionDays` (30 to 3650) | Settings, **Data** |
| Health checks | 14 days | Fixed |
| Webhook event ids | 90 days | Fixed |
| Ledger, top-ups, wallets | Forever | The financial record |
| Audit log | Forever | |

The retention job deletes in batches of 1000. Deleting request rows does not change balances
(the ledger holds the money), but it does shorten usage history and the admin overview's
reach.

## Audit trail

`audit_log` records admin actions (roles, suspend and ban, erase, tiers, margins, credits,
providers, credentials, models, routes, circuits, refunds, promo codes, settings with before
and after), account events (sign-up, sign-in, verification, two-factor, export, deletion),
key creation, edits and revocation, top-ups created and paid, and the jobs that change
accounts or data (`user.suspension_lifted`, `user.purged`, `retention.applied`). Read it at
`/admin/audit` (`GET /api/admin/audit?action=<prefix>`).

## Backups and restore

| Store | Backup |
| --- | --- |
| Postgres (RDS) | Automated snapshots: 3 days in `aws-dev`, 14 days in `aws-prod` (`db_backup_retention_days`), point-in-time restore inside that window. This is the money: wallets, ledger, top-ups, reservations, the catalogue and the encrypted credentials |
| Redis | Snapshots (1 day `aws-dev`, 7 days `aws-prod`). Nothing durable lives only in Redis: rate-limit windows and circuits reset, the key cache refills, the monthly key spend counter is rebuilt from the request log, and the workers register their schedules again |
| `<name_prefix>/gateway` | Not optional: without the same `CREDENTIALS_KEY` and `API_KEY_PEPPER`, a restored database has undecryptable credentials and dead API keys |

To restore, create an RDS instance from a snapshot and point the deployment at it (or restore
in place under the same identifier), with the same `<name_prefix>/gateway` secret.

## Migrations

[`db/migrate.ts`](../../db/migrate.ts) applies `db/migrations/*.sql` in order, forward-only,
checksummed, under a Postgres advisory lock. Locally it runs as the compose `migrate`
one-shot; on AWS as the migrate task (`make aws-migrate`, and step 4 of `make aws-deploy`).
Never edit an applied migration: the runner refuses to start when a checksum changes.

## Least-privilege database role

By default the api and worker connect as the RDS master user. To give them a role that can read
and write data but not change the schema:

1. After the first deploy, connect as the master user and create a login role with `CONNECT`
   on the database, `USAGE` on schema `public`, `SELECT, INSERT, UPDATE, DELETE` on all
   tables, and default privileges so tables created by later migrations (run as the master
   user) are granted too.
2. Store `{"username": "...", "password": "..."}` in a Secrets Manager secret encrypted with
   the deployment's KMS key.
3. Set `app_db_secret_arn` and `app_db_username` in `terraform.tfvars` and run
   `make aws-deploy`.

The migrate and admin tasks keep the master user, because migrations need DDL.

## Scaling

| Component | How it scales | What makes that safe |
| --- | --- | --- |
| API tasks | Horizontally on CPU | Reservations are conditional updates in Postgres; rate limits, circuits and key spend in Redis; the catalogue and settings cached 5 s per process. No stickiness |
| Worker tasks | Horizontally | BullMQ locks jobs; handlers are idempotent |
| Web tasks | Horizontally | Stateless |
| Postgres | Vertically, storage autoscaling | Every request writes one request row and one ledger row in one transaction. Keep `DB_POOL_MAX` times the tasks under the connection ceiling |
| Redis | Vertically; `aws-prod` runs two nodes with failover | Several small commands per request (key cache, limits, breaker, spend counter) |

Long streams hold an API connection and a concurrency slot for their whole duration; size API
tasks for concurrent streams, not just requests per second.

## Failure modes

| Failure | Effect | Recovery |
| --- | --- | --- |
| A provider down | Its routes fail and their circuits open; requests fail over to other routes, or get `502`/`503` if there are none | Add a second route for important models; force the circuit open during long incidents |
| A credential revoked at the provider | `502 upstream_error` (401 or 403), the circuit opens | Replace the credential |
| Postgres down | `/api/ready` 503; tasks leave rotation | RDS failover (`aws-prod` Multi-AZ) |
| Redis down | `/api/ready` fails; `/v1` rate limits fail open, circuits read as closed, the key cache misses go to Postgres; jobs cannot be enqueued | ElastiCache failover in `aws-prod` |
| Worker down | See [Jobs and schedules](#jobs-and-schedules) | Jobs run again when a worker returns |
| An API task dies mid-request | Its streams end; holds stay until swept (about 16 minutes) | Automatic |
| Payment webhooks failing | Top-ups stay `CREATED`; Razorpay still credits through the browser verify | Fix the secret or URL; the gateway retries deliveries ([troubleshooting.md](troubleshooting.md)) |
| Bad image deployed | Circuit breaker rolls back | Redeploy a previous tag |
