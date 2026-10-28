import { describe, expect, it, vi } from "vitest";
import { ApiError, buildQuery, createApiClient, isApiError, toApiError } from "../src";
import { authResult, json } from "./fixtures";

type Call = { url: string; init: RequestInit };

function setup(handler: (call: Call, n: number) => Response | Promise<Response>, initialToken: string | null = "old") {
  let token = initialToken;
  const calls: Call[] = [];
  const onRefresh = vi.fn((r) => {
    token = r.accessToken;
  });
  const onSignedOut = vi.fn(() => {
    token = null;
  });
  const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
    const call = { url, init };
    calls.push(call);
    return handler(call, calls.length);
  });
  const client = createApiClient({
    baseUrl: "/api/",
    getAccessToken: () => token,
    onRefresh,
    onSignedOut,
    fetch: fetchMock as unknown as typeof fetch,
    crossTabLock: (fn) => fn(),
  });
  return { client, calls, onRefresh, onSignedOut, getToken: () => token };
}

const authOf = (c: Call) => (c.init.headers as Record<string, string>).Authorization;

describe("request basics", () => {
  it("joins the base url, drops empty query values and sends the bearer token", async () => {
    const { client, calls } = setup(() => json(200, { items: [], nextCursor: null }));
    await client.usage.requests({ cursor: undefined, status: "error" });
    expect(calls[0]!.url).toBe("/api/usage/requests?status=error");
    expect(authOf(calls[0]!)).toBe("Bearer old");
  });

  it("returns undefined for 204", async () => {
    const { client } = setup(() => new Response(null, { status: 204 }));
    await expect(client.keys.revoke("k1")).resolves.toBeUndefined();
  });

  it("sends auth calls with credentials so the refresh cookie travels", async () => {
    const { client, calls } = setup(() => json(200, authResult("t")), null);
    await client.auth.login({ login: "ada", password: "x" });
    expect(calls[0]!.init.credentials).toBe("include");
    expect(authOf(calls[0]!)).toBeUndefined();
  });

  it("downloads a file as a Blob with the bearer token, and maps a 404 to ApiError", async () => {
    let n = 0;
    const { client, calls } = setup(() => (n++ === 0 ? new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } }) : json(404, { error: "User not found", code: "NOT_FOUND" })));
    const blob = await client.users.exportData();
    expect(await blob.text()).toBe("{}");
    expect(calls[0]!.url).toBe("/api/users/me/export");
    expect(authOf(calls[0]!)).toBe("Bearer old");
    await expect(client.users.exportData()).rejects.toMatchObject({ status: 404, code: "NOT_FOUND" });
  });

  it("buildQuery repeats arrays", () => {
    expect(buildQuery({ a: [1, 2], b: true, c: null })).toBe("?a=1&a=2&b=true");
    expect(buildQuery({})).toBe("");
  });
});

describe("refresh single-flight", () => {
  it("shares one refresh between concurrent 401s and retries each with the new token", async () => {
    let refreshes = 0;
    const { client, calls, onRefresh } = setup(async (call) => {
      if (call.url.endsWith("/auth/refresh")) {
        refreshes++;
        await new Promise((r) => setTimeout(r, 10));
        return json(200, authResult("new"));
      }
      if (authOf(call) === "Bearer old") return json(401, { error: "Session expired", code: "TOKEN_INVALID" });
      return json(200, { ok: call.url });
    });
    const results = await Promise.all([client.auth.me(), client.users.sessions(), client.billing.wallet()]);
    expect(refreshes).toBe(1);
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(results).toHaveLength(3);
    const retries = calls.filter((c) => authOf(c) === "Bearer new");
    expect(retries).toHaveLength(3);
  });

  it("signs out when the refresh itself is rejected, and surfaces the original error", async () => {
    const { client, onSignedOut } = setup((call) =>
      call.url.endsWith("/auth/refresh") ? json(401, { error: "Session expired", code: "SESSION_EXPIRED" }) : json(401, { error: "x", code: "TOKEN_INVALID" }),
    );
    const err = (await client.auth.me().catch((e: unknown) => e)) as ApiError;
    expect(isApiError(err)).toBe(true);
    expect(err.code).toBe("TOKEN_INVALID");
    expect(onSignedOut).toHaveBeenCalledWith("SESSION_EXPIRED");
  });

  it("does not sign out on a network failure during refresh", async () => {
    const { client, onSignedOut } = setup((call) => {
      if (call.url.endsWith("/auth/refresh")) throw new TypeError("fetch failed");
      return json(401, { error: "x", code: "TOKEN_INVALID" });
    });
    const err = (await client.auth.me().catch((e: unknown) => e)) as ApiError;
    expect(err.code).toBe("NETWORK_ERROR");
    expect(onSignedOut).not.toHaveBeenCalled();
  });

  it("does not try to refresh a 401 for a request sent without a token", async () => {
    const { client, calls } = setup(() => json(401, { error: "Sign in", code: "UNAUTHENTICATED" }), null);
    await expect(client.auth.me()).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    expect(calls).toHaveLength(1);
  });

  it("does not retry auth endpoints", async () => {
    const { client, calls } = setup(() => json(401, { error: "Wrong", code: "INVALID_CREDENTIALS" }));
    await expect(client.auth.login({ login: "a", password: "b" })).rejects.toMatchObject({ code: "INVALID_CREDENTIALS" });
    expect(calls).toHaveLength(1);
  });

  it("starts a fresh refresh after the previous one settled", async () => {
    const { client, calls } = setup((call) => (call.url.endsWith("/auth/refresh") ? json(200, authResult("n")) : json(200, {})));
    await client.refreshSession();
    await client.refreshSession();
    expect(calls.filter((c) => c.url.endsWith("/auth/refresh"))).toHaveLength(2);
  });
});

