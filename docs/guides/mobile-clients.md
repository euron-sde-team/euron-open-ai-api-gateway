# Building a native client

There is no mobile app in this repository. The console API is ready for one: a native app
calls the same `/api` routes as the web console, with a token mode that keeps the refresh
token out of cookies. This page covers what differs for a native client. Every route is in
[rest-contract.md](../api/rest-contract.md).

An app that only calls models does not need any of this: it uses the gateway (`/v1`) with an
API key, like any other server or SDK ([gateway.md](../api/gateway.md)). Do not ship a
`gw-` key inside an app binary; anyone can extract it. Call the gateway from your own
backend, or have each user bring a key from their own account.

## Native token mode

The web console keeps the refresh token in an httpOnly cookie scoped to `/api/auth`. A native
app sends `X-Client: native` (any case) on every request instead
([`controllers/auth.controller.ts`](../../apps/api/src/controllers/auth.controller.ts),
proven by [`native-auth.int.test.ts`](../../apps/api/test/integration/native-auth.int.test.ts)):

| Call | Native behaviour |
| --- | --- |
| `POST /api/auth/login`, `/signup` (when no verification is needed), `/verify-email` | The session in the body: `accessToken`, `expiresIn`, `user`, plus `refreshToken` and `refreshExpiresAt`. No `Set-Cookie`, ever |
| `POST /api/auth/refresh` with `{ refreshToken }` | A new session; the refresh token rotates on every use. Replaying a rotated token revokes the whole session family |
| `POST /api/auth/logout` with `{ refreshToken }` | `204`; revokes that session family |
| `POST /api/auth/logout-all` | `204`; every session and access token of the account |

Rules for the app:

- Keep the refresh token only in the platform keystore (iOS Keychain, Android Keystore),
  never in plain storage, a log or a crash report.
- Keep the access token in memory. It lives `ACCESS_TOKEN_TTL_SECONDS` (15 minutes by
  default). Refresh before it runs out, and on a `401 TOKEN_INVALID`.
- Refresh single-flight: two concurrent refreshes with the same token look like a replay
  and end the session.
- `401 SESSION_EXPIRED` from refresh means the session is over: clear the keystore and show
  sign-in. `403 ACCOUNT_BANNED` and `403 ACCOUNT_DEACTIVATED` likewise.
- `403 ACCOUNT_RESTRICTED` on a write means the account is suspended: it can read but not
  create keys or top up.

Two-factor sign-in works as on the web: `login` answers `{ totpRequired: true }`; send the
code as `totp`, or an unused `recoveryCode`.

## The contract packages

Two workspace packages have no DOM or Node dependency and run in React Native as well as the
browser:

| Package | Holds |
| --- | --- |
| [`packages/types`](../../packages/types/src/index.ts) | Every DTO: keys, wallet, ledger, top-ups, usage, catalogue, admin. Types only |
| [`packages/api-client`](../../packages/api-client/src/index.ts) | `createApiClient`: typed endpoint groups (`auth`, `users`, `keys`, `billing`, `models`, `usage`, `admin`, ...), `ApiError` with the stable `code`, single-flight refresh, keyset pagination helpers, native token mode |

They are private and not published to npm. Vendor them at a pinned commit and point your
bundler at the copy; they ship TypeScript source.

Pass a `native` token store to `createApiClient`. The client then sends `X-Client: native`,
saves the refresh token that `signup`, `verifyEmail` and `login` return, refreshes with
`{ refreshToken }` in the body, keeps the rotated token, and clears it on `logout` or when
the server ends the session (then calls `onSignedOut`).

```ts
import { createApiClient } from "@open-gateway/api-client";
import * as Keychain from "react-native-keychain";

let accessToken: string | null = null;

export const api = createApiClient({
  baseUrl: "https://gateway.example.com/api",
  getAccessToken: () => accessToken,
  onRefresh: (r) => (accessToken = r.accessToken),
  onSignedOut: () => (accessToken = null),
  crossTabLock: (fn) => fn(), // one JS runtime: the built-in single-flight is enough
  native: {
    getRefreshToken: async () => (await Keychain.getGenericPassword({ service: "gw-refresh" }))?.password ?? null,
    setRefreshToken: async (token) => {
      if (token) await Keychain.setGenericPassword("refresh", token, { service: "gw-refresh" });
      else await Keychain.resetGenericPassword({ service: "gw-refresh" });
    },
  },
});
```

After a cold start, call `api.auth.refresh()` once: it trades the stored refresh token for an
access token, or returns `null` when there is no session.

## Payments in an app

`POST /api/billing/topups` returns a hosted checkout: a Stripe Checkout URL to open in the
system browser, or a Razorpay order for Razorpay's native SDK, whose success result goes to
`POST /api/billing/razorpay/verify` exactly as checkout.js does on the web. Check your app
store's rules on selling credit outside its in-app purchase system before you ship this.

## Minimum supported version

`GET /api/meta` returns `minSupportedVersion` (a `major.minor.patch` string, or `null`),
set by an admin in Settings. The server does not enforce it; an app compares it with its own
version at start and asks the user to update.
