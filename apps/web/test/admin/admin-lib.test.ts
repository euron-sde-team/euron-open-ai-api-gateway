import { describe, expect, it } from "vitest";
import { ApiError } from "@open-gateway/api-client";
import type { AdminModel, AppSettings, HealthRow } from "@open-gateway/types";
import {
  accountActions, adminErrorMessage, creditErrors, dirtyGroups, dollarsText, fromSettingsForm, groupHealth, humanizeAction, isUnpriced, limitLabel, marginText, modelDraftBody, modelDraftErrors,
  modelToDraft, parseAliases, parseDomains, parseLimit, parseMargin, parsePreset, parseSignedDollars, percentLabel, presetRange, priceLine, promoDraftBody, promoDraftErrors, promoState,
  providerDraftErrors, rateLabel, routeDraftBody, routeDraftErrors, routePriced, routeToDraft, settingsErrors, settingsPatch, sortModels, tierDraftErrors, toSettingsForm,
} from "@/lib/admin";
import { ADMIN_NAV, activeNavHref, navLabel } from "@/components/admin/shell/nav";
import { auditAction } from "@/components/admin/pages/audit";
import { totals } from "@/components/admin/pages/overview";

const settings: AppSettings = {
  appName: "Open Gateway",
  tagline: "Every model, one key",
  registration: "OPEN",
  allowedEmailDomains: [],
  supportEmail: null,
  gatewayBaseUrl: "https://api.example.com/v1",
  defaultMarginBps: 1500,
  signupCreditMicros: 1_000_000,
  taxBps: 1800,
  taxLabel: "GST",
  topupLimits: { usdMin: 5, usdMax: 1000, inrMin: 500, inrMax: 100000 },
  lowBalanceMicros: 2_000_000,
  bodyRetentionDays: 7,
  requestRetentionDays: null,
  minSupportedVersion: null,
};

const model = (over: Partial<AdminModel> = {}): AdminModel => ({
  id: "gpt-4o-mini",
  kind: "CHAT",
  displayName: "GPT-4o mini",
  description: "",
  ownedBy: "openai",
  aliases: [],
  contextWindow: 128000,
  maxOutputTokens: 16384,
  supportsTools: true,
  supportsVision: true,
  supportsJson: true,
  marginBps: null,
  effectiveMarginBps: 1500,
  price: { inputMicrosPerMtok: 172_500, outputMicrosPerMtok: 690_000, cachedMicrosPerMtok: null, unitMicros: 0 },
  enabled: true,
  sortOrder: 0,
  routes: [],
  ...over,
});

describe("navigation", () => {
  it("lists the gateway areas in order", () => {
    expect(ADMIN_NAV.map((i) => i.label)).toEqual(["Overview", "Users", "Providers", "Models", "Health", "Billing", "Limits", "Settings", "Audit log"]);
  });
  it("matches the longest href, and /admin only itself", () => {
    expect(activeNavHref("/admin")).toBe("/admin");
    expect(activeNavHref("/admin/users/abc")).toBe("/admin/users");
    expect(activeNavHref("/admin/usersx")).toBeNull();
    expect(navLabel("/admin/topups")).toBe("Billing");
    expect(navLabel("/admin/tiers")).toBe("Limits");
  });
});

describe("numbers and ranges", () => {
  it("parses presets and falls back to 30 days", () => {
    expect(parsePreset("7")).toBe(7);
    expect(parsePreset("12")).toBe(30);
  });
  it("counts UTC days, today included", () => {
    expect(presetRange(7, new Date("2026-10-27T23:30:00Z"))).toEqual({ from: "2026-10-21", to: "2026-10-27" });
  });
  it("labels shares and rates", () => {
    expect(percentLabel(31, 1000, "en-US")).toBe("3.1%");
    expect(percentLabel(1, 0)).toBeNull();
    expect(rateLabel(0.992, "en-US")).toBe("99.2%");
    expect(rateLabel(null)).toBeNull();
  });
  it("builds the overview stat line from micros", () => {
    const items = totals({
      from: "2026-10-01",
      to: "2026-10-30",
      totals: { users: 40, newUsers: 5, activeAccounts: 12, requests: 1000, errors: 25, revenueMicros: 11_500_000, costMicros: 10_000_000, marginMicros: 1_500_000, topupsMicros: 50_000_000, creditsGrantedMicros: 3_000_000 },
      daily: [],
      byModel: [],
      byProvider: [],
    });
    const by = Object.fromEntries(items.map((i) => [i.label, i]));
    expect(by["Error rate"]!.value).toMatch(/^2\.5%$/);
    expect(by["Revenue"]!.value).toBe("$11.50");
    expect(by["Gross margin"]!.value).toBe("$1.50");
    expect(by["Gross margin"]!.hint).toMatch(/^13%$/);
    expect(by["Active accounts"]!.hint).toBe("of 40");
  });
});

