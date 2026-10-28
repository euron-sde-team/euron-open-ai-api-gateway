/** Pure helpers for the /admin control plane (tested in test/admin). No React, no fetching. */
import { isApiError } from "@open-gateway/api-client";
import type { ModelInput, RouteInput } from "@open-gateway/api-client";
import type { AdminModel, AppSettings, HealthRow, ModelKind, ModelPrice, ProviderKind, TopupStatus, UserRole, UserStatus } from "@open-gateway/types";
import { errorMessage } from "./errors";
import { bpsLabel, dollarsToMicros, percentToBps } from "./money";

// ─── Numbers and dates ──────────────────────────────────────────────────────

/** 12,345 */
export function formatCount(v: number, locale?: string): string {
  return new Intl.NumberFormat(locale).format(v);
}

/** "Mar 4, 2026" */
export function shortDate(iso: string | null | undefined, locale?: string): string {
  if (!iso) return "";
  const t = new Date(iso);
  return Number.isNaN(t.getTime()) ? "" : new Intl.DateTimeFormat(locale, { month: "short", day: "numeric", year: "numeric" }).format(t);
}

/** YYYY-MM-DD of a moment in UTC (the stats API counts UTC days). */
export function utcDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export const RANGE_PRESETS = [7, 30, 90] as const;
export type RangePreset = (typeof RANGE_PRESETS)[number];

/** The URL's ?range= as a preset; anything else is the 30 day default. */
export function parsePreset(v: string | null | undefined): RangePreset {
  const n = Number(v);
  return (RANGE_PRESETS as readonly number[]).includes(n) ? (n as RangePreset) : 30;
}

/** The last `days` UTC days, today included. */
export function presetRange(days: number, now = new Date()): { from: string; to: string } {
  const from = new Date(now.getTime() - (days - 1) * 86_400_000);
  return { from: utcDay(from), to: utcDay(now) };
}

/** A share as a percent: 0.0312 is "3.1%". Null when there is nothing to divide by. */
export function percentLabel(part: number, whole: number, locale?: string): string | null {
  if (!whole) return null;
  return new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 1 }).format(part / whole);
}

/** A 0 to 1 rate as a percent ("99.2%"), or null. */
export function rateLabel(rate: number | null | undefined, locale?: string): string | null {
  if (rate === null || rate === undefined) return null;
  return new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 1 }).format(rate);
}

// ─── Money inputs ───────────────────────────────────────────────────────────

/** Micro-USD as a plain dollar string for a form field: 2_500_000 is "2.5", 0 is "0". */
export function dollarsText(micros: number | null | undefined): string {
  if (micros === null || micros === undefined) return "";
  return String(Math.round(micros) / 1_000_000);
}

/** A signed dollar amount ("-4.20", "+10", "10") to micro-USD. Null when invalid or zero. */
export function parseSignedDollars(input: string): number | null {
  const t = input.trim().replace(/\s/g, "");
  const neg = t.startsWith("-");
  const m = dollarsToMicros(t.replace(/^[+-]/, ""));
  if (m === null || m === 0) return null;
  return neg ? -m : m;
}

/** Basis points as a percent string for a form field: 1500 is "15", null is "". */
export function marginText(bps: number | null | undefined): string {
  if (bps === null || bps === undefined) return "";
  return String(bps / 100);
}

/**
 * A margin field: empty means "no override" (null), otherwise a percent from 0 to 1000.
 * Undefined when the text is not a valid margin.
 */
export function parseMargin(text: string): number | null | undefined {
  if (!text.trim()) return null;
  const bps = percentToBps(text);
  return bps === null || bps > 100_000 ? undefined : bps;
}

/** "15%", "0% (at cost)", or "Default (15%)" for an unset override. */
export function marginLabel(bps: number | null, fallbackBps?: number): string {
  if (bps === null) return fallbackBps === undefined ? "Default" : `Default (${bpsLabel(fallbackBps, true)})`;
  return bpsLabel(bps, true);
}

// ─── Accounts ───────────────────────────────────────────────────────────────

export const ROLE_LABEL: Record<UserRole, string> = { USER: "User", ADMIN: "Admin" };

export const STATUS_LABEL: Record<UserStatus, string> = {
  ACTIVE: "Active",
  PENDING_VERIFICATION: "Not verified",
  SUSPENDED: "Suspended",
  BANNED: "Banned",
  DEACTIVATED: "Erased",
};

export type StatusTone = "success" | "warning" | "danger" | "muted";
export const STATUS_TONE: Record<UserStatus, StatusTone> = {
  ACTIVE: "success",
  PENDING_VERIFICATION: "muted",
  SUSPENDED: "warning",
  BANNED: "danger",
  DEACTIVATED: "muted",
};