describe("ApiError mapping", () => {
  it("carries code, status, details and request id from the error body", async () => {
    const { client } = setup(() =>
      json(400, { error: "body: too short", code: "VALIDATION_FAILED", details: { fields: [{ path: "body", message: "too short" }] }, requestId: "req-1" }),
    );
    const err = (await client.users.updateMe({ displayName: "" }).catch((e: unknown) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(400);
    expect(err.code).toBe("VALIDATION_FAILED");
    expect(err.requestId).toBe("req-1");
    expect(err.fieldErrors).toEqual({ body: "too short" });
  });

  it("exposes details.reason for DM denials", () => {
    const err = toApiError(403, { error: "No", code: "DM_NOT_ALLOWED", details: { reason: "BLOCKED" } });
    expect(err.reason).toBe("BLOCKED");
  });

  it("falls back to a status-derived code for non-JSON bodies", async () => {
    const { client } = setup(() => new Response("<html>bad gateway</html>", { status: 502, headers: { "content-type": "text/html" } }));
    await expect(client.auth.me()).rejects.toMatchObject({ code: "BAD_GATEWAY", status: 502 });
    expect(toApiError(418, null).code).toBe("HTTP_418");
  });

  it("maps transport failures to NETWORK_ERROR and rethrows aborts untouched", async () => {
    const { client } = setup(() => {
      throw new TypeError("Failed to fetch");
    });
    await expect(client.auth.me()).rejects.toMatchObject({ code: "NETWORK_ERROR", status: 0 });
    const abort = setup(() => {
      throw Object.assign(new Error("aborted"), { name: "AbortError" });
    });
    await expect(abort.client.auth.me()).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("account endpoints", () => {
  it("downloads the data export as a Blob with the bearer token, and maps a 429 to ApiError", async () => {
    let n = 0;
    const { client, calls } = setup(() => (++n === 1 ? new Response('{"profile":{}}', { status: 200, headers: { "Content-Type": "application/json" } }) : json(429, { error: "Slow down", code: "RATE_LIMITED" })));
    const blob = await client.users.exportData();
    expect(await blob.text()).toBe('{"profile":{}}');
    expect(calls[0]!.url).toBe("/api/users/me/export");
    expect(authOf(calls[0]!)).toBe("Bearer old");
    const err = await client.users.exportData().catch((e: unknown) => e);
    expect(isApiError(err) && err.status === 429 && err.code === "RATE_LIMITED").toBe(true);
  });

  it("deletes the account with a JSON body on DELETE", async () => {
    const { client, calls } = setup(() => new Response(null, { status: 204 }));
    await client.users.deleteMe({ password: "pw", totp: "123456" });
    expect(calls[0]!.init.method).toBe("DELETE");
    expect(calls[0]!.url).toBe("/api/users/me");
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ password: "pw", totp: "123456" });
  });

  it("reads the public app meta without trying a refresh", async () => {
    const { client, calls, onRefresh } = setup(() => json(401, { error: "no", code: "TOKEN_EXPIRED" }));
    await expect(client.meta.get()).rejects.toBeInstanceOf(ApiError);
    expect(calls).toHaveLength(1);
    expect(onRefresh).not.toHaveBeenCalled();
  });

  it("sends a recovery code instead of a TOTP code on login", async () => {
    const { client, calls } = setup(() => json(200, authResult("t")), null);
    await client.auth.login({ login: "ada", password: "x", recoveryCode: "abcd-efgh" });
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ login: "ada", password: "x", recoveryCode: "abcd-efgh" });
  });
});

describe("ready gate", () => {
  it("holds requests until ready() settles and then reads the token, but never holds auth calls", async () => {
    let token: string | null = null;
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    const urls: string[] = [];
    const client = createApiClient({
      baseUrl: "/api",
      getAccessToken: () => token,
      ready: () => gate,
      fetch: (async (url: string, init: RequestInit) => {
        urls.push(`${url} ${(init.headers as Record<string, string>).Authorization ?? "-"}`);
        return url.endsWith("/auth/login") ? json(200, authResult("t")) : json(200, { items: [], nextCursor: null });
      }) as unknown as typeof fetch,
      crossTabLock: (fn) => fn(),
    });
    const list = client.usage.requests({});
    await client.auth.login({ login: "ada", password: "x" });
    expect(urls).toEqual(["/api/auth/login -"]);
    token = "booted";
    open();
    await list;
    expect(urls[1]).toBe("/api/usage/requests Bearer booted");
  });
});

describe("native token mode", () => {
  function nativeClient(handler: (url: string, init: RequestInit) => Response) {
    let stored: string | null = "rt-1";
    const calls: { url: string; init: RequestInit }[] = [];
    const client = createApiClient({
      baseUrl: "/api",
      getAccessToken: () => "stale",
      native: { getRefreshToken: async () => stored, setRefreshToken: async (t) => void (stored = t) },
      fetch: (async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return handler(url, init);
      }) as unknown as typeof fetch,
    });
    return { client, calls, stored: () => stored };
  }

  it("sends X-Client: native, refreshes with the stored token in the body and keeps the rotated one", async () => {
    let n = 0;
    const { client, calls, stored } = nativeClient((url) => {
      if (url === "/api/auth/refresh") return json(200, { ...authResult("fresh"), refreshToken: "rt-2", refreshExpiresAt: "2030-01-01T00:00:00.000Z" });
      return ++n === 1 ? json(401, { error: "expired", code: "TOKEN_INVALID" }) : json(200, { items: [], nextCursor: null });
    });
    await client.keys.list();
    const refresh = calls.find((c) => c.url === "/api/auth/refresh")!;
    expect(JSON.parse(refresh.init.body as string)).toEqual({ refreshToken: "rt-1" });
    expect((refresh.init.headers as Record<string, string>)["X-Client"]).toBe("native");
    expect(refresh.init.credentials).toBe("omit");
    expect(stored()).toBe("rt-2");
  });

  it("keeps the token from sign-in and sends it on sign-out, then forgets it", async () => {
    const { client, calls, stored } = nativeClient((url) => (url === "/api/auth/login" ? json(200, { ...authResult("a"), refreshToken: "rt-login", refreshExpiresAt: "2030-01-01T00:00:00.000Z" }) : new Response(null, { status: 204 })));
    await client.auth.login({ login: "ada", password: "x" });
    expect(stored()).toBe("rt-login");
    await client.auth.logout();
    expect(JSON.parse(calls.at(-1)!.init.body as string)).toEqual({ refreshToken: "rt-login" });
    expect(stored()).toBeNull();
  });

  it("clears the stored token when the server ends the session", async () => {
    const { client, stored } = nativeClient(() => json(401, { error: "Session expired", code: "SESSION_EXPIRED" }));
    await expect(client.refreshSession()).resolves.toBeNull();
    expect(stored()).toBeNull();
  });
});

describe("console endpoints", () => {
  it("sends keys, top-ups and admin margins to their paths, and reads the public catalogue without a token", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const client = createApiClient({
      baseUrl: "/api",
      getAccessToken: () => "a",
      fetch: (async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return json(200, {});
      }) as unknown as typeof fetch,
    });
    await client.keys.create({ name: "CI", allowedModels: ["stub-chat"] });
    expect(calls.at(-1)!.url).toBe("/api/keys");
    expect(JSON.parse(calls.at(-1)!.init.body as string)).toEqual({ name: "CI", allowedModels: ["stub-chat"] });
    await client.billing.createTopup({ currency: "INR", amount: 800 });
    expect(calls.at(-1)!.url).toBe("/api/billing/topups");
    await client.billing.verifyRazorpay({ orderId: "order_1", paymentId: "pay_1", signature: "s" });
    expect(calls.at(-1)!.url).toBe("/api/billing/razorpay/verify");
    await client.admin.setKeyMargin("01U", "01K", 0);
    expect(calls.at(-1)!.url).toBe("/api/admin/users/01U/keys/01K/margin");
    expect(JSON.parse(calls.at(-1)!.init.body as string)).toEqual({ marginBps: 0 });
    await client.admin.testRoute("vendor/model", "01R");
    expect(calls.at(-1)!.url).toBe("/api/admin/models/vendor%2Fmodel/routes/01R/test");
    await client.models.list();
    expect(calls.at(-1)!.url).toBe("/api/catalog");
  });
});