describe("money inputs", () => {
  it("writes micros as plain dollars for fields", () => {
    expect(dollarsText(2_500_000)).toBe("2.5");
    expect(dollarsText(75_000)).toBe("0.075");
    expect(dollarsText(0)).toBe("0");
    expect(dollarsText(null)).toBe("");
  });
  it("reads signed dollar amounts", () => {
    expect(parseSignedDollars("10")).toBe(10_000_000);
    expect(parseSignedDollars("+1.5")).toBe(1_500_000);
    expect(parseSignedDollars("-4.20")).toBe(-4_200_000);
    expect(parseSignedDollars("0")).toBeNull();
    expect(parseSignedDollars("abc")).toBeNull();
  });
  it("reads margins as basis points, empty as not set", () => {
    expect(parseMargin("")).toBeNull();
    expect(parseMargin("15")).toBe(1500);
    expect(parseMargin("0")).toBe(0);
    expect(parseMargin("2.5%")).toBe(250);
    expect(parseMargin("1001")).toBeUndefined();
    expect(parseMargin("-1")).toBeUndefined();
    expect(marginText(1550)).toBe("15.5");
    expect(marginText(null)).toBe("");
  });
  it("validates the credit form", () => {
    expect(creditErrors({ type: "GRANT", amount: "10", reason: "Launch credit" })).toEqual({});
    expect(creditErrors({ type: "GRANT", amount: "-10", reason: "Launch credit" })).toHaveProperty("amount");
    expect(creditErrors({ type: "ADJUSTMENT", amount: "-10", reason: "Double charge" })).toEqual({});
    expect(Object.keys(creditErrors({ type: "ADJUSTMENT", amount: "", reason: "x" })).sort()).toEqual(["amount", "reason"]);
  });
});

describe("account actions", () => {
  const base = { id: "u1", role: "USER" as const, status: "ACTIVE" as const };
  it("offers suspend, ban, erase and make admin for an active user", () => {
    expect(accountActions(base, "me")).toMatchObject({ makeAdmin: true, removeAdmin: false, suspend: true, ban: true, erase: true });
  });
  it("protects admins and your own account", () => {
    expect(accountActions({ ...base, role: "ADMIN" }, "me")).toMatchObject({ removeAdmin: true, suspend: false, ban: false, erase: false });
    const self = accountActions({ ...base, id: "me", role: "ADMIN" }, "me");
    expect(Object.entries(self).filter(([k, v]) => k !== "self" && v)).toEqual([]);
  });
});

describe("admin error copy", () => {
  const err = (code: string, message = "x", details?: unknown) => new ApiError({ status: 409, code, message, details });
  it("explains the guard rails in plain words", () => {
    expect(adminErrorMessage(err("LAST_ADMIN"))).toMatch(/last admin/);
    expect(adminErrorMessage(err("TIER_DEFAULT"))).toMatch(/default tier/);
    expect(adminErrorMessage(err("TOPUP_NOT_PAID"))).toBe("Only paid top-ups can be refunded.");
    expect(adminErrorMessage(err("PROVIDER_EXISTS"))).toMatch(/slug already exists/);
  });
  it("names the unpriced models", () => {
    const e = err("MODEL_UNPRICED", "x", { models: ["gpt-4o-mini"] });
    expect(isUnpriced(e)).toBe(true);
    expect(adminErrorMessage(e)).toMatch(/^gpt-4o-mini is enabled and would have no route it can bill through/);
    expect(adminErrorMessage(err("MODEL_UNPRICED"))).toMatch(/^The model is enabled/);
  });
  it("uses the server's words where they name the clash", () => {
    expect(adminErrorMessage(err("ALIAS_TAKEN", "That id or alias is already used by gpt-4o"))).toBe("That id or alias is already used by gpt-4o.");
  });
});