/** Which account actions make sense for a target, given who is looking. Mirrors the API rules. */
export function accountActions(target: { id: string; role: UserRole; status: UserStatus }, actorId: string | undefined) {
  const self = target.id === actorId;
  const erased = target.status === "DEACTIVATED";
  const admin = target.role === "ADMIN";
  return {
    self,
    erased,
    makeAdmin: !self && !erased && !admin && target.status !== "BANNED",
    removeAdmin: !self && admin,
    // The API protects admins: demote first.
    suspend: !self && !erased && !admin && (target.status === "ACTIVE" || target.status === "PENDING_VERIFICATION"),
    unsuspend: !self && target.status === "SUSPENDED",
    ban: !self && !erased && !admin && target.status !== "BANNED",
    unban: !self && target.status === "BANNED",
    erase: !self && !erased && !admin,
  };
}

/** A credit form: GRANT takes a positive amount, ADJUSTMENT a signed one. Both need a reason. */
export function creditErrors(d: { type: "GRANT" | "ADJUSTMENT"; amount: string; reason: string }): { amount?: string; reason?: string } {
  const e: { amount?: string; reason?: string } = {};
  const m = parseSignedDollars(d.amount);
  if (m === null) e.amount = d.type === "GRANT" ? "Enter an amount in dollars, such as 10." : "Enter a dollar amount, with a minus sign to take credit away.";
  else if (d.type === "GRANT" && m < 0) e.amount = "A grant adds credit. Use an adjustment to take credit away.";
  if (d.reason.trim().length < 3) e.reason = "Write a reason of at least 3 characters.";
  return e;
}

// ─── Errors ─────────────────────────────────────────────────────────────────

/**
 * Admin-facing copy for an error. Our own copy for the guard rails; the server's exact
 * message for codes whose message names the thing in conflict; generic copy otherwise.
 */
const ADMIN_COPY: Record<string, string> = {
  LAST_ADMIN: "This is the last admin. Make someone else an admin first.",
  SELF_ACTION: "You cannot do this to your own account.",
  TARGET_PROTECTED: "Admins cannot be suspended, banned or erased. Remove their admin role first.",
  TIER_DEFAULT: "This is the default tier. Make another tier the default first.",
  TOPUP_NOT_PAID: "Only paid top-ups can be refunded.",
  PROVIDER_EXISTS: "A provider with this slug already exists.",
  MODEL_EXISTS: "A model with this id already exists.",
  ROUTE_EXISTS: "This model already has a route to that provider and upstream model.",
  PROMO_EXISTS: "A promo code with this code already exists.",
  BASE_URL_REQUIRED: "OpenAI compatible providers need a base URL.",
};
const SERVER_MESSAGE_CODES = new Set([
  "ALIAS_TAKEN",
  "INVALID_STATUS",
  "USER_ERASED",
  "ALREADY_ERASED",
  "DAYS_INVALID",
  "TIER_EXISTS",
  "BASE_URL_INVALID",
  "SECRET_INVALID",
  "AMOUNT_INVALID",
  "SETTINGS_INVALID",
]);

export function adminErrorMessage(e: unknown): string {
  if (isApiError(e)) {
    if (e.code === "MODEL_UNPRICED") return unpricedMessage(e.details);
    if (ADMIN_COPY[e.code]) return ADMIN_COPY[e.code]!;
    if (SERVER_MESSAGE_CODES.has(e.code) && e.message) return sentence(e.message);
  }
  return errorMessage(e);
}

/** Is this the API refusing to leave an enabled model without a priced route? */
export function isUnpriced(e: unknown): boolean {
  return isApiError(e) && e.code === "MODEL_UNPRICED";
}

/** The plain explanation for 409 MODEL_UNPRICED, naming the models when the API lists them. */
export function unpricedMessage(details: unknown): string {
  const models = (details as { models?: unknown } | null | undefined)?.models;
  const names = Array.isArray(models) ? models.filter((m): m is string => typeof m === "string") : [];
  const which = names.length ? `${names.join(", ")} ${names.length === 1 ? "is" : "are"} enabled` : "The model is enabled";
  return `${which} and would have no route it can bill through. An enabled model needs at least one enabled route with a cost above zero, on an enabled provider with an enabled credential. Add or fix a route first, or turn the model off.`;
}

const sentence = (s: string) => {
  const t = s.trim();
  return /[.!?]$/.test(t) ? t : `${t}.`;
};

// ─── Limits ─────────────────────────────────────────────────────────────────

/** "200,000" or "Unlimited". */
export function limitLabel(v: number | null, locale?: string): string {
  return v === null ? "Unlimited" : formatCount(v, locale);
}

/**
 * A limit input: empty means unlimited (null); otherwise a whole number from 1.
 * Returns undefined when the text is not a valid limit.
 */
export function parseLimit(text: string, max = 10_000_000): number | null | undefined {
  const t = text.replace(/[\s,_]/g, "");
  if (!t) return null;
  if (!/^\d+$/.test(t)) return undefined;
  const n = Number(t);
  return Number.isSafeInteger(n) && n >= 1 && n <= max ? n : undefined;
}

