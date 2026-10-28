"use client";

/**
 * The developer console's data: React Query hooks over `api()` for the wallet, keys,
 * catalogue, ledger, top-ups and usage, plus the small pure helpers the pages share.
 */
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ModelKind, ModelPrice, UsageQuery } from "@open-gateway/types";
import { api } from "./api";
import { qk } from "./query-keys";
import { perMillion, usd } from "./money";

export function useWallet() {
  return useQuery({ queryKey: qk.wallet, queryFn: () => api().billing.wallet(), refetchInterval: 30_000 });
}

export function useKeys() {
  return useQuery({ queryKey: qk.keys, queryFn: () => api().keys.list() });
}

export function useCatalog() {
  return useQuery({ queryKey: qk.catalog, queryFn: ({ signal }) => api().models.list(signal), staleTime: 60_000 });
}

export function useUsageSummary(q: UsageQuery) {
  return useQuery({ queryKey: qk.usageSummary(q as Record<string, unknown>), queryFn: () => api().usage.summary(q), placeholderData: (p) => p });
}

export function useRequests(f: { apiKeyId?: string; modelId?: string; status?: "ok" | "error" }) {
  return useInfiniteQuery({
    queryKey: qk.requests(f),
    queryFn: ({ pageParam }) => api().usage.requests({ ...f, cursor: pageParam, limit: 25 }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}

export function useLedger(type?: string) {
  return useInfiniteQuery({
    queryKey: qk.ledger({ type }),
    queryFn: ({ pageParam }) => api().billing.ledger({ cursor: pageParam, limit: 25, ...(type ? { type } : {}) }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}

export function useTopups() {
  return useInfiniteQuery({
    queryKey: qk.topups,
    queryFn: ({ pageParam }) => api().billing.topups({ cursor: pageParam, limit: 25 }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}

/** After money moves: the wallet, ledger and top-ups are all stale. */
export function useInvalidateMoney() {
  const qc = useQueryClient();
  return () => Promise.all([qc.invalidateQueries({ queryKey: qk.wallet }), qc.invalidateQueries({ queryKey: qk.ledgerAll }), qc.invalidateQueries({ queryKey: qk.topups })]);
}

// ─── Pure helpers ───────────────────────────────────────────────────────────

export const KIND_LABEL: Record<ModelKind, string> = { CHAT: "Chat", EMBEDDING: "Embeddings", IMAGE: "Images", SPEECH: "Speech", TRANSCRIPTION: "Transcription" };

/** The price columns that matter for a model kind, as label/value pairs. */
export function priceParts(kind: ModelKind, p: ModelPrice): { label: string; value: string }[] {
  switch (kind) {
    case "CHAT":
      return [
        { label: "Input", value: perMillion(p.inputMicrosPerMtok) },
        { label: "Output", value: perMillion(p.outputMicrosPerMtok) },
        ...(p.cachedMicrosPerMtok !== null ? [{ label: "Cached input", value: perMillion(p.cachedMicrosPerMtok) }] : []),
      ];
    case "EMBEDDING":
      return [{ label: "Input", value: perMillion(p.inputMicrosPerMtok) }];
    case "IMAGE":
      return [{ label: "Per image", value: usd(p.unitMicros) }];
    case "SPEECH":
      return [{ label: "Per 1M characters", value: usd(p.unitMicros) }];
    case "TRANSCRIPTION":
      return [{ label: "Per minute", value: usd(p.unitMicros) }];
  }
}

/** The endpoint a model kind is called on. */
export const KIND_ENDPOINT: Record<ModelKind, string> = {
  CHAT: "/v1/chat/completions",
  EMBEDDING: "/v1/embeddings",
  IMAGE: "/v1/images/generations",
  SPEECH: "/v1/audio/speech",
  TRANSCRIPTION: "/v1/audio/transcriptions",
};

/** The last N UTC days as from/to (inclusive), for the usage range picker. */
export function lastDays(days: number, now = new Date()): { from: string; to: string } {
  const day = (d: Date) => d.toISOString().slice(0, 10);
  return { from: day(new Date(now.getTime() - (days - 1) * 86_400_000)), to: day(now) };
}

/** The status text of a request: "200", "429 rate_limit_exceeded", "200 cut short". */
export function requestStatus(statusCode: number, errorCode: string | null): { text: string; tone: "ok" | "warn" | "error" } {
  if (statusCode >= 400) return { text: `${statusCode}${errorCode ? ` ${errorCode}` : ""}`, tone: "error" };
  if (errorCode === "stream_interrupted") return { text: `${statusCode} cut short`, tone: "warn" };
  return { text: String(statusCode), tone: "ok" };
}
