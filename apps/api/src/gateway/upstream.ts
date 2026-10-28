/**
 * Calls to an upstream provider: the right auth headers per provider kind, the route's
 * timeout combined with the caller's disconnect, and one classification of failures.
 *
 * Retryable failures (the router fails over): the connection failed, the route timed
 * out, or the provider answered 408, 409, 425, 429 or 5xx. Anything else (400, 401, 403,
 * 404, 413, 422) is the caller's request or our configuration, so the next route would
 * fail the same way; it is returned to the caller as a gateway error without failover.
 * 401 and 403 are not retried elsewhere, but they count as failures for the route's
 * circuit (pipeline.ts): a revoked credential takes the route out until it is fixed.
 *
 * Provider error bodies are logged (truncated, key-shaped strings masked) and never
 * returned to a caller.
 */
import { logger } from "../core/logger";
import { maskSecrets } from "../integrations/http";
import { pickCredential, type CatalogRoute } from "./catalog";

export const ANTHROPIC_VERSION = "2023-06-01";

export class UpstreamError extends Error {
  constructor(
    readonly status: number | null,
    readonly retryable: boolean,
    readonly kind: "network" | "timeout" | "http",
    readonly providerId: string,
  ) {
    super(`${providerId}: ${kind}${status ? ` ${status}` : ""}`);
  }
}

const RETRYABLE = new Set([408, 409, 425, 429]);

function headersFor(route: CatalogRoute, secret: string, json: boolean): Record<string, string> {
  const h: Record<string, string> = {};
  if (json) h["Content-Type"] = "application/json";
  if (route.provider.kind === "ANTHROPIC") {
    h["x-api-key"] = secret;
    h["anthropic-version"] = ANTHROPIC_VERSION;
  } else {
    h.Authorization = `Bearer ${secret}`;
  }
  return h;
}

/**
 * POST to `route.provider.baseUrl + path`. Returns the response when it is 2xx; throws
 * UpstreamError otherwise. The body may be JSON (an object) or multipart (FormData).
 */
export async function callUpstream(route: CatalogRoute, path: string, body: object | FormData, opts: { signal?: AbortSignal; accept?: string } = {}): Promise<Response> {
  const cred = pickCredential(route);
  const isForm = typeof FormData !== "undefined" && body instanceof FormData;
  const timeout = AbortSignal.timeout(route.timeoutMs);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
  let res: Response;
  try {
    res = await fetch(`${route.provider.baseUrl}${path}`, {
      method: "POST",
      headers: { ...headersFor(route, cred.secret, !isForm), ...(opts.accept ? { Accept: opts.accept } : {}) },
      body: isForm ? (body as FormData) : JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if (opts.signal?.aborted) throw err;
    const timedOut = timeout.aborted || (err as Error).name === "TimeoutError";
    logger.warn({ provider: route.provider.id, route: route.id, err: (err as Error).message }, timedOut ? "upstream timed out" : "upstream unreachable");
    throw new UpstreamError(null, true, timedOut ? "timeout" : "network", route.provider.id);
  }
  if (res.ok) return res;
  const text = await res.text().catch(() => "");
  logger.warn({ provider: route.provider.id, route: route.id, status: res.status, body: maskSecrets(text.slice(0, 600)) }, "upstream call failed");
  throw new UpstreamError(res.status, res.status >= 500 || RETRYABLE.has(res.status), "http", route.provider.id);
}