export function limitText(v: number | null | undefined): string {
  return v === null || v === undefined ? "" : String(v);
}

export type TierDraft = { name: string; rpm: string; tpm: string; concurrency: string; isDefault: boolean };

/** Field errors for a tier draft, matching the API's limits. */
export function tierDraftErrors(d: TierDraft): Partial<Record<"name" | "rpm" | "tpm" | "concurrency", string>> {
  const e: Partial<Record<"name" | "rpm" | "tpm" | "concurrency", string>> = {};
  if (!d.name.trim()) e.name = "Give the tier a name.";
  else if (d.name.trim().length > 60) e.name = "Use 60 characters or fewer.";
  if (parseLimit(d.rpm) === undefined) e.rpm = "A whole number from 1 to 10,000,000, or empty for unlimited.";
  if (parseLimit(d.tpm) === undefined) e.tpm = "A whole number from 1 to 10,000,000, or empty for unlimited.";
  if (parseLimit(d.concurrency, 10_000) === undefined) e.concurrency = "A whole number from 1 to 10,000, or empty for unlimited.";
  return e;
}

// ─── Providers ──────────────────────────────────────────────────────────────

export const PROVIDER_KIND_LABEL: Record<ProviderKind, string> = {
  OPENAI_COMPATIBLE: "OpenAI compatible",
  ANTHROPIC: "Anthropic",
  GEMINI: "Google Gemini",
  STUB: "Local stub",
};

/** Provider slugs, as the API accepts them: 3 to 40 lowercase letters, digits and inner hyphens. */
export const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;

export type ProviderDraft = { id: string; kind: ProviderKind; displayName: string; baseUrl: string; enabled: boolean };

export function providerDraftErrors(d: ProviderDraft, isNew: boolean): Partial<Record<"id" | "displayName" | "baseUrl", string>> {
  const e: Partial<Record<"id" | "displayName" | "baseUrl", string>> = {};
  if (isNew && !SLUG_RE.test(d.id)) e.id = "Use 3 to 40 lowercase letters, digits and hyphens.";
  if (!d.displayName.trim()) e.displayName = "Give it a name.";
  const url = d.baseUrl.trim();
  if (url && !/^https?:\/\/\S+$/i.test(url)) e.baseUrl = "Use an http or https URL.";
  else if (!url && d.kind === "OPENAI_COMPATIBLE") e.baseUrl = "OpenAI compatible providers need a base URL.";
  return e;
}

// ─── Models and routes ──────────────────────────────────────────────────────

export const MODEL_KINDS: { kind: ModelKind; label: string }[] = [
  { kind: "CHAT", label: "Chat" },
  { kind: "EMBEDDING", label: "Embedding" },
  { kind: "IMAGE", label: "Image" },
  { kind: "SPEECH", label: "Speech" },
  { kind: "TRANSCRIPTION", label: "Transcription" },
];
export const MODEL_KIND_LABEL = Object.fromEntries(MODEL_KINDS.map((k) => [k.kind, k.label])) as Record<ModelKind, string>;

/** Model ids and aliases, as the API accepts them. */
export const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,118}[A-Za-z0-9]$/;

export type CostField = "input" | "output" | "cached" | "unit";

/** The cost fields a model kind bills on, with their labels. Only these show in forms and tables. */
export const KIND_COSTS: Record<ModelKind, { field: CostField; label: string; short: string }[]> = {
  CHAT: [
    { field: "input", label: "Input, $ per 1M tokens", short: "in" },
    { field: "output", label: "Output, $ per 1M tokens", short: "out" },
    { field: "cached", label: "Cached input, $ per 1M tokens", short: "cached" },
  ],
  EMBEDDING: [{ field: "input", label: "Input, $ per 1M tokens", short: "in" }],
  IMAGE: [{ field: "unit", label: "$ per image", short: "per image" }],
  SPEECH: [{ field: "unit", label: "$ per 1M characters", short: "per 1M characters" }],
  TRANSCRIPTION: [{ field: "unit", label: "$ per minute of audio", short: "per minute" }],
};

/** A unit rate in dollars, exact to the micro: "$0.1725", "$2.50", "$0.006". Rates are small, so no rounding to cents. */
export function rateUsd(micros: number, locale?: string): string {
  return new Intl.NumberFormat(locale, { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 6 }).format(micros / 1_000_000);
}

type Prices = Pick<ModelPrice, "inputMicrosPerMtok" | "outputMicrosPerMtok" | "cachedMicrosPerMtok" | "unitMicros">;

