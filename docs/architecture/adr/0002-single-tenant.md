# ADR 0002: One organisation per deployment

## Status

Accepted.

## Context

The gateway is meant to be run by one operator (a company, a platform team, a reseller)
for its own developers and customers. Multi-tenancy (operators inside operators) adds a
tenant column to every table and query, tenant-aware catalogues, prices and settings, and
a whole class of cross-tenant leaks.

## Decision

One deployment serves one organisation or community. There is no tenant column
([`db/migrations/0001_init.sql`](../../../db/migrations/0001_init.sql)). Deployment-wide
choices (name, registration mode, default margin, signup credit, tax, top-up limits,
retention) live in the `settings` table and are edited in Admin, Settings. Accounts are
the billing unit: each has one wallet and any number of API keys. Two roles
exist: `USER` and `ADMIN`.

## Consequences

Positive:

- Every query has one scope to get right: the owner. Ownership checks are simple and
  tested on every key, top-up and usage route.
- The catalogue, prices and provider credentials have one meaning per deployment.

Trade-offs:

- Hosting several operators means several deployments (separate databases and
  stacks). The Terraform modules make that repeatable, not free.
- Teams (several people sharing one wallet) are not in v1; an account is one person.

## Alternatives considered

- **Tenant column everywhere.** More code and more risk for a use case this project does
  not target.
