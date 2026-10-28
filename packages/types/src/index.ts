/**
 * The API contract shared by apps/api, apps/web and any native client: response shapes
 * (DTOs) and the streaming event catalogue. Timestamps are ISO-8601 strings. Ids are ULIDs.
 *
 * This package has no runtime dependencies and touches no DOM or Node API, so a React
 * Native app can vendor it as is (docs/guides/mobile-clients.md).
 *
 * Changing a shape here is a breaking change for one side or the other; every app
 * typechecks against these files, so the compiler finds every caller.
 */

// ─── Enums (mirrors db/migrations) ──────────────────────────────────────────

export const USER_ROLES = ["USER", "ADMIN"] as const;
export type UserRole = (typeof USER_ROLES)[number];
export type UserStatus = "PENDING_VERIFICATION" | "ACTIVE" | "SUSPENDED" | "BANNED" | "DEACTIVATED";

// ─── Envelopes ──────────────────────────────────────────────────────────────

/** Keyset page: pass `nextCursor` back as `?cursor=` until it is null. */
export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

/** Every non-2xx response. `code` is stable; switch on it, not on `error`. */
export interface ApiError {
  error: string;
  code: string;
  details?: unknown;
  requestId?: string;
}

// ─── People ─────────────────────────────────────────────────────────────────

/** The person card shown wherever someone appears (admin lists, the audit log). */
export interface UserSummary {
  id: string;
  username: string;
  displayName: string;
  role: UserRole;
}

export interface Me extends UserSummary {
  email: string;
  status: UserStatus;
  /** When a SUSPENDED account's suspension ends (ISO); null otherwise. */
  suspendedUntil: string | null;
  emailVerified: boolean;
  totpEnabled: boolean;
  /** Set while an account deletion is pending; signing in again cancels it. */
  deletionRequestedAt: string | null;
  /** True for admins: the account may open /admin. */
  canOpenAdmin: boolean;
}

/** GET /api/meta: public facts about this deployment, read before anyone signs in. */
export interface AppMeta {
  appName: string;
  tagline: string;
  registration: "OPEN" | "INVITE_ONLY" | "CLOSED";
  /** The public base URL callers point their SDK at, including /v1 ("https://api.example.com/v1"). */
  gatewayBaseUrl: string;
  /** Prefix of every API key ("gw-"). */
  keyPrefix: string;
  billing: {
    /** Which currencies can be topped up, and through which gateway. */
    topups: { currency: "USD" | "INR"; gateway: "STRIPE" | "RAZORPAY" | "STUB"; minMinor: number; maxMinor: number }[];
    /** Tax added to a top-up, in basis points (1800 = 18 %); 0 when none. */
    taxBps: number;
    taxLabel: string;
    /** Credit a new account starts with, in micro-USD (0 when none). */
    signupCreditMicros: number;
    /** INR per USD used for display and for new INR orders. */
    inrPerUsd: number;
  };
  support: { email: string | null };
  minSupportedVersion: string | null;
}

export interface AuthResult {
  accessToken: string;
  /** Seconds until the access token expires; refresh through POST /api/auth/refresh. */
  expiresIn: number;
  user: Me;
}

/**
 * The same session for a native app (request header `X-Client: native`): the refresh
 * token comes back in the body instead of a cookie. Keep it in the platform keystore and
 * send it as `{ refreshToken }` to POST /api/auth/refresh and /api/auth/logout.
 */
export interface IssuedNativeSession extends AuthResult {
  refreshToken: string;
  /** ISO time after which the refresh token no longer works (sign in again). */
  refreshExpiresAt: string;
}

export interface SessionInfo {
  id: string;
  userAgent: string | null;
  ip: string | null;
  createdAt: string;
  lastUsedAt: string;
  current: boolean;
}

export * from "./gateway";
export * from "./admin";
