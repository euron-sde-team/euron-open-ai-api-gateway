# ADR 0001: One monorepo, one stack

## Status

Accepted.

## Context

The system has a gateway (the /v1 data plane), a console REST API, a background worker, a
web app, stand-ins for third-party services, and infrastructure code. A future native app should be able to reuse the API
contract without pulling in browser or Node code. Contributors should be able to run
everything with one command.

## Decision

- One pnpm workspace with Turborepo ([`pnpm-workspace.yaml`](../../../pnpm-workspace.yaml),
  [`turbo.json`](../../../turbo.json)), TypeScript throughout, Node 22 or later.
- `apps/api`: Express 5, Kysely over PostgreSQL, Redis with BullMQ. The same process serves
  the console API (`/api`) and the gateway (`/v1`); the same image runs the worker
  (`dist/worker.js`), migrations and the CLI.
- `apps/web`: Next.js 15 (standalone output), React Query, the shared `packages/ui`.
- `apps/stubs`: one dependency-free Node script that fakes the AI providers (OpenAI and
  Anthropic formats) and the payment gateways (Stripe and Razorpay).
- `packages/types`: the DTOs, with no runtime dependencies and no DOM or Node API.
- `packages/api-client`: a typed client over `fetch`, DOM-free, with a native token mode.
- `db/migrations`: plain SQL, applied in order by `db/migrate.ts`. No ORM schema.
- Layers inside the API: routes, controllers, services, repositories, presenters,
  integrations, jobs, and the gateway modules under `src/gateway` and `src/billing`
  ([LLD.md](../LLD.md)).
- `infra/terraform` and `deploy/compose`: the same Terraform modules provision AWS and the
  local Floci emulator.

## Consequences

Positive:

- One change can touch the contract, the API and the web app, and the compiler finds every
  caller.
- The OpenAPI reference is generated from the route files and checked in CI.
- A React Native app can vendor `packages/types` and `packages/api-client` unchanged.

Trade-offs:

- Plain SQL migrations mean schema changes are written by hand, and the Kysely types in
  `apps/api/src/db/types.ts` must be kept in step.
- One repository means one release cadence for every part.

## Alternatives considered

- **Separate repositories per app.** Duplicates the contract and drifts.
- **A full-stack framework with server actions only.** Would tie a native client to web
  internals.