/** "$2.50 in, $10.00 out / 1M tokens" or "$0.04 per image": a price or cost as one line, only the fields the kind bills on. */
export function priceLine(kind: ModelKind, p: Prices | null, locale?: string): string {
  if (!p) return "No usable route yet";
  if (kind === "CHAT" || kind === "EMBEDDING") {
    const parts = [`${rateUsd(p.inputMicrosPerMtok, locale)} in`];
    if (kind === "CHAT") {
      parts.push(`${rateUsd(p.outputMicrosPerMtok, locale)} out`);
      if (p.cachedMicrosPerMtok !== null) parts.push(`${rateUsd(p.cachedMicrosPerMtok, locale)} cached`);
    }
    return `${parts.join(", ")} / 1M tokens`;
  }
  return `${rateUsd(p.unitMicros, locale)} ${KIND_COSTS[kind][0]!.short}`;
}

/** Does a route cost something on the dimension its model bills on? (The API's own rule.) */
export function routePriced(kind: ModelKind, r: { inputMicrosPerMtok: number; outputMicrosPerMtok: number; unitMicros?: number }): boolean {
  if (kind === "CHAT") return r.inputMicrosPerMtok > 0 || r.outputMicrosPerMtok > 0;
  if (kind === "EMBEDDING") return r.inputMicrosPerMtok > 0;
  return (r.unitMicros ?? 0) > 0;
}

/** Models in catalogue order: sort order, then name. */
export function sortModels<T extends Pick<AdminModel, "sortOrder" | "displayName">>(models: readonly T[]): T[] {
  return [...models].sort((a, b) => a.sortOrder - b.sortOrder || a.displayName.localeCompare(b.displayName));
}

/** Split typed aliases (commas, spaces or new lines) into clean, unique entries, in order. */
export function parseAliases(text: string): string[] {
  return [...new Set(text.split(/[\s,;]+/).map((v) => v.trim()).filter(Boolean))];
}

export type ModelDraft = {
  id: string;
  kind: ModelKind;
  displayName: string;
  description: string;
  ownedBy: string;
  aliases: string;
  contextWindow: string;
  maxOutputTokens: string;
  supportsTools: boolean;
  supportsVision: boolean;
  supportsJson: boolean;
  margin: string;
  enabled: boolean;
  sortOrder: string;
};

export function modelToDraft(m: AdminModel | null, kind: ModelKind = "CHAT"): ModelDraft {
  if (!m)
    return {
      id: "", kind, displayName: "", description: "", ownedBy: "", aliases: "", contextWindow: "", maxOutputTokens: "",
      supportsTools: false, supportsVision: false, supportsJson: false, margin: "", enabled: false, sortOrder: "0",
    };
  return {
    id: m.id,
    kind: m.kind,
    displayName: m.displayName,
    description: m.description,
    ownedBy: m.ownedBy,
    aliases: m.aliases.join(", "),
    contextWindow: limitText(m.contextWindow),
    maxOutputTokens: limitText(m.maxOutputTokens),
    supportsTools: m.supportsTools,
    supportsVision: m.supportsVision,
    supportsJson: m.supportsJson,
    margin: marginText(m.marginBps),
    enabled: m.enabled,
    sortOrder: String(m.sortOrder),
  };
}

type ModelDraftKey = "id" | "displayName" | "description" | "ownedBy" | "aliases" | "contextWindow" | "maxOutputTokens" | "margin" | "sortOrder";

/** Field errors for a model draft, matching the API's limits. */
export function modelDraftErrors(d: ModelDraft, isNew: boolean): Partial<Record<ModelDraftKey, string>> {
  const e: Partial<Record<ModelDraftKey, string>> = {};
  if (isNew && !MODEL_ID_RE.test(d.id.trim())) e.id = "Letters, digits and . _ : / -, starting and ending with a letter or digit.";
  if (!d.displayName.trim()) e.displayName = "Give it a name developers will see.";
  else if (d.displayName.trim().length > 80) e.displayName = "Use 80 characters or fewer.";
  if (d.description.length > 300) e.description = "Use 300 characters or fewer.";
  if (d.ownedBy.length > 60) e.ownedBy = "Use 60 characters or fewer.";
  const aliases = parseAliases(d.aliases);
  if (aliases.length > 20) e.aliases = "Up to 20 aliases.";
  else if (aliases.some((a) => !MODEL_ID_RE.test(a))) e.aliases = "Each alias uses letters, digits and . _ : / -.";
  if (parseLimit(d.contextWindow, 100_000_000) === undefined) e.contextWindow = "A whole number of tokens, or leave it empty.";
  if (parseLimit(d.maxOutputTokens, 10_000_000) === undefined) e.maxOutputTokens = "A whole number of tokens, or leave it empty.";
  if (parseMargin(d.margin) === undefined) e.margin = "A percent from 0 to 1000, or empty to use the default.";
  if (!/^\d+$/.test(d.sortOrder.trim()) || Number(d.sortOrder) > 10_000) e.sortOrder = "Between 0 and 10,000.";
  return e;
}

