import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ReactNode } from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ApiError } from "@open-gateway/api-client";
import { TooltipProvider } from "@open-gateway/ui";
import type { AdminModel, AdminProvider, AdminTopupRow, AdminUserDetail, AppSettings, HealthRow, IntegrationStatus, LimitTier, Page, PromoCode } from "@open-gateway/types";

const admin = {
  tiers: vi.fn<() => Promise<LimitTier[]>>(),
  createTier: vi.fn(),
  settings: vi.fn<() => Promise<AppSettings>>(),
  updateSettings: vi.fn<(b: Partial<AppSettings>) => Promise<AppSettings>>(),
  integrations: vi.fn<() => Promise<IntegrationStatus>>(),
  models: vi.fn<() => Promise<AdminModel[]>>(),
  updateModel: vi.fn(),
  testRoute: vi.fn(),
  providers: vi.fn<() => Promise<AdminProvider[]>>(),
  addCredential: vi.fn(),
  health: vi.fn<() => Promise<HealthRow[]>>(),
  setCircuit: vi.fn(),
  topups: vi.fn<(q: Record<string, unknown>) => Promise<Page<AdminTopupRow>>>(),
  refundTopup: vi.fn(),
  promos: vi.fn<() => Promise<PromoCode[]>>(),
  user: vi.fn<(id: string) => Promise<AdminUserDetail>>(),
  credit: vi.fn(),
};
const nav = { replace: vi.fn(), push: vi.fn() };
let search = new URLSearchParams();
vi.mock("next/navigation", () => ({ useRouter: () => nav, usePathname: () => "/admin", useSearchParams: () => search }));
vi.mock("@/lib/api", () => ({ api: () => ({ admin }) }));
vi.mock("@/lib/auth", () => ({ useAuth: () => ({ user: { id: "me" }, status: "signed-in" }) }));

import { AdminTiers } from "@/components/admin/pages/tiers";
import { AdminSettings } from "@/components/admin/pages/settings";
import { AdminModels } from "@/components/admin/pages/models";
import { AdminProviders } from "@/components/admin/pages/providers";
import { AdminHealth } from "@/components/admin/pages/health";
import { AdminBilling } from "@/components/admin/pages/billing";
import { UserSheet } from "@/components/admin/pages/user-sheet";

const settings: AppSettings = {
  appName: "Open Gateway",
  tagline: "",
  registration: "OPEN",
  allowedEmailDomains: [],
  supportEmail: null,
  gatewayBaseUrl: "https://api.example.com/v1",
  defaultMarginBps: 1500,
  signupCreditMicros: 1_000_000,
  taxBps: 0,
  taxLabel: "Tax",
  topupLimits: { usdMin: 5, usdMax: 1000, inrMin: 500, inrMax: 100000 },
  lowBalanceMicros: 0,
  bodyRetentionDays: 7,
  requestRetentionDays: null,
  minSupportedVersion: null,
};

const integrations: IntegrationStatus = { mail: { mode: "outbox" }, payments: { stripe: true, razorpay: false, stub: false }, fx: { inrPerUsd: 84.2, source: "openexchangerates", fetchedAt: null }, credentialsKeyConfigured: true };

const route = { id: "r1", providerId: "openai", upstreamModel: "gpt-4o-mini", priority: 1, timeoutMs: 60_000, inputMicrosPerMtok: 150_000, outputMicrosPerMtok: 600_000, cachedMicrosPerMtok: null, unitMicros: 0, enabled: true, circuit: "closed" as const, lastCheck: null };

const model = (over: Partial<AdminModel> = {}): AdminModel => ({
  id: "gpt-4o-mini",
  kind: "CHAT",
  displayName: "GPT-4o mini",
  description: "",
  ownedBy: "openai",
  aliases: [],
  contextWindow: 128000,
  maxOutputTokens: null,
  supportsTools: true,
  supportsVision: false,
  supportsJson: true,
  marginBps: null,
  effectiveMarginBps: 1500,
  price: { inputMicrosPerMtok: 172_500, outputMicrosPerMtok: 690_000, cachedMicrosPerMtok: null, unitMicros: 0 },
  enabled: true,
  sortOrder: 0,
  routes: [route],
  ...over,
});

const provider: AdminProvider = { id: "openai", kind: "OPENAI_COMPATIBLE", displayName: "OpenAI", baseUrl: "https://api.example.com/v1", enabled: true, credentials: [], routeCount: 1 };

