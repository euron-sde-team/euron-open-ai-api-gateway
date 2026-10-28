/** The developer console contract: keys, wallet, ledger, top-ups, credits, the model catalogue and usage. Re-exported from index.ts. */

/** Money is integer micro-USD everywhere (1 USD = 1 000 000). */
export type Micros = number;

export type ModelKind = "CHAT" | "EMBEDDING" | "IMAGE" | "SPEECH" | "TRANSCRIPTION";
export type LedgerType = "TOPUP" | "GRANT" | "PROMO" | "SIGNUP" | "USAGE" | "REFUND" | "ADJUSTMENT";
export type PaymentGateway = "STRIPE" | "RAZORPAY" | "STUB";
export type TopupStatus = "CREATED" | "PAID" | "FAILED" | "REFUNDED";
export type Currency = "USD" | "INR";

// ─── Keys ───────────────────────────────────────────────────────────────────

export interface ApiKey {
  id: string;
  name: string;
  /** "gw-a1b2...9xyz": enough to recognise a key, never enough to use it. */
  hint: string;
  status: "ACTIVE" | "REVOKED";
  expiresAt: string | null;
  /** Empty: every enabled model. */
  allowedModels: string[];
  monthlyBudgetMicros: Micros | null;
  /** Spent with this key since the 1st of this month (UTC). */
  spentThisMonthMicros: Micros;
  rpm: number | null;
  tpm: number | null;
  ipAllowlist: string[];
  logBodies: boolean;
  lastUsedAt: string | null;
  createdAt: string;
  revokedAt: string | null;
}

/** POST /api/keys returns the key once. Store it now: it cannot be shown again. */
export interface CreatedApiKey extends ApiKey {
  secret: string;
}

export interface ApiKeyInput {
  name: string;
  expiresAt?: string | null;
  allowedModels?: string[];
  monthlyBudgetMicros?: Micros | null;
  rpm?: number | null;
  tpm?: number | null;
  ipAllowlist?: string[];
  logBodies?: boolean;
}

// ─── Wallet and ledger ──────────────────────────────────────────────────────

export interface Wallet {
  balanceMicros: Micros;
  /** On hold for requests in flight. */
  reservedMicros: Micros;
  availableMicros: Micros;
  /** For display only: the balance in INR at today's rate. */
  balanceInr: number;
  inrPerUsd: number;
}

export interface LedgerEntry {
  id: string;
  type: LedgerType;
  amountMicros: Micros;
  balanceAfterMicros: Micros;
  description: string;
  createdAt: string;
}

// ─── Top-ups ────────────────────────────────────────────────────────────────

/** POST /api/billing/topups. `amount` is in major units (dollars or rupees) before tax. */
export interface TopupInput {
  currency: Currency;
  amount: number;
}

/** What the browser needs to open the gateway's checkout. */
export interface TopupOrder {
  id: string;
  gateway: PaymentGateway;
  currency: Currency;
  amountMinor: number;
  taxMinor: number;
  totalMinor: number;
  /** The rate locked for this order (INR only). */
  inrPerUsd: number | null;
  creditMicros: Micros;
  /** Stripe: a Checkout session URL. Razorpay: the order id and public key for checkout.js. Stub: a local confirm URL. */
  checkout: { kind: "redirect"; url: string } | { kind: "razorpay"; orderId: string; keyId: string; amount: number; currency: string } | { kind: "stub"; confirmUrl: string };
}

export interface Topup {
  id: string;
  gateway: PaymentGateway;
  currency: Currency;
  amountMinor: number;
  taxMinor: number;
  totalMinor: number;
  inrPerUsd: number | null;
  creditMicros: Micros;
  status: TopupStatus;
  createdAt: string;
  paidAt: string | null;
}

/** POST /api/billing/razorpay/verify: the fields Razorpay checkout.js returns. */
export interface RazorpayVerifyInput {
  orderId: string;
  paymentId: string;
  signature: string;
}

// ─── Catalogue ──────────────────────────────────────────────────────────────

/** What a caller pays, after the margin. Token prices per million tokens. */
export interface ModelPrice {
  inputMicrosPerMtok: Micros;
  outputMicrosPerMtok: Micros;
  cachedMicrosPerMtok: Micros | null;
  /** Per image, per million characters or per minute, by kind. */
  unitMicros: Micros;
}

export interface ModelInfo {
  id: string;
  kind: ModelKind;
  displayName: string;
  description: string;
  ownedBy: string;
  aliases: string[];
  contextWindow: number | null;
  maxOutputTokens: number | null;
  supportsTools: boolean;
  supportsVision: boolean;
  supportsJson: boolean;
  price: ModelPrice;
  /** How many upstream routes can serve it (failover depth). */
  routes: number;
}

// ─── Usage ──────────────────────────────────────────────────────────────────

export interface UsageQuery {
  from?: string;
  to?: string;
  apiKeyId?: string;
  modelId?: string;
}

export interface UsageSummary {
  from: string;
  to: string;
  totals: { requests: number; errors: number; inputTokens: number; outputTokens: number; spendMicros: Micros; avgLatencyMs: number | null };
  daily: { date: string; requests: number; errors: number; spendMicros: Micros }[];
  byModel: { modelId: string; requests: number; inputTokens: number; outputTokens: number; spendMicros: Micros }[];
  byKey: { apiKeyId: string | null; name: string; requests: number; spendMicros: Micros }[];
}

export interface RequestRow {
  id: string;
  apiKeyId: string | null;
  apiKeyName: string | null;
  modelId: string;
  endpoint: string;
  stream: boolean;
  statusCode: number;
  errorCode: string | null;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  units: number;
  estimated: boolean;
  latencyMs: number | null;
  ttfbMs: number | null;
  priceMicros: Micros;
  createdAt: string;
  /** True when this request's bodies were kept (the key logs bodies) and have not expired. */
  hasBodies: boolean;
}

export interface RequestDetail extends RequestRow {
  attempts: number;
  bodies: { request: unknown; response: unknown } | null;
}
