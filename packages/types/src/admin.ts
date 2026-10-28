/** The /admin control plane. Re-exported from index.ts. */
import type { UserRole, UserStatus, UserSummary } from "./index";
import type { Currency, Micros, ModelKind, PaymentGateway, TopupStatus } from "./gateway";

export type ProviderKind = "OPENAI_COMPATIBLE" | "ANTHROPIC" | "GEMINI" | "STUB";

/** GET /api/admin/me. */
export interface AdminSession {
  role: UserRole;
}

// ─── Overview ───────────────────────────────────────────────────────────────

/** GET /api/admin/stats?from=&to=: the overview, UTC days. */
export interface AdminStats {
  from: string;
  to: string;
  totals: { users: number; newUsers: number; activeAccounts: number; requests: number; errors: number; revenueMicros: Micros; costMicros: Micros; marginMicros: Micros; topupsMicros: Micros; creditsGrantedMicros: Micros };
  daily: { date: string; requests: number; errors: number; revenueMicros: Micros; costMicros: Micros }[];
  byModel: { modelId: string; requests: number; errors: number; inputTokens: number; outputTokens: number; revenueMicros: Micros; costMicros: Micros; p50LatencyMs: number | null; p95LatencyMs: number | null; p50TtfbMs: number | null }[];
  byProvider: { providerId: string; requests: number; errors: number; failovers: number; p50LatencyMs: number | null; p95LatencyMs: number | null }[];
}

// ─── Users ──────────────────────────────────────────────────────────────────

export interface AdminUserRow extends UserSummary {
  email: string;
  status: UserStatus;
  limitTier: { id: string; name: string } | null;
  createdAt: string;
  lastSeenAt: string | null;
  suspendedUntil: string | null;
  balanceMicros: Micros;
  spentThisMonthMicros: Micros;
  /** Account margin override in basis points; null uses the model's or the default. */
  marginBps: number | null;
}

export interface AdminUserDetail extends AdminUserRow {
  reservedMicros: Micros;
  keys: { id: string; name: string; hint: string; status: "ACTIVE" | "REVOKED"; marginBps: number | null; lastUsedAt: string | null }[];
  totals: { requests: number; spendMicros: Micros; topupsMicros: Micros; creditsMicros: Micros };
  /** The last 30 UTC days. */
  usage: { date: string; requests: number; spendMicros: Micros }[];
}

/** Rate-limit tiers. Null means unlimited. */
export interface LimitTier {
  id: string;
  name: string;
  rpm: number | null;
  tpm: number | null;
  concurrency: number | null;
  isDefault: boolean;
  userCount: number;
}

// ─── Providers and models ───────────────────────────────────────────────────

export interface AdminProvider {
  id: string;
  kind: ProviderKind;
  displayName: string;
  baseUrl: string | null;
  enabled: boolean;
  /** Credentials, never the secret: a label and the last four characters. */
  credentials: { id: string; label: string; last4: string; enabled: boolean; disabledReason: string | null; createdAt: string }[];
  routeCount: number;
}

export interface ModelRoute {
  id: string;
  providerId: string;
  upstreamModel: string;
  priority: number;
  timeoutMs: number;
  /** What the provider charges the platform (cost), micro-USD per million tokens or per unit. */
  inputMicrosPerMtok: Micros;
  outputMicrosPerMtok: Micros;
  cachedMicrosPerMtok: Micros | null;
  unitMicros: Micros;
  enabled: boolean;
  /** Live circuit state: closed (healthy), open (skipped), half-open (probing). */
  circuit: "closed" | "open" | "half-open";
  lastCheck: { ok: boolean; latencyMs: number | null; error: string | null; checkedAt: string } | null;
}

export interface AdminModel {
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
  /** Null uses the default margin. */
  marginBps: number | null;
  /** The margin in force and the price callers pay (primary route cost x (1 + margin)). */
  effectiveMarginBps: number;
  price: { inputMicrosPerMtok: Micros; outputMicrosPerMtok: Micros; cachedMicrosPerMtok: Micros | null; unitMicros: Micros } | null;
  enabled: boolean;
  sortOrder: number;
  routes: ModelRoute[];
}

/** POST /api/admin/models/:id/test: one tiny call through the real provider. */
export interface ModelTestResult {
  ok: boolean;
  latencyMs: number;
  /** A short, key-free description of what happened. */
  message: string;
}

// ─── Settings ───────────────────────────────────────────────────────────────

export interface AppSettings {
  appName: string;
  tagline: string;
  registration: "OPEN" | "INVITE_ONLY" | "CLOSED";
  allowedEmailDomains: string[];
  supportEmail: string | null;
  /** The public base URL shown to developers, including /v1. */
  gatewayBaseUrl: string;
  /** Margin applied when neither the key, the account nor the model sets one (basis points, 0 and up). */
  defaultMarginBps: number;
  /** Credit every new verified account receives, micro-USD. */
  signupCreditMicros: Micros;
  /** Tax added on top of a top-up, basis points, and how it is labelled on receipts. */
  taxBps: number;
  taxLabel: string;
  topupLimits: { usdMin: number; usdMax: number; inrMin: number; inrMax: number };
  /** Email the account when its available balance drops below this, micro-USD (0 turns it off). */
  lowBalanceMicros: Micros;
  /** Days request bodies are kept for keys that log them. */
  bodyRetentionDays: number;
  /** Days request rows are kept (null keeps them). */
  requestRetentionDays: number | null;
  minSupportedVersion: string | null;
}

/** What this deployment has configured. Never a secret. */
export interface IntegrationStatus {
  mail: { mode: "outbox" | "smtp" | "ses" };
  payments: { stripe: boolean; razorpay: boolean; stub: boolean };
  fx: { inrPerUsd: number; source: string; fetchedAt: string | null };
  credentialsKeyConfigured: boolean;
}

export interface AdminTopupRow {
  id: string;
  owner: UserSummary;
  gateway: PaymentGateway;
  currency: Currency;
  totalMinor: number;
  creditMicros: Micros;
  status: TopupStatus;
  createdAt: string;
  paidAt: string | null;
}

export interface PromoCode {
  id: string;
  code: string;
  amountMicros: Micros;
  maxRedemptions: number | null;
  redeemedCount: number;
  expiresAt: string | null;
  active: boolean;
  createdAt: string;
}

/** GET /api/admin/health: every route with its circuit and recent probes. */
export interface HealthRow {
  routeId: string;
  modelId: string;
  providerId: string;
  upstreamModel: string;
  priority: number;
  enabled: boolean;
  circuit: "closed" | "open" | "half-open";
  successRate24h: number | null;
  p50LatencyMs24h: number | null;
  checks: { ok: boolean; latencyMs: number | null; error: string | null; checkedAt: string }[];
}

// ─── Audit ───────────────────────────────────────────────────────

export interface AuditEntry {
  id: string;
  actor: UserSummary | null;
  action: string;
  entityType: string;
  entityId: string | null;
  data: Record<string, unknown>;
  createdAt: string;
}
