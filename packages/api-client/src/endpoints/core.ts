/** Auth, the deployment meta and your account. */
import type { AppMeta, AuthResult, Me, SessionInfo } from "@open-gateway/types";
import { enc, type Helpers } from "./helpers";

export interface SignupInput {
  email: string;
  username: string;
  displayName: string;
  password: string;
}

export interface LoginInput {
  login: string;
  password: string;
  totp?: string;
  /** A one-time recovery code, sent instead of `totp`. */
  recoveryCode?: string;
}

export type SignupResult = AuthResult | { verificationRequired: true; email: string };
export type LoginResult = AuthResult | { totpRequired: true };

export interface AccountPatch {
  displayName?: string;
}

export function coreEndpoints(h: Helpers) {
  const { http, get, post, patch, del, download } = h;
  /** Native sessions: store the refresh token a response carries, then hand the result on. */
  const keep = async <T>(result: T): Promise<T> => {
    await http.captureSession(result);
    return result;
  };

  const auth = {
    signup: async (body: SignupInput) => keep(await http.request<SignupResult>("POST", "/auth/signup", { body, withCredentials: true, noRefresh: true })),
    verifyEmail: async (token: string) => keep(await http.request<AuthResult>("POST", "/auth/verify-email", { body: { token }, withCredentials: true, noRefresh: true })),
    resendVerification: (email: string) => http.request<void>("POST", "/auth/resend-verification", { body: { email }, noRefresh: true }),
    login: async (body: LoginInput) => keep(await http.request<LoginResult>("POST", "/auth/login", { body, withCredentials: true, noRefresh: true })),
    refresh: () => http.refreshSession(),
    /** Ends this session (native: sends and then forgets the stored refresh token). */
    logout: async () => {
      try {
        const body = await http.logoutBody();
        await http.request<void>("POST", "/auth/logout", { body, withCredentials: true, noRefresh: true });
      } finally {
        await http.clearNativeSession();
      }
    },
    logoutAll: () => http.request<void>("POST", "/auth/logout-all", { withCredentials: true }),
    forgotPassword: (email: string) => http.request<void>("POST", "/auth/forgot-password", { body: { email }, noRefresh: true }),
    resetPassword: (token: string, password: string) => http.request<void>("POST", "/auth/reset-password", { body: { token, password }, noRefresh: true }),
    changePassword: (currentPassword: string, newPassword: string) => http.request<void>("POST", "/auth/change-password", { body: { currentPassword, newPassword }, withCredentials: true }),
    me: (signal?: AbortSignal) => get<Me>("/auth/me", undefined, signal),
    totpSetup: () => post<{ secret: string; otpauthUrl: string }>("/auth/totp/setup"),
    /** Turns two-factor on and returns the one-time recovery codes (shown once). */
    totpEnable: (code: string) => post<{ recoveryCodes: string[] }>("/auth/totp/enable", { code }),
    totpDisable: (password: string, code: string) => post("/auth/totp/disable", { password, code }),
    /** Replaces every recovery code with a fresh set. */
    totpRecoveryCodes: (password: string, code: string) => post<{ recoveryCodes: string[] }>("/auth/totp/recovery-codes", { password, code }),
  };

  const meta = {
    get: (signal?: AbortSignal) => http.request<AppMeta>("GET", "/meta", { signal, noRefresh: true }),
  };

  const users = {
    me: () => get<Me>("/users/me"),
    updateMe: (body: AccountPatch) => patch<Me>("/users/me", body),
    /** Asks for deletion: signed out everywhere, erased after the grace period. 409 LAST_ADMIN. */
    deleteMe: (body: { password: string; totp?: string; recoveryCode?: string }) => http.request<{ purgeAfter: string }>("DELETE", "/users/me", { body }),
    /** Everything the account holds, as a JSON file (rate limited: 429 after 3 a day). */
    exportData: () => download("/users/me/export"),
    sessions: () => get<SessionInfo[]>("/users/me/sessions"),
    revokeSession: (id: string) => del(`/users/me/sessions/${enc(id)}`),
  };

  return { auth, meta, users };
}