function wrap(ui: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <TooltipProvider>{ui}</TooltipProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  search = new URLSearchParams();
  admin.integrations.mockResolvedValue(integrations);
  admin.providers.mockResolvedValue([provider]);
});

describe("limits page", () => {
  it("lists tiers with Unlimited and the default marker", async () => {
    admin.tiers.mockResolvedValue([
      { id: "t1", name: "Free", rpm: 60, tpm: 100000, concurrency: 4, isDefault: true, userCount: 4 },
      { id: "t2", name: "Scale", rpm: null, tpm: null, concurrency: null, isDefault: false, userCount: 1 },
    ]);
    wrap(<AdminTiers />);
    const scale = await screen.findByTestId("tier-row-Scale");
    expect(within(scale).getAllByText("Unlimited").length).toBe(3);
    expect(within(screen.getByTestId("tier-row-Free")).getByTestId("tier-default-marker")).toBeInTheDocument();
  });

  it("sends blank limits as unlimited", async () => {
    admin.tiers.mockResolvedValue([]);
    admin.createTier.mockResolvedValue([]);
    const user = userEvent.setup();
    wrap(<AdminTiers />);
    await user.click(await screen.findByTestId("tier-add"));
    await user.type(screen.getByTestId("tier-name"), "Pro");
    await user.type(screen.getByTestId("tier-rpm"), "600");
    await user.click(screen.getByTestId("tier-save"));
    await waitFor(() => expect(admin.createTier).toHaveBeenCalledWith({ name: "Pro", rpm: 600, tpm: null, concurrency: null, isDefault: false }));
  });
});

describe("settings page", () => {
  it("saves only what changed, in basis points", async () => {
    admin.settings.mockResolvedValue(settings);
    admin.updateSettings.mockImplementation(async (b) => ({ ...settings, ...b }));
    const user = userEvent.setup();
    wrap(<AdminSettings />);
    const margin = await screen.findByTestId("settings-default-margin");
    expect(margin).toHaveValue("15");
    expect(screen.queryByTestId("settings-save-bar")).not.toBeInTheDocument();
    await user.clear(margin);
    await user.type(margin, "20");
    expect(await screen.findByText(/Unsaved changes in Pricing/)).toBeInTheDocument();
    await user.click(screen.getByTestId("settings-save"));
    await waitFor(() => expect(admin.updateSettings).toHaveBeenCalledWith({ defaultMarginBps: 2000 }));
  });

  it("blocks a save while a field is invalid", async () => {
    admin.settings.mockResolvedValue(settings);
    const user = userEvent.setup();
    wrap(<AdminSettings />);
    const tax = await screen.findByTestId("settings-tax");
    await user.clear(tax);
    await user.type(tax, "75");
    expect(await screen.findByText("A percent from 0 to 50.")).toBeInTheDocument();
    expect(screen.getByTestId("settings-save")).toBeDisabled();
  });

  it("shows integrations and warns without a credentials key", async () => {
    admin.settings.mockResolvedValue(settings);
    admin.integrations.mockResolvedValue({ ...integrations, credentialsKeyConfigured: false });
    wrap(<AdminSettings />);
    expect(await screen.findByTestId("integrations-key-warning")).toHaveTextContent("CREDENTIALS_KEY is the development default");
    expect(screen.getByText("Outbox: written to disk on the server, not sent")).toBeInTheDocument();
    expect(screen.getByText(/1 USD = 84.2 INR/)).toBeInTheDocument();
  });
});

