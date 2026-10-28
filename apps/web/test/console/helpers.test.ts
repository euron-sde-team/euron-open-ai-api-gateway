import { describe, expect, it } from "vitest";
import { activeConsoleHref } from "@/lib/console-nav";
import { formToInput } from "@/lib/key-form";
import { splitSse } from "@/lib/sse";
import { lastDays, priceParts, requestStatus } from "@/lib/console";
import { bpsLabel, dollarsToMicros, minor, percentToBps, perMillion, previewTopup, signedUsd, usd } from "@/lib/money";
import { rootOf, snippet } from "@/lib/snippets";

describe("money", () => {
  it("formats micro-USD so cheap requests never read as zero", () => {
    expect(usd(12_400_000)).toBe("$12.40");
    expect(usd(184)).toBe("$0.000184");
    expect(usd(3_100)).toBe("$0.0031");
    expect(usd(0)).toBe("$0.00");
    expect(signedUsd(10_000_000)).toBe("+$10.00");
    expect(signedUsd(-3_100)).toBe("-$0.0031");
    expect(perMillion(2_500_000)).toBe("$2.50 / 1M");
  });
  it("formats minor units in their own currency", () => {
    expect(minor(1000, "USD")).toBe("$10.00");
    expect(minor(123450, "INR")).toBe("₹1,234.50");
  });
  it("parses form input into micros and basis points", () => {
    expect(dollarsToMicros("25")).toBe(25_000_000);
    expect(dollarsToMicros("$0.5")).toBe(500_000);
    expect(dollarsToMicros("abc")).toBeNull();
    expect(dollarsToMicros("-1")).toBeNull();
    expect(percentToBps("15")).toBe(1500);
    expect(percentToBps("2.5%")).toBe(250);
    expect(percentToBps("1.234")).toBeNull();
    expect(bpsLabel(1500)).toBe("15%");
    expect(bpsLabel(0, true)).toBe("0% (at cost)");
  });
});

describe("snippets", () => {
  const o = { baseUrl: "https://gw.example.com/v1/", keyPrefix: "gw-", model: "stub-chat" };
  it("uses a placeholder key unless the real one is given", () => {
    expect(snippet("curl", o)).toContain("Bearer gw-your-key");
    expect(snippet("curl", { ...o, key: "gw-abc" })).toContain("Bearer gw-abc");
    expect(snippet("curl", o)).toContain("https://gw.example.com/v1/chat/completions");
  });
  it("gives the Anthropic SDKs the root without /v1", () => {
    expect(rootOf("https://gw.example.com/v1")).toBe("https://gw.example.com");
    expect(snippet("anthropic-python", o)).toContain('base_url="https://gw.example.com"');
    expect(snippet("python", o)).toContain('base_url="https://gw.example.com/v1"');
  });
});

describe("console helpers", () => {
  it("previews a top-up as the server prices it", () => {
    expect(previewTopup("USD", 10, 0, 85)).toEqual({ taxMinor: 0, totalMinor: 1000, creditMicros: 10_000_000 });
    expect(previewTopup("USD", 10, 1800, 85)).toEqual({ taxMinor: 180, totalMinor: 1180, creditMicros: 10_000_000 });
    expect(previewTopup("INR", 1000, 0, 85).creditMicros).toBe(11_764_705);
  });
  it("turns the key form into API input, or explains what is wrong", () => {
    const base = { name: "Server", expiresAt: "", allModels: true, models: [], budget: "", rpm: "", tpm: "", ips: "", logBodies: false };
    expect(formToInput(base)).toEqual({ input: { name: "Server", expiresAt: null, allowedModels: [], monthlyBudgetMicros: null, rpm: null, tpm: null, ipAllowlist: [], logBodies: false } });
    const full = formToInput({ ...base, allModels: false, models: ["stub-chat"], budget: "25", rpm: "60", ips: "203.0.113.7\n198.51.100.0/24, ::1", expiresAt: "2030-01-31" });
    expect(full).toMatchObject({ input: { allowedModels: ["stub-chat"], monthlyBudgetMicros: 25_000_000, rpm: 60, ipAllowlist: ["203.0.113.7", "198.51.100.0/24", "::1"], expiresAt: "2030-01-31T23:59:59.000Z" } });
    expect(formToInput({ ...base, name: " ", budget: "x", rpm: "1.5", allModels: false })).toEqual({ errors: { name: expect.any(String), budget: expect.any(String), rpm: expect.any(String), models: expect.any(String) } });
  });
  it("splits an SSE stream across chunk boundaries", () => {
    const a = splitSse('data: {"a":1}\n\ndata: {"b"');
    expect(a).toEqual({ events: ['{"a":1}'], rest: 'data: {"b"' });
    expect(splitSse(`${a.rest}:2}\n\ndata: [DONE]\n\n`)).toEqual({ events: ['{"b":2}', "[DONE]"], rest: "" });
    expect(splitSse("event: x\r\ndata: y\r\n\r\n").events).toEqual(["y"]);
  });
  it("shows only the prices a model kind is billed on", () => {
    const p = { inputMicrosPerMtok: 500_000, outputMicrosPerMtok: 1_500_000, cachedMicrosPerMtok: null, unitMicros: 40_000 };
    expect(priceParts("CHAT", p).map((x) => x.label)).toEqual(["Input", "Output"]);
    expect(priceParts("IMAGE", p)).toEqual([{ label: "Per image", value: "$0.04" }]);
    expect(priceParts("EMBEDDING", p)).toHaveLength(1);
  });
  it("describes request status and nav state", () => {
    expect(requestStatus(200, null)).toEqual({ text: "200", tone: "ok" });
    expect(requestStatus(200, "stream_interrupted").tone).toBe("warn");
    expect(requestStatus(429, "rate_limit_exceeded")).toEqual({ text: "429 rate_limit_exceeded", tone: "error" });
    expect(activeConsoleHref("/")).toBe("/");
    expect(activeConsoleHref("/keys")).toBe("/keys");
    expect(activeConsoleHref("/usage/x")).toBe("/usage");
    expect(activeConsoleHref("/admin")).toBeNull();
    expect(lastDays(7, new Date("2026-10-28T10:00:00Z"))).toEqual({ from: "2026-10-22", to: "2026-10-28" });
  });
});