/** The API body for a valid draft (without the id, which only goes on create). */
export function modelDraftBody(d: ModelDraft): Omit<ModelInput, "id"> {
  const chat = d.kind === "CHAT";
  return {
    kind: d.kind,
    displayName: d.displayName.trim(),
    description: d.description.trim(),
    ownedBy: d.ownedBy.trim(),
    aliases: parseAliases(d.aliases),
    contextWindow: parseLimit(d.contextWindow, 100_000_000) ?? null,
    maxOutputTokens: parseLimit(d.maxOutputTokens, 10_000_000) ?? null,
    // Capability flags only describe chat models.
    supportsTools: chat && d.supportsTools,
    supportsVision: chat && d.supportsVision,
    supportsJson: chat && d.supportsJson,
    marginBps: parseMargin(d.margin) ?? null,
    enabled: d.enabled,
    sortOrder: Number(d.sortOrder),
  };
}

export type RouteDraft = {
  providerId: string;
  upstreamModel: string;
  priority: string;
  /** Seconds, as typed. */
  timeout: string;
  input: string;
  output: string;
  cached: string;
  unit: string;
  enabled: boolean;
};

export function routeToDraft(r: AdminModel["routes"][number] | null, nextPriority = 1, providerId = ""): RouteDraft {
  if (!r) return { providerId, upstreamModel: "", priority: String(nextPriority), timeout: "60", input: "", output: "", cached: "", unit: "", enabled: true };
  return {
    providerId: r.providerId,
    upstreamModel: r.upstreamModel,
    priority: String(r.priority),
    timeout: String(r.timeoutMs / 1000),
    input: dollarsText(r.inputMicrosPerMtok),
    output: dollarsText(r.outputMicrosPerMtok),
    cached: dollarsText(r.cachedMicrosPerMtok),
    unit: dollarsText(r.unitMicros),
    enabled: r.enabled,
  };
}

/** A cost field: empty is zero (the cached price is null when empty). Undefined when invalid. */
const cost = (text: string): number | undefined => (text.trim() === "" ? 0 : (dollarsToMicros(text) ?? undefined));

type RouteDraftKey = "providerId" | "upstreamModel" | "priority" | "timeout" | CostField;

export function routeDraftErrors(d: RouteDraft, kind: ModelKind): Partial<Record<RouteDraftKey, string>> {
  const e: Partial<Record<RouteDraftKey, string>> = {};
  if (!d.providerId) e.providerId = "Pick a provider.";
  if (!d.upstreamModel.trim()) e.upstreamModel = "Enter the model id the provider expects.";
  else if (d.upstreamModel.trim().length > 160) e.upstreamModel = "Use 160 characters or fewer.";
  const p = Number(d.priority);
  if (!/^\d+$/.test(d.priority.trim()) || p < 1 || p > 100) e.priority = "Between 1 and 100. Lower is tried first.";
  const t = Number(d.timeout);
  if (!/^\d+(\.\d+)?$/.test(d.timeout.trim()) || t < 1 || t > 600) e.timeout = "Between 1 and 600 seconds.";
  for (const { field } of KIND_COSTS[kind]) if (cost(d[field]) === undefined) e[field] = "A dollar amount with up to six decimals.";
  return e;
}

/** The API body for a valid draft. Cost fields the kind does not bill on go as zero. */
export function routeDraftBody(d: RouteDraft, kind: ModelKind): RouteInput {
  const uses = new Set(KIND_COSTS[kind].map((c) => c.field));
  const val = (f: CostField) => (uses.has(f) ? (cost(d[f]) ?? 0) : 0);
  return {
    providerId: d.providerId,
    upstreamModel: d.upstreamModel.trim(),
    priority: Number(d.priority),
    timeoutMs: Math.round(Number(d.timeout) * 1000),
    inputMicrosPerMtok: val("input"),
    outputMicrosPerMtok: val("output"),
    cachedMicrosPerMtok: uses.has("cached") && d.cached.trim() !== "" ? val("cached") : null,
    unitMicros: val("unit"),
    enabled: d.enabled,
  };
}

// ─── Health ─────────────────────────────────────────────────────────────────

export const CIRCUIT_LABEL: Record<HealthRow["circuit"], string> = { closed: "Closed", open: "Open", "half-open": "Half open" };
export const CIRCUIT_TONE: Record<HealthRow["circuit"], StatusTone> = { closed: "success", open: "danger", "half-open": "warning" };
/** What each circuit state means, for tooltips and screen readers. */
export const CIRCUIT_HINT: Record<HealthRow["circuit"], string> = {
  closed: "Healthy: requests use this route.",
  open: "Skipped: requests fail over to the next route.",
  "half-open": "Probing: a few requests test whether it recovered.",
};