describe("models page", () => {
  it("lists the price callers pay and the margin in force", async () => {
    admin.models.mockResolvedValue([model()]);
    wrap(<AdminModels />);
    const row = await screen.findByTestId("model-row-gpt-4o-mini");
    expect(within(row).getByText("$0.1725 in, $0.69 out / 1M tokens")).toBeInTheDocument();
    expect(within(row).getByText("15%")).toBeInTheDocument();
  });

  it("explains MODEL_UNPRICED and rolls the switch back", async () => {
    admin.models.mockResolvedValue([model({ enabled: false, price: null, routes: [] })]);
    admin.updateModel.mockRejectedValue(new ApiError({ status: 409, code: "MODEL_UNPRICED", message: "x", details: { models: ["gpt-4o-mini"] } }));
    const user = userEvent.setup();
    wrap(<AdminModels />);
    const toggle = await screen.findByTestId("model-enabled-gpt-4o-mini");
    await user.click(toggle);
    const dialog = await screen.findByTestId("model-unpriced-dialog");
    expect(dialog).toHaveTextContent("GPT-4o mini cannot be turned on yet");
    expect(dialog).toHaveTextContent(/needs at least one enabled route with a cost above zero/);
    expect(admin.updateModel).toHaveBeenCalledWith("gpt-4o-mini", expect.objectContaining({ enabled: true, kind: "CHAT", marginBps: null }));
    expect(toggle).toHaveAttribute("aria-checked", "false");
  });

  it("tests a route from the model panel", async () => {
    search = new URLSearchParams("open=gpt-4o-mini");
    admin.models.mockResolvedValue([model()]);
    admin.testRoute.mockResolvedValue({ ok: true, latencyMs: 412, message: "Replied with 3 tokens." });
    const user = userEvent.setup();
    wrap(<AdminModels />);
    await user.click(await screen.findByTestId("route-test-r1"));
    const result = await screen.findByTestId("route-test-result-r1");
    expect(result).toHaveTextContent("Working");
    expect(result).toHaveTextContent("412 ms");
    expect(result).toHaveTextContent("Replied with 3 tokens.");
    expect(admin.testRoute).toHaveBeenCalledWith("gpt-4o-mini", "r1");
  });

  it("asks only for the cost an image model bills on", async () => {
    search = new URLSearchParams("open=img");
    admin.models.mockResolvedValue([model({ id: "img", kind: "IMAGE", displayName: "Image", routes: [] })]);
    const user = userEvent.setup();
    wrap(<AdminModels />);
    await user.click(await screen.findByTestId("route-add"));
    const dialog = await screen.findByTestId("route-dialog");
    expect(within(dialog).getByTestId("route-cost-unit")).toBeInTheDocument();
    expect(within(dialog).queryByTestId("route-cost-input")).not.toBeInTheDocument();
    expect(within(dialog).queryByTestId("route-cost-output")).not.toBeInTheDocument();
  });
});

describe("providers page", () => {
  it("adds a credential from a password field and clears it", async () => {
    search = new URLSearchParams("open=openai");
    admin.addCredential.mockResolvedValue([{ ...provider, credentials: [{ id: "c1", label: "Main", last4: "9xyz", enabled: true, disabledReason: null, createdAt: "2026-10-28T10:00:00Z" }] }]);
    const user = userEvent.setup();
    wrap(<AdminProviders />);
    const secret = await screen.findByTestId("credential-secret");
    expect(secret).toHaveAttribute("type", "password");
    await user.type(screen.getByTestId("credential-label"), "Main");
    await user.type(secret, "sk-test-0000-9xyz");
    await user.click(screen.getByTestId("credential-add"));
    await waitFor(() => expect(admin.addCredential).toHaveBeenCalledWith("openai", { label: "Main", secret: "sk-test-0000-9xyz" }));
    expect(await screen.findByTestId("credential-c1")).toHaveTextContent("9xyz");
    expect(screen.getByTestId("credential-secret")).toHaveValue("");
  });
});

describe("health page", () => {
  it("shows probes and forces a circuit open", async () => {
    let circuit: HealthRow["circuit"] = "closed";
    admin.health.mockImplementation(async () => [
      {
        routeId: "r1", modelId: "gpt-4o-mini", providerId: "openai", upstreamModel: "gpt-4o-mini", priority: 1, enabled: true, circuit, successRate24h: 0.5, p50LatencyMs24h: 420,
        checks: [
          { ok: false, latencyMs: null, error: "timeout", checkedAt: "2026-10-28T10:02:00Z" },
          { ok: true, latencyMs: 300, error: null, checkedAt: "2026-10-28T10:01:00Z" },
        ],
      },
    ]);
    admin.setCircuit.mockImplementation(async (_id: string, state: HealthRow["circuit"]) => {
      circuit = state;
    });
    const user = userEvent.setup();
    wrap(<AdminHealth />);
    const row = await screen.findByTestId("health-route-r1");
    expect(within(row).getByLabelText("Last 2 probes: 1 failed")).toBeInTheDocument();
    expect(within(row).getByText("50%")).toBeInTheDocument();
    await user.click(within(row).getByTestId("health-open-r1"));
    await waitFor(() => expect(admin.setCircuit).toHaveBeenCalledWith("r1", "open"));
    await waitFor(() => expect(within(screen.getByTestId("health-route-r1")).getByTestId("health-circuit-r1")).toHaveTextContent("Circuit open"));
    expect(screen.getByTestId("health-close-r1")).toBeInTheDocument();
  });
});

