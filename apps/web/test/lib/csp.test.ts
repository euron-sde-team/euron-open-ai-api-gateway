import { describe, expect, it } from "vitest";
import { buildCsp, RAZORPAY_FRAMES } from "@/middleware";
import { serverEnv } from "@/lib/runtime-env";

describe("content security policy", () => {
  it("is strict by default: same-origin connections, Razorpay's checkout frames only", () => {
    const csp = buildCsp({ nonce: "abc", dev: false });
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self' 'nonce-abc' 'strict-dynamic'");
    expect(csp).not.toContain("'unsafe-eval'");
    expect(csp).not.toContain("wasm-unsafe-eval");
    expect(csp).toContain("connect-src 'self';");
    expect(csp).toContain(`frame-src ${RAZORPAY_FRAMES.join(" ")}`);
    expect(csp).toContain("frame-ancestors 'none'");
    expect(RAZORPAY_FRAMES.every((o) => o.startsWith("https://"))).toBe(true);
  });
  it("allows eval and websockets for the dev server only", () => {
    expect(buildCsp({ nonce: "n", dev: true })).toContain("'unsafe-eval'");
    expect(buildCsp({ nonce: "n", dev: false })).not.toContain("ws:");
  });
});

describe("runtime env", () => {
  it("reads the container environment with defaults", () => {
    expect(serverEnv({})).toEqual({ productName: "Euron Open AI API Gateway", apiUrl: "/api" });
    expect(serverEnv({ PRODUCT_NAME: " Acme Gateway ", PUBLIC_API_URL: "https://api.example.org/api" })).toMatchObject({ productName: "Acme Gateway", apiUrl: "https://api.example.org/api" });
  });
});
