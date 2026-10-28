# Quickstart: run the gateway locally

Start the whole stack on your machine, seed demo accounts, and send your first request
through the gateway to a local stub model. No cloud account, no provider key and no payment
account are needed.

What runs ([`deploy/compose`](../../deploy/compose)): Postgres 16, Redis 7, Mailpit (catches
every email), the Floci AWS emulator provisioned by the production Terraform modules, the
stubs ([`apps/stubs`](../../apps/stubs/server.mjs): deterministic stand-ins for the model
providers, Stripe and Razorpay), then a one-shot `migrate`, the `api`, the `worker` and the
`web` app.

## Prerequisites

- Docker with Compose v2 (Docker Desktop, OrbStack, Colima or plain Docker Engine).
- `make`, `bash` and `openssl`.
- For the tests and the pnpm path: Node 22 (`.nvmrc`) and pnpm 9 (`corepack enable`), then
  `pnpm install`.

## Start the stack

```bash
git clone <your fork of this repository> open-gateway
cd open-gateway
make env      # optional: make up runs it too
make up
```

`make env` writes `deploy/compose/.env` with random, local-only secrets and the demo
password, and never overwrites a value ([`scripts/gen-local-env.sh`](../../scripts/gen-local-env.sh)).
`make up` builds the images, provisions Floci, runs the migration and waits until every
service is healthy. The first build takes a few minutes. It prints:

```
  app      http://localhost:3560
  api      http://localhost:5056/api/ready
  mail     http://localhost:8076
  ses      http://localhost:4627  (Floci)
  stubs    http://localhost:5149
```

`curl -s localhost:5056/api/ready` answers `{"ok":true}` once Postgres and Redis respond.

On first boot against an empty database the API creates the starter catalogue
([`demo/catalog.ts`](../../apps/api/src/demo/catalog.ts)): OpenAI, Anthropic, Gemini and
Groq with a few models each, all **disabled** until an admin adds a key, plus (outside
production) the local stub providers with enabled models for every endpoint.

## Ports

Every host port binds to `127.0.0.1` and can be moved in `deploy/compose/.env`:

| Service | Host port | Variable |
| --- | --- | --- |
| Web app (and its `/api` and `/v1` proxy) | 3560 | `GW_WEB_PORT` |
| API | 5056 | `GW_API_PORT` |
| Postgres | 5522 | `GW_PG_PORT` |
| Redis | 6459 | `GW_REDIS_PORT` |
| Mailpit web UI / SMTP | 8076 / 1076 | `GW_MAILPIT_PORT` / `GW_SMTP_PORT` |
| Floci | 4627 | `GW_FLOCI_PORT` |
| Stubs | 5149 | `GW_STUB_PORT` |

The web app's Next server proxies `/api/*` and `/v1/*` to the API, so the browser sees one
origin, as behind the load balancer on AWS. The API port is published for curl and SDKs.

## Seed the demo

```bash
make demo
```

This runs `node dist/cli.js demo:seed` inside the API container
([`demo/seed.ts`](../../apps/api/src/demo/seed.ts)) with the password from
`GW_DEMO_PASSWORD`. It creates:

- the starter catalogue with the stubs, if not there yet, and a 20% default margin;
- an admin and four developers, each with a signup credit, top-ups, a `Production` and a
  `Staging` key (Staging limited to `stub-chat` and `stub-embed` with a 5 USD monthly
  budget) and thirty days of traffic, so the dashboards have data;
- Leo on a 5% partner margin, Sam on a `Scale` tier (600 RPM, 2 000 000 TPM, 32
  concurrent), the promo code `LAUNCH10` (10 USD), and a failed and a refunded top-up.

| Account | Email | Role |
| --- | --- | --- |
| Morgan Ellis | `admin@example.com` | ADMIN, opens `/admin` |
| Priya Nair | `priya.nair@example.com` | USER, the main demo account |
| Leo Marquez | `leo.marquez@example.com` | USER, partner margin |
| Sam Kowalski | `sam.kowalski@example.com` | USER, `Scale` tier |
| Amara Okafor | `amara.okafor@example.com` | USER |

Every account signs in with the password `make demo` prints. It also prints Priya's
`Production` API key, **once** (only its hash is stored). If the demo was already seeded it
prints the logins only; create a new key in the console instead. The seed refuses to run
with `NODE_ENV=production`.

## Your first request

```bash
export GW_KEY=gw-...   # the key make demo printed

curl -s http://localhost:5056/v1/chat/completions \
  -H "Authorization: Bearer $GW_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model": "stub-chat", "messages": [{"role": "user", "content": "Hello"}]}'
```