describe("limits", () => {
  it("reads empty as unlimited and rejects zero and non-numbers", () => {
    expect(parseLimit("")).toBeNull();
    expect(parseLimit(" 200,000 ")).toBe(200000);
    expect(parseLimit("0")).toBeUndefined();
    expect(parseLimit("1.5")).toBeUndefined();
    expect(parseLimit("20000", 10_000)).toBeUndefined();
    expect(limitLabel(null)).toBe("Unlimited");
  });
  it("validates a tier draft like the API", () => {
    expect(tierDraftErrors({ name: "Pro", rpm: "600", tpm: "", concurrency: "10", isDefault: false })).toEqual({});
    expect(Object.keys(tierDraftErrors({ name: " ", rpm: "x", tpm: "1", concurrency: "20000", isDefault: false })).sort()).toEqual(["concurrency", "name", "rpm"]);
  });
});

describe("providers", () => {
  it("requires a base URL for OpenAI compatible providers and a slug on create", () => {
    const d = { id: "groq", kind: "OPENAI_COMPATIBLE" as const, displayName: "Groq", baseUrl: "", enabled: true };
    expect(providerDraftErrors(d, true)).toHaveProperty("baseUrl");
    expect(providerDraftErrors({ ...d, baseUrl: "https://api.example.com/v1" }, true)).toEqual({});
    expect(providerDraftErrors({ ...d, kind: "ANTHROPIC", id: "X" }, true)).toHaveProperty("id");
    expect(providerDraftErrors({ ...d, kind: "ANTHROPIC", id: "X" }, false)).toEqual({});
  });
});

