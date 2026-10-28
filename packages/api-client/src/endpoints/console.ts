/** The developer console: keys, wallet, ledger, top-ups, credits, catalogue, usage and preferences. */
import type {
  ApiKey,
  ApiKeyInput,
  CreatedApiKey,
  LedgerEntry,
  ModelInfo,
  Page,
  RazorpayVerifyInput,
  RequestDetail,
  RequestRow,
  Topup,
  TopupInput,
  TopupOrder,
  UsageQuery,
  UsageSummary,
  Wallet,
} from "@open-gateway/types";
import { enc, type Helpers, type PageQuery } from "./helpers";

export function consoleEndpoints(h: Helpers) {
  const { get, post, patch, del, pq, pub, download } = h;

  const keys = {
    list: () => get<ApiKey[]>("/keys"),
    /** The secret is in the response, once. */
    create: (body: ApiKeyInput) => post<CreatedApiKey>("/keys", body),
    update: (id: string, body: Partial<ApiKeyInput>) => patch<ApiKey>(`/keys/${enc(id)}`, body),
    revoke: (id: string) => del(`/keys/${enc(id)}`),
  };

  const billing = {
    wallet: () => get<Wallet>("/billing/wallet"),
    ledger: (q: PageQuery & { type?: string } = {}) => get<Page<LedgerEntry>>("/billing/ledger", pq(q)),
    topups: (q: PageQuery = {}) => get<Page<Topup>>("/billing/topups", pq(q)),
    /** Create a top-up order; open its `checkout`. 400 TOPUP_AMOUNT, 409 GATEWAY_UNAVAILABLE. */
    createTopup: (body: TopupInput) => post<TopupOrder>("/billing/topups", body),
    /** Razorpay checkout.js success callback. Crediting is idempotent with the webhook. */
    verifyRazorpay: (body: RazorpayVerifyInput) => post<Topup>("/billing/razorpay/verify", body),
    topup: (id: string) => get<Topup>(`/billing/topups/${enc(id)}`),
    /** Development only (PAYMENTS_STUB): confirm a stub top-up as if the gateway had paid. */
    confirmStub: (id: string) => post<Topup>(`/billing/topups/${enc(id)}/stub-confirm`, {}),
    receipt: (id: string) => download(`/billing/topups/${enc(id)}/receipt.pdf`),
    /** 404 PROMO_NOT_FOUND, 409 PROMO_USED, 410 PROMO_EXPIRED. */
    redeem: (code: string) => post<{ creditedMicros: number; wallet: Wallet }>("/billing/promo", { code }),
  };

  const models = {
    /** The catalogue with the prices callers pay (at this account's margin when signed in). */
    list: (signal?: AbortSignal) => pub<ModelInfo[]>("/catalog", undefined, signal),
  };

  const usage = {
    summary: (q: UsageQuery = {}) => get<UsageSummary>("/usage/summary", pq(q)),
    requests: (q: PageQuery & { apiKeyId?: string; modelId?: string; status?: "ok" | "error" } = {}) => get<Page<RequestRow>>("/usage/requests", pq(q)),
    request: (id: string) => get<RequestDetail>(`/usage/requests/${enc(id)}`),
  };

  return { keys, billing, models, usage };
}
