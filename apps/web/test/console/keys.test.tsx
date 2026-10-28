import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@open-gateway/ui";
import type { ApiKey, ApiKeyInput, AppMeta, CreatedApiKey, ModelInfo } from "@open-gateway/types";

const key = (over: Partial<ApiKey> = {}): ApiKey => ({
  id: "01JDK4V7Q8AAAAAAAAAAAAAAAA",
  name: "Production",
  hint: "gw-AbCd...WxYz",
  status: "ACTIVE",
  expiresAt: null,
  allowedModels: [],
  monthlyBudgetMicros: null,
  spentThisMonthMicros: 1_250_000,
  rpm: null,
  tpm: null,
  ipAllowlist: [],
  logBodies: false,
  lastUsedAt: null,
  createdAt: "2026-10-01T00:00:00Z",
  revokedAt: null,
  ...over,
});

const keys = { list: vi.fn<() => Promise<ApiKey[]>>(), create: vi.fn<(b: ApiKeyInput) => Promise<CreatedApiKey>>(), update: vi.fn(), revoke: vi.fn<(id: string) => Promise<void>>() };
const models = { list: vi.fn<() => Promise<ModelInfo[]>>() };
const meta = { get: vi.fn<() => Promise<Partial<AppMeta>>>() };
vi.mock("@/lib/api", () => ({ api: () => ({ keys, models, meta }) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn(), push: vi.fn() }), usePathname: () => "/keys", useSearchParams: () => new URLSearchParams() }));
vi.mock("@/components/app/app-shell", () => ({ PageBar: () => null }));

import { KeysPage } from "@/components/console/keys";

/** Low entropy on purpose: obviously not a real key. */
const FAKE_SECRET = `gw-${"a".repeat(40)}`;

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
  keys.list.mockResolvedValue([key(), key({ id: "01JDK4V7Q8BBBBBBBBBBBBBBBB", name: "Old laptop", status: "REVOKED" })]);
  models.list.mockResolvedValue([]);
  meta.get.mockResolvedValue({ gatewayBaseUrl: "https://gw.example.com/v1", keyPrefix: "gw-" });
});

describe("the keys page", () => {
  it("lists keys with their hint, status and month spend, never a secret", async () => {
    wrap(<KeysPage />);
    expect(await screen.findByText("Production")).toBeInTheDocument();
    expect(screen.getAllByText("gw-AbCd...WxYz")).toHaveLength(2);
    expect(screen.getByText("Revoked")).toBeInTheDocument();
    expect(screen.getAllByText("$1.25").length).toBeGreaterThan(0);
  });

  it("creates a key and shows its secret once with a ready snippet", async () => {
    const user = userEvent.setup();
    keys.create.mockResolvedValue({ ...key({ id: "01JDK4V7Q8CCCCCCCCCCCCCCCC", name: "CI" }), secret: FAKE_SECRET });
    wrap(<KeysPage />);
    await user.click(await screen.findByTestId("create-key"));
    const dialog = await screen.findByTestId("key-dialog");
    await user.type(within(dialog).getByLabelText("Name"), "CI");
    await user.click(within(dialog).getByTestId("save-key"));
    await waitFor(() => expect(keys.create).toHaveBeenCalledWith(expect.objectContaining({ name: "CI", allowedModels: [], logBodies: false })));
    expect(await screen.findByTestId("created-key-secret")).toHaveTextContent(FAKE_SECRET);
    expect(screen.getByTestId("created-key-dialog")).toHaveTextContent(`Bearer ${FAKE_SECRET}`);
  });

  it("refuses to save a key without a name", async () => {
    const user = userEvent.setup();
    wrap(<KeysPage />);
    await user.click(await screen.findByTestId("create-key"));
    await user.click(within(await screen.findByTestId("key-dialog")).getByTestId("save-key"));
    expect(await screen.findByText(/Name the key/)).toBeInTheDocument();
    expect(keys.create).not.toHaveBeenCalled();
  });
});
