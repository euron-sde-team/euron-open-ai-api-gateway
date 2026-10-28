# Architecture decision records

Short records of the decisions that shape Euron Open AI API Gateway: the context, what was
decided, and what it costs. The system as built is described in [HLD.md](../HLD.md) and
[LLD.md](../LLD.md).

| ADR | Decision |
| --- | --- |
| [0001](0001-monorepo-stack.md) | One pnpm and Turborepo monorepo: Express API (console and gateway) and worker, Next.js web app, shared DOM-free types and client, SQL migrations |
| [0002](0002-single-tenant.md) | One operator per deployment; no tenants |
| [0003](0003-wallet-reservations-ledger.md) | Reserve the worst case before calling a provider, settle after, one append-only ledger |
| [0004](0004-one-usd-ledger.md) | One USD balance; rupee top-ups converted at a rate locked per order |
| [0005](0005-pricing-primary-route-and-margin.md) | Price is the primary route's cost plus a margin chosen by precedence (key, account, model, default) |
| [0006](0006-format-translation.md) | Both the OpenAI and the Anthropic format, translated in both directions |
| [0007](0007-request-pipeline.md) | One request pipeline in a fixed order, cheapest checks first |
| [0008](0008-provider-credentials-encrypted.md) | Provider credentials in the database, encrypted, never returned |
| [0009](0009-native-token-mode.md) | Native token mode for future mobile clients (`X-Client: native`) |
