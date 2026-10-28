import { isApiError } from "@open-gateway/api-client";

/** Copy for a failed data export. */
export function exportErrorMessage(e: unknown, fallback: (e: unknown) => string): string {
  if (isApiError(e) && e.status === 429) return "You can export 3 times a day. Try again tomorrow.";
  return fallback(e);
}