describe("billing page", () => {
  const topup = (over: Partial<AdminTopupRow>): AdminTopupRow => ({
    id: "t1", owner: { id: "u1", username: "ada", displayName: "Ada Lovelace", role: "USER" }, gateway: "STRIPE", currency: "USD", totalMinor: 1000, creditMicros: 10_000_000, status: "PAID",
    createdAt: "2026-10-27T10:00:00Z", paidAt: "2026-10-27T10:01:00Z", ...over,
  });

  it("offers a refund only on paid top-ups and records the reason", async () => {
    admin.topups.mockResolvedValue({ items: [topup({}), topup({ id: "t2", status: "FAILED", paidAt: null })], nextCursor: null });
    admin.promos.mockResolvedValue([]);
    admin.refundTopup.mockResolvedValue(undefined);
    const user = userEvent.setup();
    wrap(<AdminBilling />);
    await screen.findByTestId("topup-row-t1");
    expect(within(screen.getByTestId("topup-row-t2")).queryByRole("button")).not.toBeInTheDocument();
    await user.click(screen.getByTestId("topup-refund-t1"));
    await user.type(await screen.findByTestId("reason-input"), "Charged twice");
    await user.click(screen.getByTestId("reason-confirm"));
    await waitFor(() => expect(admin.refundTopup).toHaveBeenCalledWith("t1", "Charged twice"));
  });

  it("passes the account filter from the URL", async () => {
    search = new URLSearchParams("user=u1&status=PAID");
    admin.topups.mockResolvedValue({ items: [topup({})], nextCursor: null });
    admin.promos.mockResolvedValue([{ id: "p1", code: "LAUNCH25", amountMicros: 5_000_000, maxRedemptions: 100, redeemedCount: 3, expiresAt: null, active: true, createdAt: "2026-10-01T00:00:00Z" }]);
    wrap(<AdminBilling />);
    expect(await screen.findByText(/Showing top-ups by Ada Lovelace/)).toBeInTheDocument();
    expect(admin.topups).toHaveBeenCalledWith(expect.objectContaining({ userId: "u1", status: "PAID" }));
    expect(within(await screen.findByTestId("promo-row-LAUNCH25")).getByText("3 of 100")).toBeInTheDocument();
  });
});

describe("user sheet", () => {
  const detail: AdminUserDetail = {
    id: "u1", username: "ada", displayName: "Ada Lovelace", role: "USER", email: "ada@example.com", status: "ACTIVE", limitTier: null, createdAt: "2026-09-01T00:00:00Z", lastSeenAt: null,
    suspendedUntil: null, balanceMicros: 2_000_000, spentThisMonthMicros: 500_000, marginBps: null, reservedMicros: 0,
    keys: [{ id: "k1", name: "Prod", hint: "gw-a1b2...9xyz", status: "ACTIVE", marginBps: 500, lastUsedAt: null }],
    totals: { requests: 10, spendMicros: 500_000, topupsMicros: 0, creditsMicros: 2_500_000 },
    usage: [],
  };

  it("grants credit in micros with a reason", async () => {
    admin.user.mockResolvedValue(detail);
    admin.credit.mockResolvedValue({ ...detail, balanceMicros: 12_000_000 });
    const user = userEvent.setup();
    wrap(<UserSheet userId="u1" tiers={[]} onClose={() => {}} />);
    await user.type(await screen.findByTestId("credit-amount"), "10");
    await user.type(screen.getByTestId("credit-reason"), "Launch credit");
    await user.click(screen.getByTestId("credit-save"));
    await waitFor(() => expect(admin.credit).toHaveBeenCalledWith("u1", { type: "GRANT", amountMicros: 10_000_000, reason: "Launch credit" }));
    expect(await screen.findByTestId("user-balance")).toHaveTextContent("$12.00");
  });

  it("shows each key with its margin override", async () => {
    admin.user.mockResolvedValue(detail);
    wrap(<UserSheet userId="u1" tiers={[]} onClose={() => {}} />);
    expect(await screen.findByTestId("key-margin-k1-input")).toHaveValue("5");
    expect(screen.getByTestId("user-margin-input")).toHaveValue("");
  });
});
