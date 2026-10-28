# ADR 0008: Provider credentials in the database, encrypted, never returned

## Status

Accepted.

## Context

Operators add providers and rotate their API keys while the gateway runs, often several
keys per provider to spread rate limits. Environment variables need a redeploy for every
change, and the system this replaces stored provider keys in plain text in admin rows and
returned them to the admin UI.

## Decision

- Admins add credentials in `/admin/providers`. Each is encrypted on arrival with
  AES-256-GCM under a key derived (HKDF) from `CREDENTIALS_KEY`, with the credential's id
  as additional authenticated data, and stored as `v1:` plus base64url. Only a label and
  the last four characters are kept in clear.
- No endpoint returns a secret; admin responses carry the label and last four only.
- The catalogue decrypts credentials into process memory (cached a few seconds) and uses
  enabled credentials of a provider round robin.
- A credential that no longer decrypts (the key changed) is skipped and logged, never
  fatal.
- Production refuses to start with the development `CREDENTIALS_KEY`.

Code: [`apps/api/src/security/credentials.ts`](../../../apps/api/src/security/credentials.ts),
[`apps/api/src/gateway/catalog.ts`](../../../apps/api/src/gateway/catalog.ts).

## Consequences

Positive:

- Providers and keys change without a redeploy; several keys per provider share load.
- A database dump alone does not reveal provider keys (`secrets.int.test.ts` checks the
  canary key appears nowhere in clear, in any response or table).

Trade-offs:

- `CREDENTIALS_KEY` becomes a critical secret: losing it means re-entering every provider
  key; leaking it with a database dump reveals them. It lives in the secrets manager.
- Rotating `CREDENTIALS_KEY` is a re-encryption, not a config change.

## Alternatives considered

- **Keys in environment variables.** Redeploy per change, one key per provider.
- **A secrets manager entry per credential.** Strong, but adds a cloud dependency to a
  table edit and slows the hot path without caching.