/** Health rows grouped by model, models by id, routes by priority. */
export function groupHealth(rows: readonly HealthRow[]): { modelId: string; routes: HealthRow[] }[] {
  const by = new Map<string, HealthRow[]>();
  for (const r of rows) by.set(r.modelId, [...(by.get(r.modelId) ?? []), r]);
  return [...by.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([modelId, routes]) => ({ modelId, routes: [...routes].sort((a, b) => a.priority - b.priority) }));
}

// ─── Billing ────────────────────────────────────────────────────────────────

export const TOPUP_STATUS_LABEL: Record<TopupStatus, string> = { CREATED: "Started", PAID: "Paid", FAILED: "Failed", REFUNDED: "Refunded" };
export const TOPUP_STATUS_TONE: Record<TopupStatus, StatusTone> = { CREATED: "muted", PAID: "success", FAILED: "danger", REFUNDED: "warning" };

export type PromoDraft = { code: string; amount: string; maxRedemptions: string; expires: string };

export function promoDraftErrors(d: PromoDraft, now = new Date()): Partial<Record<keyof PromoDraft, string>> {
  const e: Partial<Record<keyof PromoDraft, string>> = {};
  if (!/^[A-Za-z0-9_-]{3,40}$/.test(d.code.trim())) e.code = "3 to 40 letters, digits, hyphens or underscores.";
  const m = dollarsToMicros(d.amount);
  if (m === null || m < 1) e.amount = "An amount in dollars above zero.";
  if (parseLimit(d.maxRedemptions) === undefined) e.maxRedemptions = "A whole number, or empty for no limit.";
  if (d.expires) {
    const t = new Date(`${d.expires}T23:59:59Z`);
    if (Number.isNaN(t.getTime())) e.expires = "Pick a date.";
    else if (t.getTime() <= now.getTime()) e.expires = "Pick a date in the future.";
  }
  return e;
}

/** The create body for a valid promo draft. A date expires at the end of that UTC day. */
export function promoDraftBody(d: PromoDraft) {
  return {
    code: d.code.trim(),
    amountMicros: dollarsToMicros(d.amount) ?? 0,
    maxRedemptions: parseLimit(d.maxRedemptions) ?? null,
    expiresAt: d.expires ? new Date(`${d.expires}T23:59:59Z`).toISOString() : null,
  };
}

/** Can people still redeem it? */
export function promoState(p: { active: boolean; expiresAt: string | null; maxRedemptions: number | null; redeemedCount: number }, now = new Date()): { label: string; tone: StatusTone } {
  if (!p.active) return { label: "Off", tone: "muted" };
  if (p.expiresAt && new Date(p.expiresAt).getTime() <= now.getTime()) return { label: "Expired", tone: "muted" };
  if (p.maxRedemptions !== null && p.redeemedCount >= p.maxRedemptions) return { label: "Used up", tone: "muted" };
  return { label: "Active", tone: "success" };
}

// ─── Settings ───────────────────────────────────────────────────────────────

/** The settings form: every number kept as typed, in the unit people think in (dollars, percent). */
export interface SettingsForm {
  appName: string;
  tagline: string;
  registration: AppSettings["registration"];
  allowedEmailDomains: string[];
  supportEmail: string;
  gatewayBaseUrl: string;
  defaultMargin: string;
  signupCredit: string;
  tax: string;
  taxLabel: string;
  usdMin: string;
  usdMax: string;
  inrMin: string;
  inrMax: string;
  lowBalance: string;
  bodyRetentionDays: string;
  requestRetentionDays: string;
  minSupportedVersion: string;
}

export function toSettingsForm(s: AppSettings): SettingsForm {
  return {
    appName: s.appName,
    tagline: s.tagline,
    registration: s.registration,
    allowedEmailDomains: [...s.allowedEmailDomains],
    supportEmail: s.supportEmail ?? "",
    gatewayBaseUrl: s.gatewayBaseUrl,
    defaultMargin: marginText(s.defaultMarginBps),
    signupCredit: dollarsText(s.signupCreditMicros),
    tax: marginText(s.taxBps),
    taxLabel: s.taxLabel,
    usdMin: String(s.topupLimits.usdMin),
    usdMax: String(s.topupLimits.usdMax),
    inrMin: String(s.topupLimits.inrMin),
    inrMax: String(s.topupLimits.inrMax),
    lowBalance: dollarsText(s.lowBalanceMicros),
    bodyRetentionDays: String(s.bodyRetentionDays),
    requestRetentionDays: limitText(s.requestRetentionDays),
    minSupportedVersion: s.minSupportedVersion ?? "",
  };
}

const num = (t: string) => (/^\d+(\.\d+)?$/.test(t.trim()) ? Number(t.trim()) : NaN);
const int = (t: string) => (/^\d+$/.test(t.trim()) ? Number(t.trim()) : NaN);