The stub answers `Stub reply to: Hello` with exact usage. The same request works through the
web proxy at `http://localhost:3560/v1`. Try the other stub models:

| Model | Shows |
| --- | --- |
| `stub-chat` (alias `stub`) | OpenAI-format chat, streaming and not |
| `stub-claude` | A model served in the Anthropic format: call it on `/v1/chat/completions` and it is translated; call it on `/v1/messages` and it passes through |
| `stub-failover` | The primary route answers 503 and the second route serves: failover |
| `stub-embed`, `stub-image`, `stub-tts`, `stub-whisper` | Embeddings, images, speech, transcription |

```bash
# Streaming, with the usage chunk
curl -sN http://localhost:5056/v1/chat/completions -H "Authorization: Bearer $GW_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"stub","stream":true,"stream_options":{"include_usage":true},"messages":[{"role":"user","content":"Hi"}]}'

# The Anthropic format, with the Anthropic auth header
curl -s http://localhost:5056/v1/messages -H "x-api-key: $GW_KEY" -H "Content-Type: application/json" \
  -d '{"model":"stub-claude","max_tokens":128,"messages":[{"role":"user","content":"Hi"}]}'

# What the key may call
curl -s http://localhost:5056/v1/models -H "Authorization: Bearer $GW_KEY"
```

Putting `STUB_CUT` in the last user message makes the stub end a stream half way without
usage, so you can see an interrupted stream billed on the estimate. Every request the API
sent to the stubs is at `GET http://localhost:5149/__/requests`. The full endpoint reference
is [gateway.md](../api/gateway.md).

## The console and the admin

Open http://localhost:3560 and sign in as Priya. The console has **Overview** (spend and
traffic, and a first-request snippet), **Models** (prices), **API keys**, **Playground**,
**Usage** (the request log), **Billing** (wallet, top-ups, promo codes, ledger), **Docs** and
**Settings**. Your request from curl is the newest row in **Usage**.

Sign in as `admin@example.com` and open `/admin`: overview (revenue, provider cost and
margin), users, limits (tiers), providers, models, health, billing (top-ups and promo codes),
settings and the audit log. [walkthrough.md](walkthrough.md) tours every page.

Every email the stack sends (verification, password reset, low balance, the admin
set-password link) is at http://localhost:8076.

## Top-ups without a payment account

With `PAYMENTS_STUB=true` (development and tests only; production refuses to boot with it),
a currency that has no real gateway configured is paid through a stub: **Billing**, **Top
up** opens a **Test payment** dialog that credits the wallet when you confirm. See
[payments.md](payments.md) for setting up real Stripe and Razorpay accounts, including their
test modes.

## Add a real provider

1. Sign in as the admin and open **Providers**. Pick `openai` (or `anthropic`, `gemini`,
   `groq`), add a credential with your provider key. It is encrypted on arrival and never
   shown again.
2. Open **Models**, check a model's route cost against the provider's current price list,
   press **Test** on the route, then turn the model on.

The model is callable at once with any key. Details: [providers.md](providers.md).

## The pnpm path (without Docker for the apps)

Run Postgres and Redis from compose and the apps from source:

```bash
pnpm install
docker compose --env-file deploy/compose/.env -f deploy/compose/compose.yaml up -d --wait postgres redis stubs mailpit
DATABASE_URL=postgres://gw:gw@localhost:5522/gw pnpm db:migrate

export DATABASE_URL=postgres://gw:gw@localhost:5522/gw REDIS_URL=redis://localhost:6459 \
       STUBS_URL=http://localhost:5149 PAYMENTS_STUB=true COOKIE_SECURE=false \
       MAIL_MODE=smtp SMTP_HOST=localhost SMTP_PORT=1076
pnpm --filter @open-gateway/api dev            # API on :5056
pnpm --filter @open-gateway/api dev:worker     # worker (another terminal, same env)
pnpm --filter @open-gateway/web dev            # console on :3560 (proxies /api and /v1 to :5056)
DEMO_PASSWORD=choose-one pnpm demo:seed        # demo accounts and Priya's key
```

The defaults in [`core/config.ts`](../../apps/api/src/core/config.ts) are development values,
so nothing else is required.

## Stop and reset

```bash
make down                 # stop everything and delete the volumes (database, emulator state)
make logs SERVICE=api     # tail one service: api, worker, web, stubs, migrate, floci, terraform
make ps                   # status
```

`deploy/compose/.env` survives `make down`; delete it to generate new secrets.

## Next

- Every setting: [configuration.md](configuration.md).
- Providers, models and prices: [providers.md](providers.md).
- Run the tests: [testing.md](testing.md).
- Deploy it: [deploy-aws.md](deploy-aws.md).
