import { isApiError } from "@open-gateway/api-client";

/** Human copy for the API's stable error codes. Unknown codes fall back to the server message. */
const COPY: Record<string, string> = {
  NETWORK_ERROR: "We could not reach the server. Check your connection and try again.",
  SERVER_ERROR: "Something went wrong on our side. Try again in a moment.",
  BAD_GATEWAY: "The service is restarting. Try again in a moment.",
  SERVICE_UNAVAILABLE: "The service is temporarily unavailable. Try again in a moment.",
  GATEWAY_TIMEOUT: "The server took too long to answer. Try again.",
  RATE_LIMITED: "You are doing that too fast. Wait a moment and try again.",
  UNAUTHENTICATED: "Sign in to continue.",
  TOKEN_INVALID: "This link is invalid or has expired.",
  SESSION_EXPIRED: "Your session expired. Sign in again.",
  FORBIDDEN: "You do not have permission to do that.",
  FORBIDDEN_ADMIN: "Only administrators can do that.",
  NOT_FOUND: "We could not find that. It may have been removed.",
  VALIDATION_FAILED: "Some fields need attention.",
  INVALID_CREDENTIALS: "That email, username or password is not right.",
  INVALID_TOTP: "That code did not work. Check your authenticator app and try again.",
  ACCOUNT_BANNED: "This account has been banned.",
  ACCOUNT_DEACTIVATED: "This account has been deactivated.",
  ACCOUNT_RESTRICTED: "Your account is restricted: you can read your usage but not change keys or top up.",
  EMAIL_NOT_VERIFIED: "Confirm your email address first. Check your inbox for the link.",
  EMAIL_TAKEN: "An account with that email already exists.",
  USERNAME_TAKEN: "That username is taken. Try another.",
  WEAK_PASSWORD: "Choose a stronger password: at least 10 characters, not a common one.",
  REGISTRATION_CLOSED: "Sign-ups are closed right now.",
  REGISTRATION_DOMAIN_NOT_ALLOWED: "Sign-up is open to approved email domains only. Use your work address.",
  USERNAME_RESERVED: "That username is reserved. Try another.",
  LAST_ADMIN: "You are the last administrator. Make someone else an admin first.",
  SELF_ACTION: "You cannot do that to your own account.",
  TARGET_PROTECTED: "Administrators cannot be suspended or banned. Remove their admin role first.",
  PAYLOAD_TOO_LARGE: "That is too large.",
  KEY_LIMIT: "You have the most active keys an account can hold. Revoke one first.",
  KEY_REVOKED: "This key was revoked and cannot be changed.",
  KEY_NOT_FOUND: "That key no longer exists.",
  UNKNOWN_MODEL: "One of those models does not exist. Pick from the catalogue.",
  EXPIRY_IN_PAST: "Choose an expiry date in the future.",
  IP_ALLOWLIST_INVALID: "Enter IP addresses or ranges such as 203.0.113.7 or 203.0.113.0/24.",
  TOPUP_AMOUNT: "That amount is outside the top-up limits.",
  GATEWAY_UNAVAILABLE: "Top-ups in that currency are not available right now.",
  GATEWAY_ERROR: "The payment provider did not answer. Try again in a moment.",
  SIGNATURE_INVALID: "The payment could not be verified. If you were charged, it will be credited within a few minutes.",
  PAYMENT_PENDING: "The payment is still processing. Your balance updates as soon as it completes.",
  TOPUP_NOT_PAID: "Receipts are issued for paid top-ups only.",
  PROMO_NOT_FOUND: "That code does not exist.",
  PROMO_USED: "You have already used this code.",
  PROMO_EXPIRED: "That code has expired or been fully redeemed.",
  STUB_DISABLED: "The test payment gateway is turned off on this server.",
  INVALID_RANGE: "Choose a valid date range.",
  FEATURE_DISABLED: "This is turned off on this server.",
  MODEL_UNPRICED: "A model can be enabled only once it has an enabled, priced route with a working provider.",
  ALIAS_TAKEN: "That id or alias is already used by another model.",
};

export function errorCopy(code: string | undefined, fallback?: string): string {
  if (code && COPY[code]) return COPY[code];
  return fallback || "Something went wrong. Try again.";
}

/** The best human message for any thrown value. */
export function errorMessage(e: unknown): string {
  if (isApiError(e)) {
    // Validation messages from the server are already field-specific and readable.
    if (e.code === "VALIDATION_FAILED") {
      const first = Object.values(e.fieldErrors)[0];
      return first ? `${COPY.VALIDATION_FAILED} ${capitalise(first)}.` : COPY.VALIDATION_FAILED!;
    }
    return errorCopy(e.code, e.message);
  }
  if (e instanceof Error && e.name === "AbortError") return "Cancelled.";
  return errorCopy(undefined);
}

const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1).replace(/\.$/, "");

/** Errors not worth a toast: the page already shows them in place. */
export function isQuietError(e: unknown): boolean {
  if (isApiError(e)) return e.status === 404 || e.status === 401 || e.code === "VALIDATION_FAILED";
  return e instanceof Error && e.name === "AbortError";
}