/** Back to AppSettings. Invalid fields come out as NaN; check settingsErrors first. */
export function fromSettingsForm(f: SettingsForm): AppSettings {
  return {
    appName: f.appName.trim(),
    tagline: f.tagline.trim(),
    registration: f.registration,
    allowedEmailDomains: f.allowedEmailDomains,
    supportEmail: f.supportEmail.trim() || null,
    gatewayBaseUrl: f.gatewayBaseUrl.trim(),
    defaultMarginBps: percentToBps(f.defaultMargin) ?? NaN,
    signupCreditMicros: dollarsToMicros(f.signupCredit) ?? NaN,
    taxBps: percentToBps(f.tax) ?? NaN,
    taxLabel: f.taxLabel.trim(),
    topupLimits: { usdMin: num(f.usdMin), usdMax: num(f.usdMax), inrMin: num(f.inrMin), inrMax: num(f.inrMax) },
    lowBalanceMicros: dollarsToMicros(f.lowBalance) ?? NaN,
    bodyRetentionDays: int(f.bodyRetentionDays),
    requestRetentionDays: f.requestRetentionDays.trim() === "" ? null : int(f.requestRetentionDays),
    minSupportedVersion: f.minSupportedVersion.trim() || null,
  };
}

export type SettingsField = keyof SettingsForm;

/** Field problems in a form, by field, matching the server's rules. */
export function settingsErrors(f: SettingsForm): Partial<Record<SettingsField, string>> {
  const s = fromSettingsForm(f);
  const e: Partial<Record<SettingsField, string>> = {};
  const between = (v: number, lo: number, hi: number) => Number.isFinite(v) && v >= lo && v <= hi;
  if (!s.appName) e.appName = "Give the app a name.";
  else if (s.appName.length > 60) e.appName = "Use 60 characters or fewer.";
  if (s.tagline.length > 160) e.tagline = "Use 160 characters or fewer.";
  if (s.supportEmail !== null && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.supportEmail)) e.supportEmail = "Enter a valid email address, or leave it empty.";
  if (s.registration === "INVITE_ONLY" && !s.allowedEmailDomains.length) e.allowedEmailDomains = "Invite-only sign-up needs at least one allowed domain.";
  if (!/^https?:\/\/\S+$/i.test(s.gatewayBaseUrl)) e.gatewayBaseUrl = "An http or https URL, such as https://api.example.com/v1.";
  if (!between(s.defaultMarginBps, 0, 100_000)) e.defaultMargin = "A percent from 0 to 1000.";
  if (!between(s.signupCreditMicros, 0, 1_000_000_000)) e.signupCredit = "A dollar amount from 0 to 1,000.";
  if (!between(s.taxBps, 0, 5_000)) e.tax = "A percent from 0 to 50.";
  if (!s.taxLabel) e.taxLabel = "Name the tax, such as GST or VAT.";
  else if (s.taxLabel.length > 30) e.taxLabel = "Use 30 characters or fewer.";
  const { usdMin, usdMax, inrMin, inrMax } = s.topupLimits;
  if (!between(usdMin, 1, 100_000)) e.usdMin = "From 1 to 100,000.";
  if (!between(usdMax, 1, 100_000)) e.usdMax = "From 1 to 100,000.";
  else if (Number.isFinite(usdMin) && usdMax < usdMin) e.usdMax = "At least the minimum.";
  if (!between(inrMin, 1, 10_000_000)) e.inrMin = "From 1 to 10,000,000.";
  if (!between(inrMax, 1, 10_000_000)) e.inrMax = "From 1 to 10,000,000.";
  else if (Number.isFinite(inrMin) && inrMax < inrMin) e.inrMax = "At least the minimum.";
  if (!between(s.lowBalanceMicros, 0, 1_000_000_000)) e.lowBalance = "A dollar amount from 0 to 1,000. 0 turns the email off.";
  if (!(Number.isInteger(s.bodyRetentionDays) && between(s.bodyRetentionDays, 1, 90))) e.bodyRetentionDays = "Between 1 and 90 days.";
  if (s.requestRetentionDays !== null && !(Number.isInteger(s.requestRetentionDays) && between(s.requestRetentionDays, 30, 3650))) e.requestRetentionDays = "Between 30 and 3,650 days, or empty to keep them.";
  if (s.minSupportedVersion !== null && !/^\d+\.\d+\.\d+$/.test(s.minSupportedVersion)) e.minSupportedVersion = "Use a version like 1.4.0, or leave it empty.";
  return e;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * The PATCH body for a valid draft: only the keys that changed, with nested groups
 * (topupLimits) narrowed to their changed keys. The server merges key by key.
 */