describe("models and routes", () => {
  it("shows only the price fields the kind bills on", () => {
    expect(priceLine("CHAT", { inputMicrosPerMtok: 2_500_000, outputMicrosPerMtok: 10_000_000, cachedMicrosPerMtok: 1_250_000, unitMicros: 0 }, "en-US")).toBe("$2.50 in, $10.00 out, $1.25 cached / 1M tokens");
    expect(priceLine("EMBEDDING", { inputMicrosPerMtok: 20_000, outputMicrosPerMtok: 0, cachedMicrosPerMtok: null, unitMicros: 0 }, "en-US")).toBe("$0.02 in / 1M tokens");
    expect(priceLine("IMAGE", { inputMicrosPerMtok: 0, outputMicrosPerMtok: 0, cachedMicrosPerMtok: null, unitMicros: 40_000 }, "en-US")).toBe("$0.04 per image");
    expect(priceLine("TRANSCRIPTION", { inputMicrosPerMtok: 0, outputMicrosPerMtok: 0, cachedMicrosPerMtok: null, unitMicros: 6_000 }, "en-US")).toBe("$0.006 per minute");
    expect(priceLine("CHAT", null)).toBe("No usable route yet");
  });
  it("knows a priced route by kind", () => {
    expect(routePriced("CHAT", { inputMicrosPerMtok: 0, outputMicrosPerMtok: 1, unitMicros: 0 })).toBe(true);
    expect(routePriced("EMBEDDING", { inputMicrosPerMtok: 0, outputMicrosPerMtok: 1, unitMicros: 0 })).toBe(false);
    expect(routePriced("SPEECH", { inputMicrosPerMtok: 5, outputMicrosPerMtok: 0, unitMicros: 0 })).toBe(false);
  });
  it("sorts the catalogue and parses aliases", () => {
    expect(sortModels([model({ id: "b", displayName: "B", sortOrder: 2 }), model({ id: "a", displayName: "A", sortOrder: 1 })]).map((m) => m.id)).toEqual(["a", "b"]);
    expect(parseAliases("gpt-4o-mini-latest, mini  mini\nx")).toEqual(["gpt-4o-mini-latest", "mini", "x"]);
  });
  it("round-trips a model through the draft", () => {
    const m = model({ marginBps: 2000, aliases: ["mini"] });
    const body = modelDraftBody(modelToDraft(m));
    expect(body).toMatchObject({ kind: "CHAT", displayName: "GPT-4o mini", aliases: ["mini"], contextWindow: 128000, marginBps: 2000, enabled: true, supportsTools: true });
    expect(modelDraftErrors(modelToDraft(m), false)).toEqual({});
  });
  it("validates a new model draft and drops chat flags for other kinds", () => {
    const d = { ...modelToDraft(null, "EMBEDDING"), id: "text-embedding-3-small", displayName: "Embeddings", supportsTools: true };
    expect(modelDraftErrors(d, true)).toEqual({});
    expect(modelDraftBody(d)).toMatchObject({ kind: "EMBEDDING", supportsTools: false, marginBps: null, enabled: false, contextWindow: null });
    expect(Object.keys(modelDraftErrors({ ...d, id: "-bad", margin: "x", sortOrder: "-1" }, true)).sort()).toEqual(["id", "margin", "sortOrder"]);
  });
  it("converts route costs from dollars to micros and zeroes fields the kind ignores", () => {
    const d = { ...routeToDraft(null, 2, "openai"), upstreamModel: "gpt-4o-mini", input: "0.15", output: "0.6", cached: "", unit: "9" };
    expect(routeDraftErrors(d, "CHAT")).toEqual({});
    expect(routeDraftBody(d, "CHAT")).toEqual({ providerId: "openai", upstreamModel: "gpt-4o-mini", priority: 2, timeoutMs: 60_000, inputMicrosPerMtok: 150_000, outputMicrosPerMtok: 600_000, cachedMicrosPerMtok: null, unitMicros: 0, enabled: true });
    expect(routeDraftBody({ ...d, unit: "0.04" }, "IMAGE")).toMatchObject({ inputMicrosPerMtok: 0, outputMicrosPerMtok: 0, cachedMicrosPerMtok: null, unitMicros: 40_000 });
    expect(Object.keys(routeDraftErrors({ ...d, priority: "0", timeout: "900", output: "abc" }, "CHAT")).sort()).toEqual(["output", "priority", "timeout"]);
    // A bad value in a field the kind ignores is not an error.
    expect(routeDraftErrors({ ...d, output: "abc" }, "EMBEDDING")).toEqual({});
  });
  it("loads a route into the draft in dollars and seconds", () => {
    const r = { id: "r1", providerId: "openai", upstreamModel: "x", priority: 1, timeoutMs: 30_000, inputMicrosPerMtok: 150_000, outputMicrosPerMtok: 600_000, cachedMicrosPerMtok: 75_000, unitMicros: 0, enabled: true, circuit: "closed" as const, lastCheck: null };
    expect(routeToDraft(r)).toMatchObject({ timeout: "30", input: "0.15", output: "0.6", cached: "0.075" });
  });
});

describe("health", () => {
  const row = (over: Partial<HealthRow>): HealthRow => ({ routeId: "r", modelId: "m", providerId: "p", upstreamModel: "u", priority: 1, enabled: true, circuit: "closed", successRate24h: 1, p50LatencyMs24h: 300, checks: [], ...over });
  it("groups routes by model, by priority", () => {
    const g = groupHealth([row({ routeId: "b2", modelId: "b", priority: 2 }), row({ routeId: "a1", modelId: "a" }), row({ routeId: "b1", modelId: "b", priority: 1 })]);
    expect(g.map((x) => [x.modelId, x.routes.map((r) => r.routeId)])).toEqual([
      ["a", ["a1"]],
      ["b", ["b1", "b2"]],
    ]);
  });
});

