/**
 * A circuit breaker per route, in Redis so every API task sees the same state.
 *
 *   closed     the route is used. Retryable failures (connection errors, timeouts,
 *              429 and 5xx) are counted in a one-minute window.
 *   open       FAILURE_THRESHOLD failures in the window open the circuit for
 *              OPEN_SECONDS: the router skips the route and fails over.
 *   half-open  after that, one request at a time may try the route; a success closes
 *              it, a failure opens it again.
 *
 * An admin can force a route open (take it out of rotation) or closed (clear a trip)
 * from the health page. Health probes (jobs/gateway.jobs.ts) report through the same
 * functions, so a dead route is found even without traffic.
 */
import { captureError } from "../core/logger";
import { redis } from "../integrations/redis";

export const FAILURE_THRESHOLD = 5;
export const OPEN_SECONDS = 30;
const WINDOW_SECONDS = 60;

export type CircuitState = "closed" | "open" | "half-open";

const k = (routeId: string, part: string) => `cb:${routeId}:${part}`;

export async function circuitState(routeId: string): Promise<CircuitState> {
  try {
    const [forced, openUntil] = await redis().mget(k(routeId, "forced"), k(routeId, "open_until"));
    if (forced === "open") return "open";
    if (forced === "closed") return "closed";
    if (!openUntil) return "closed";
    return Number(openUntil) > Date.now() ? "open" : "half-open";
  } catch (err) {
    captureError(err, { where: "breaker.state" });
    return "closed";
  }
}

/** Whether a request may use the route now. Half-open lets one caller through at a time. */
export async function allow(routeId: string): Promise<boolean> {
  const state = await circuitState(routeId);
  if (state === "closed") return true;
  if (state === "open") return false;
  try {
    return (await redis().set(k(routeId, "probe"), "1", "EX", 15, "NX")) === "OK";
  } catch {
    return true;
  }
}

export async function recordSuccess(routeId: string): Promise<void> {
  try {
    await redis().del(k(routeId, "fails"), k(routeId, "open_until"), k(routeId, "probe"));
  } catch (err) {
    captureError(err, { where: "breaker.success" });
  }
}

export async function recordFailure(routeId: string): Promise<void> {
  try {
    const state = await circuitState(routeId);
    if (state === "half-open") {
      await redis().multi().set(k(routeId, "open_until"), String(Date.now() + OPEN_SECONDS * 1000), "EX", OPEN_SECONDS * 4).del(k(routeId, "probe")).exec();
      return;
    }
    const fails = await redis().incr(k(routeId, "fails"));
    if (fails === 1) await redis().expire(k(routeId, "fails"), WINDOW_SECONDS);
    if (fails >= FAILURE_THRESHOLD) {
      await redis().multi().set(k(routeId, "open_until"), String(Date.now() + OPEN_SECONDS * 1000), "EX", OPEN_SECONDS * 4).del(k(routeId, "fails")).exec();
    }
  } catch (err) {
    captureError(err, { where: "breaker.failure" });
  }
}

/** Admin override: "open" takes the route out of rotation until cleared; "closed" clears a trip and any override. */
export async function forceCircuit(routeId: string, state: "open" | "closed"): Promise<void> {
  if (state === "open") await redis().set(k(routeId, "forced"), "open");
  else await redis().del(k(routeId, "forced"), k(routeId, "fails"), k(routeId, "open_until"), k(routeId, "probe"));
}
