# ADR 0009: Native token mode for future mobile clients

## Status

Accepted. No native app ships in this repository; the API and the shared packages are
ready for one.

## Context

The web app keeps the access token in memory and the refresh token in an httpOnly
`gw_refresh` cookie scoped to `/api/auth`. A React Native app has no cookie jar it
controls well and a better place for a long-lived secret: the platform keystore. It still
needs the same session semantics: short access tokens, one rotating refresh token per
login, and family revocation on replay.

## Decision

- A client opts in per request with `X-Client: native`. The header changes only how the
  refresh token travels ([`controllers/auth.controller.ts`](../../../apps/api/src/controllers/auth.controller.ts)).
- Every endpoint that issues a session answers `IssuedNativeSession`: the `AuthResult` plus
  `refreshToken` and `refreshExpiresAt`. No cookie is set or cleared.
- `POST /api/auth/refresh` and `POST /api/auth/logout` take `{ refreshToken }` in the body.
- Rotation and reuse detection are the same code path as the web.
- `packages/api-client` has a `native` option with a token store interface the app
  implements over the keystore; `packages/types` has no DOM or Node dependency
  ([mobile-clients.md](../../guides/mobile-clients.md)).

## Consequences

Positive:

- One session model and one table for both kinds of client (`native-auth.int.test.ts`
  covers native sign-in, body refresh, replay and that cookie mode is unchanged).
- The refresh token never sits in JavaScript-readable storage on the web.

Trade-offs:

- A native refresh token in a response body is readable by the app; the app must keep it
  only in the keystore and never log it (the API's logger redacts `refreshToken`).
- The header is a client claim; it does not weaken the web, since a page that sends it
  only stops receiving the cookie.
- Native token mode covers the console API (keys, usage, billing). Calls to `/v1` use an
  API key, never a session, so a native app that calls models directly should hold a key
  of its own with tight limits, or call through its own backend.

## Alternatives considered

- **Cookies in the app.** Ties token storage to an HTTP stack instead of the keystore.
- **A separate `/api/auth/native/*` route set.** Duplicates every session route and test.