describe("promo codes", () => {
  const now = new Date("2026-10-28T12:00:00Z");
  it("validates and builds the create body", () => {
    const d = { code: "LAUNCH25", amount: "5", maxRedemptions: "100", expires: "2026-12-31" };
    expect(promoDraftErrors(d, now)).toEqual({});
    expect(promoDraftBody(d)).toEqual({ code: "LAUNCH25", amountMicros: 5_000_000, maxRedemptions: 100, expiresAt: "2026-12-31T23:59:59.000Z" });
    expect(promoDraftBody({ ...d, maxRedemptions: "", expires: "" })).toMatchObject({ maxRedemptions: null, expiresAt: null });
    expect(Object.keys(promoDraftErrors({ code: "a b", amount: "0", maxRedemptions: "x", expires: "2026-01-01" }, now)).sort()).toEqual(["amount", "code", "expires", "maxRedemptions"]);
  });
  it("says whether a code can still be redeemed", () => {
    const p = { active: true, expiresAt: null, maxRedemptions: 10, redeemedCount: 3 };
    expect(promoState(p, now).label).toBe("Active");
    expect(promoState({ ...p, active: false }, now).label).toBe("Off");
    expect(promoState({ ...p, redeemedCount: 10 }, now).label).toBe("Used up");
    expect(promoState({ ...p, expiresAt: "2026-10-01T00:00:00Z" }, now).label).toBe("Expired");
  });
});

describe("settings", () => {
  it("round-trips the form in dollars and percent", () => {
    const f = toSettingsForm(settings);
    expect(f).toMatchObject({ defaultMargin: "15", signupCredit: "1", tax: "18", lowBalance: "2", requestRetentionDays: "" });
    expect(fromSettingsForm(f)).toEqual(settings);
    expect(fromSettingsForm({ ...f, defaultMargin: "12.5", signupCredit: "0.5", requestRetentionDays: "365", supportEmail: " help@example.com " })).toMatchObject({
      defaultMarginBps: 1250,
      signupCreditMicros: 500_000,
      requestRetentionDays: 365,
      supportEmail: "help@example.com",
    });
  });
  it("patches only what changed, nested limits narrowed to their keys", () => {
    const draft = { ...settings, tagline: "New", defaultMarginBps: 2000, topupLimits: { ...settings.topupLimits, usdMax: 500 } };
    expect(settingsPatch(settings, draft)).toEqual({ tagline: "New", defaultMarginBps: 2000, topupLimits: { usdMax: 500 } });
    expect(dirtyGroups(settings, draft)).toEqual(["general", "pricing", "billing"]);
    expect(settingsPatch(settings, settings)).toEqual({});
  });
  it("validates like the API", () => {
    expect(settingsErrors(toSettingsForm(settings))).toEqual({});
    const f = toSettingsForm(settings);
    const e = settingsErrors({ ...f, appName: "", registration: "INVITE_ONLY", gatewayBaseUrl: "api", defaultMargin: "x", tax: "60", usdMax: "1", requestRetentionDays: "10", bodyRetentionDays: "0", minSupportedVersion: "1.2" });
    expect(Object.keys(e).sort()).toEqual(["allowedEmailDomains", "appName", "bodyRetentionDays", "defaultMargin", "gatewayBaseUrl", "minSupportedVersion", "requestRetentionDays", "tax", "usdMax"]);
  });
  it("cleans pasted domains", () => {
    expect(parseDomains("Example.com, @team.org https://x.io/path bad", ["team.org"])).toEqual({ added: ["example.com", "x.io"], invalid: ["bad"] });
  });
});

describe("audit", () => {
  it("prefers a typed prefix over the group tab", () => {
    expect(auditAction("wallet", "")).toBe("wallet.");
    expect(auditAction("user", " model.updated ")).toBe("model.updated");
    expect(auditAction("nope", "")).toBe("");
  });
  it("labels gateway actions plainly", () => {
    expect(humanizeAction("wallet.grant")).toBe("Granted credit");
    expect(humanizeAction("route.circuit_open")).toBe("Forced a circuit open");
    expect(humanizeAction("user.email_verified")).toBe("User email verified");
  });
});
