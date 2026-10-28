/**
 * Prices and margins (ADR 0005). All money is integer micro-USD; prices are per million
 * tokens (or per unit for images, speech and transcription). Rounding is always up, so
 * the platform never loses a fraction of a micro-dollar on a request.
 *
 *   margin   = key override ?? account override ?? model override ?? default   (basis points, 0 and up)
 *   price    = cost x (10 000 + margin) / 10 000
 *   charged  = the primary route's price, whichever route served the request
 */
import type { ModelPrice } from "@open-gateway/types";
import type { Prices } from "./catalog";

export function effectiveMargin(keyBps: number | null | undefined, userBps: number | null | undefined, modelBps: number | null | undefined, defaultBps: number): number {
  return keyBps ?? userBps ?? modelBps ?? defaultBps;
}

/** Ceil(value x (1 + bps / 10 000)) in integer arithmetic. */
export function withMargin(micros: number, bps: number): number {
  if (micros <= 0) return 0;
  return Math.ceil((micros * (10_000 + bps)) / 10_000);
}

export function priceList(cost: Prices, bps: number): ModelPrice {
  return {
    inputMicrosPerMtok: withMargin(cost.inputMicrosPerMtok, bps),
    outputMicrosPerMtok: withMargin(cost.outputMicrosPerMtok, bps),
    cachedMicrosPerMtok: cost.cachedMicrosPerMtok === null ? null : withMargin(cost.cachedMicrosPerMtok, bps),
    unitMicros: withMargin(cost.unitMicros, bps),
  };
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  /** Input tokens served from the provider's prompt cache (a subset of inputTokens). */
  cachedTokens: number;
}

/** The amount for token usage at the given per-million prices, rounded up. */
export function tokenAmount(p: Pick<Prices, "inputMicrosPerMtok" | "outputMicrosPerMtok" | "cachedMicrosPerMtok">, u: TokenUsage): number {
  const cached = Math.min(Math.max(0, u.cachedTokens), Math.max(0, u.inputTokens));
  const fresh = Math.max(0, u.inputTokens) - cached;
  const cachedPrice = p.cachedMicrosPerMtok ?? p.inputMicrosPerMtok;
  const total = fresh * p.inputMicrosPerMtok + cached * cachedPrice + Math.max(0, u.outputTokens) * p.outputMicrosPerMtok;
  return Math.ceil(total / 1_000_000);
}

/** Per-unit amount: images, characters (unit price is per million) or minutes. */
export function unitAmount(unitMicros: number, units: number, perMillion = false): number {
  const raw = unitMicros * Math.max(0, units);
  return Math.ceil(perMillion ? raw / 1_000_000 : raw);
}

/** Display helper: micro-USD to a decimal USD string with up to 6 places. */
export function microsToUsd(micros: number): string {
  return (micros / 1_000_000).toFixed(6).replace(/\.?0+$/, "");
}
