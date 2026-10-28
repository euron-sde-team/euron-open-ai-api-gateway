# Contributing

Thanks for helping improve Euron Open AI API Gateway. This guide covers the workflow, the bar a
change has to clear, and the conventions the codebase follows.

## Ground rules

- **Open an issue first** for anything larger than a bug fix or a docs tweak, so we can
  agree on the approach before you invest time.
- **One concern per pull request.** A refactor and a feature are two PRs.
- **Security issues go through private reporting**, never a public issue. See
  [SECURITY.md](SECURITY.md).
- By contributing you agree your work is released under the [MIT License](LICENSE).

## Development setup

Requirements: Docker, Node 22+, pnpm 9 (`corepack enable`).

```bash
pnpm install
make up          # Postgres, Redis, the AWS emulator (provisioned by Terraform), Mailpit,
                 # the stubs (fake providers, Stripe and Razorpay),
                 # then migrate, api, worker and web
make demo        # an admin, four developers with keys, top-ups and 30 days of traffic
                 # (prints the logins and the main developer's API key)
make test        # unit tests across every package
```

The app is at http://localhost:3560 and every mail it sends is readable at
http://localhost:8076. The gateway is at http://localhost:3560/v1. No provider key or
payment account is needed: the stubs answer every endpoint deterministically and stand in
for Stripe and Razorpay. [docs/guides/quickstart-local.md](docs/guides/quickstart-local.md)
lists every port and how to add a real key.

## Before you open a pull request

Each of these must pass:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
make test-integration            # API (HTTP) against a real Postgres and Redis, stubs in-process
make test-matrix                 # when you touched the mail backends
make e2e                         # when you touched a user flow or infrastructure
make tf-validate tf-lint tf-security   # when you touched infra/terraform
pnpm openapi --check             # when you touched a route (pnpm openapi regenerates)
make sanitize                    # no credentials, account ids, real emails or IPs
```

[docs/guides/testing.md](docs/guides/testing.md) explains each layer and the stubs' failure
switches (`fail-503`, `slow-<ms>`, `STUB_CUT`).

## Conventions

**Layers (api).** Routes declare endpoints and guards; controllers parse the request with
strict zod schemas and write the response; services hold the business rules and take an
`Actor`, never a request; repositories hold the Kysely queries; presenters build DTOs field
by field. Background work (the reservation sweeper, health probes, FX sync, low-balance
mail, maintenance) is a BullMQ job. Pure rules (pricing, token estimates, translation,
display names) live in `apps/api/src/gateway` or `apps/api/src/domain` and have unit tests
([LLD.md](docs/architecture/LLD.md)).

**Money is integer micro-USD.** Never a float, never a `Number` of dollars. Charges round
up, credits round down. Every balance change is one ledger row booked in the same
transaction, idempotent on its reference ([ADR 0003](docs/architecture/adr/0003-wallet-reservations-ledger.md)).
A change that touches money gets an integration test with a race in it.

**Nothing reaches a provider unchecked.** New `/v1` endpoints are a `CallSpec` handed to
`runCall`, which authenticates, limits and reserves before any upstream call
([ADR 0007](docs/architecture/adr/0007-request-pipeline.md)). Never call `callUpstream`
from anywhere else on the request path.

**Every query is scoped to its owner.** A key, top-up, request or ledger entry is read with
the actor's id in the query, and another account's id is a 404. A new endpoint that returns
account data gets an integration test proving a second account cannot read it. Admin
endpoints never return request bodies or provider secrets.

**Secrets never leave the server in clear.** API keys are stored as HMACs and shown once;
provider credentials are encrypted and returned only as a label and last four
([ADR 0008](docs/architecture/adr/0008-provider-credentials-encrypted.md)). Never add a
secret to a DTO or a log line. Provider failures reach callers as a stable code, never as
provider text.

**Prompts stay out of logs.** Log ids, counts, models and statuses; never prompts or
completions. Bodies are stored only for keys that opt in, with retention.

**The DTOs are a contract.** `packages/types` is read by the web app and by native clients
that vendor it. Add fields, do not rename or remove them, and update
[docs/api/rest-contract.md](docs/api/rest-contract.md) (and
[docs/api/gateway.md](docs/api/gateway.md) for `/v1`) in the same PR.

**Routes stay declarative.** One `router.<method>("<path>", ...guards, ctrl.fn);` per
endpoint with a `/** doc comment */` above: `scripts/gen-openapi.ts` builds
docs/api/openapi.yaml from exactly that shape.

**Configuration is validated.** Every environment variable is declared in
`apps/api/src/core/config.ts` and nowhere else; a new one is documented in
[docs/guides/configuration.md](docs/guides/configuration.md) in the same PR, and
security-relevant ones are enforced at boot by `assertProductionConfig`.

**Database changes are new migrations.** Add `db/migrations/NNNN_description.sql` and update
`apps/api/src/db/types.ts`. Never edit an applied migration: the runner refuses to start
when a checksum changes.

**New provider formats get stubs.** Teach `apps/stubs/server.mjs` to speak a new wire
format, so the integration suite stays hermetic
([routing-and-failover.md](docs/architecture/routing-and-failover.md)).

**Comments explain why.** The code says what it does. Comments are for the constraint, the
incident, or the trade-off that made it this way.

**Style.** Prettier and ESLint settle formatting. TypeScript strict mode everywhere.

## Commit messages

Imperative mood with an optional scope: `gateway: fail over on 425 before the first byte`,
`web: keep the top-up preview in step with the tax setting`. Explain the *why* in the body when it is not
obvious.

## Architecture decisions

A change that alters a documented decision (the stack, single tenant, reservations and the
ledger, one USD balance, pricing from the primary route, format translation, the request
pipeline, encrypted credentials, native token mode, deployment topology) needs a new or updated ADR in
[docs/architecture/adr/](docs/architecture/adr/README.md) explaining the trade-off, linked
from the pull request.