export function settingsPatch(base: AppSettings, draft: AppSettings): Partial<AppSettings> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(draft) as (keyof AppSettings)[]) {
    const a = base[key];
    const b = draft[key];
    if (same(a, b)) continue;
    if (a && b && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)) {
      const ao = a as unknown as Record<string, unknown>;
      out[key] = Object.fromEntries(Object.entries(b as unknown as Record<string, unknown>).filter(([k, v]) => !same(ao[k], v)));
    } else out[key] = b;
  }
  return out as Partial<AppSettings>;
}

export type SettingsGroup = "general" | "signup" | "pricing" | "billing" | "data";

export const SETTINGS_GROUP_LABEL: Record<SettingsGroup, string> = { general: "General", signup: "Sign-up", pricing: "Pricing", billing: "Top-ups", data: "Data" };

export const SETTINGS_GROUP_KEYS: Record<SettingsGroup, (keyof AppSettings)[]> = {
  general: ["appName", "tagline", "supportEmail", "gatewayBaseUrl", "minSupportedVersion"],
  signup: ["registration", "allowedEmailDomains", "signupCreditMicros"],
  pricing: ["defaultMarginBps"],
  billing: ["taxBps", "taxLabel", "topupLimits", "lowBalanceMicros"],
  data: ["bodyRetentionDays", "requestRetentionDays"],
};

/** Which form groups have unsaved changes. */
export function dirtyGroups(base: AppSettings, draft: AppSettings): SettingsGroup[] {
  const patch = settingsPatch(base, draft);
  return (Object.keys(SETTINGS_GROUP_KEYS) as SettingsGroup[]).filter((g) => SETTINGS_GROUP_KEYS[g].some((k) => k in patch));
}

/** Split a pasted list of domains (commas, spaces or new lines) into clean, unique entries. */
export function parseDomains(input: string, existing: readonly string[] = []): { added: string[]; invalid: string[] } {
  const seen = new Set(existing);
  const added: string[] = [];
  const invalid: string[] = [];
  for (const raw of input.split(/[\s,;]+/)) {
    const d = raw.trim().toLowerCase().replace(/^@/, "").replace(/^https?:\/\//, "").replace(/\/.*$/, "");
    if (!d) continue;
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(d)) invalid.push(raw.trim());
    else if (!seen.has(d)) {
      seen.add(d);
      added.push(d);
    }
  }
  return { added, invalid };
}

// ─── Audit ──────────────────────────────────────────────────────────────────

/** Plain labels for the actions the gateway records. Anything else is humanized. */
const ACTION_LABEL: Record<string, string> = {
  "key.created": "Created an API key",
  "key.updated": "Changed an API key",
  "key.revoked": "Revoked an API key",
  "key.margin": "Set a key margin",
  "topup.created": "Started a top-up",
  "topup.paid": "Top-up paid",
  "topup.refunded": "Refunded a top-up",
  "wallet.grant": "Granted credit",
  "wallet.adjustment": "Adjusted a balance",
  "provider.created": "Added a provider",
  "provider.updated": "Changed a provider",
  "provider.deleted": "Deleted a provider",
  "credential.added": "Added a credential",
  "credential.enabled": "Turned a credential on",
  "credential.disabled": "Turned a credential off",
  "credential.deleted": "Deleted a credential",
  "model.created": "Added a model",
  "model.updated": "Changed a model",
  "model.deleted": "Deleted a model",
  "route.created": "Added a route",
  "route.updated": "Changed a route",
  "route.deleted": "Deleted a route",
  "route.circuit_open": "Forced a circuit open",
  "route.circuit_closed": "Forced a circuit closed",
  "tier.created": "Added a tier",
  "tier.updated": "Changed a tier",
  "tier.deleted": "Deleted a tier",
  "promo.created": "Created a promo code",
  "promo.activated": "Turned a promo code on",
  "promo.deactivated": "Turned a promo code off",
  "promo.redeemed": "Redeemed a promo code",
  "settings.update": "Changed settings",
  "user.role": "Changed a role",
  "user.tier": "Changed a tier",
  "user.margin": "Set an account margin",
  "user.suspend": "Suspended an account",
  "user.unsuspend": "Lifted a suspension",
  "user.ban": "Banned an account",
  "user.unban": "Unbanned an account",
  "user.erase": "Erased an account",
  "user.signup": "Signed up",
  "user.login": "Signed in",
};

/** "wallet.grant" to "Granted credit"; unknown actions read as words ("user.email_verified" to "User email verified"). */
export function humanizeAction(action: string): string {
  if (ACTION_LABEL[action]) return ACTION_LABEL[action]!;
  const s = action.replace(/[._]/g, " ").trim();
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

/** Pretty JSON for the audit detail (stable key order, two-space indent). */
export function prettyJson(v: unknown): string {
  const sort = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(sort);
    if (x && typeof x === "object") return Object.fromEntries(Object.keys(x as Record<string, unknown>).sort().map((k) => [k, sort((x as Record<string, unknown>)[k])]));
    return x;
  };
  return JSON.stringify(sort(v), null, 2);
}
