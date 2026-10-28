# Walkthrough: the console and the admin

A guided tour for a new operator: what each page of the developer console and the admin
control plane does, and which API it calls. Run the local stack and the demo first
([quickstart-local.md](quickstart-local.md)) so every page has data. The pages live in
[`apps/web/src/components/console`](../../apps/web/src/components/console) and
[`apps/web/src/components/admin/pages`](../../apps/web/src/components/admin/pages); the routes
behind them are in [rest-contract.md](../api/rest-contract.md).

## Signing up

`/signup` creates an account (`POST /api/auth/signup`). Who may sign up is the admin's
**Settings**, **Sign-up** choice: anyone (`OPEN`), only addresses at listed email domains
(`INVITE_ONLY`), or nobody (`CLOSED`; admins create accounts with `make admin`). With email
verification on, the account is created pending and a link is emailed; confirming it signs
the user in and books the **signup credit** (Settings, default 1 USD) on their ledger, once.
Two-factor sign-in, password reset and session management are under **Settings**.

## The developer console

Sign in as `priya.nair@example.com`.

### Overview

Spend, requests, errors and latency across your keys for a date range (UTC days), by day,
by model and by key (`GET /api/usage/summary`). A new account with no traffic sees **Make
your first request**: the base URL and a ready-to-paste snippet.

### Models

Every model you can call, with its price at your account's margin
(`GET /api/catalog`): per million input, cached input and output tokens for chat and
embeddings, per image, per million characters for speech, per minute for transcription. Shown
in US dollars, or in rupees at the current rate. Each entry shows the id and aliases to put in
`model`, context window, max output, and whether it supports tools, vision and JSON mode.

### API keys

Create, edit and revoke keys (`/api/keys`). The secret is shown once, when the key is
created; afterwards only a hint (`gw-AbCd...WxYz`) is visible. Each key can carry:

| Field | Effect |
| --- | --- |
| Allowed models | Only these model ids; empty means every model |
| Monthly budget (USD) | Requests are refused with `402 budget_exceeded` once this calendar month's spend would pass it |
| Expires | After this time the key answers `401 expired_api_key` |
| Requests per minute, tokens per minute | Override the account's tier for this key |
| Allowed IP addresses | IPv4 or IPv6 addresses and CIDRs; empty means anywhere |
| Keep request and response bodies | Opt-in logging for debugging; bodies are kept for the retention set in Settings and only you can read them |

The list shows each key's spend this month and when it was last used. An account may hold 50
active keys. Edits apply to the next request; revoking is permanent.

### Playground

Chat with any chat model through the real gateway, using one of your keys. The key you paste
stays in this browser tab (session storage); the playground calls `/v1/chat/completions`
directly, so a playground message is billed and logged like any other request.

### Usage

The request log (`GET /api/usage/requests`), newest first, filterable by key and status.
Open a row for its detail: model, endpoint, key, attempts, input, cached and output tokens
(or units), the price charged, latency and time to first byte, the status and error code if
any, whether usage was estimated, and the request and response bodies when the key logged them
and they have not expired. Which provider served a request, and what it cost the platform, are
not shown to developers.

### Billing

- **Balance**: the wallet, what is held by requests in flight, and what is available.
- **Top up**: pick USD (Stripe) or INR (Razorpay), see the tax and the exact credit before
  paying (an INR rate is locked when checkout starts), then pay in the gateway's hosted
  checkout. Without a configured gateway the section says top-ups are not available.
- **Promo code**: redeem a code once per account.
- **Ledger**: every change to the balance. Each request is one `Usage` entry; top-ups,
  grants, promo credits, the signup credit, refunds and adjustments are the others.
- **Top-ups**: past orders with their status and a PDF receipt for each paid one.

[payments.md](payments.md) covers the gateway side.

### Docs

The base URL of this deployment, quickstarts in several languages, the endpoints, how billing
works, the error codes and reliability behaviour: the in-app version of
[gateway.md](../api/gateway.md).

### Settings

Your profile, theme, password, two-factor sign-in with recovery codes, where you are signed in
(revoke one session or all), a JSON export of your data, and account deletion (14 days to
change your mind by signing in again).

## The admin control plane

Sign in as `admin@example.com` and open `/admin`. Admins see accounts, money, usage metadata
and configuration; they never see request bodies or provider secrets. Every change is
recorded in the audit log.

### Overview

For a date range (`GET /api/admin/stats`): accounts and active accounts, requests and
errors, **revenue** (what callers were charged), **provider cost** (what the routes that
served those requests cost the platform) and **margin** (the difference), plus top-ups and
free credits booked. Charts by day; tables by model and by provider. A provider's
**failovers** are requests it could not serve that moved to the next route. See
[operations.md](operations.md#reading-the-overview) for how to read the numbers.

### Users

Accounts with status, tier, balance and this month's spend; search by email or name and
filter by status, role and tier. Opening one shows the account sheet:

| Section | What you can do |
| --- | --- |
| Account | Balance, totals, 30 days of spend |
| Credit | Book a **grant** (free credit) or an **adjustment** (positive or negative) with a reason |
| Margin | An account margin, and a margin per key; both override the model and default margins |
| Rate limits | Move the account to a tier |
| Access | Make or remove admin; suspend for 1 to 365 days (keys stop working until it ends); ban (signed out everywhere, keys stop); erase (identity anonymised, keys revoked, bodies deleted, financial records kept) |

Admins cannot be suspended or banned until they are demoted, and the last admin cannot be
demoted or erased.

### Limits

Rate-limit tiers: requests a minute, tokens a minute and requests at once (blank means
unlimited). One tier is the default for accounts without one. A key's own RPM and TPM
override its account's tier.

### Providers

The upstream APIs: kind (OpenAI-compatible, Anthropic, Gemini, stub), base URL, enabled, and
their credentials. A credential's secret is encrypted on arrival and only its label and last
four characters are shown. Several enabled credentials are used in turn.

### Models

The catalogue. Each model has an id, aliases, kind, limits, capability flags, an optional
margin and an on/off switch, and one or more **routes**: a provider, the provider's name for
the model, a priority (lower is tried first), a timeout and the cost. The page shows the
margin in force and the price callers pay. **Test** makes one tiny real call through a route.
[providers.md](providers.md) explains every field.

### Health

Every route with its circuit (closed, open or half-open), its success rate and median
latency over 24 hours, and the latest probes. Refreshes every 30 seconds. Force a route's
circuit **open** to take it out of rotation, or **closed** to clear a trip.

### Billing

Every top-up across accounts, with **Refund** on paid ones (marks it refunded and debits the
credit; the money goes back in the gateway's dashboard). Promo codes: create one with an
amount, an optional cap and expiry, and turn codes off.

### Settings

| Section | Holds |
| --- | --- |
| General | Product name, tagline, support email, the gateway base URL shown to developers, the minimum supported app version |
| Sign-up | Who can create an account, allowed email domains, the signup credit |
| Pricing | The default margin |
| Top-ups | Tax (rate and label), the USD and INR minimum and maximum, the low-balance email threshold |
| Data | Body retention, request log retention |
| Integrations | Read-only: mail mode, which payment gateways are on, the FX rate and its source, whether `CREDENTIALS_KEY` is set |

Every key is listed in [configuration.md](configuration.md#admin-settings-in-the-database).

### Audit log

Every admin action, account event and job that changed data, newest first, filterable by
action prefix, person and item.
