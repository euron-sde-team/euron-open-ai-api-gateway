import { describe, expect, it } from "vitest";
import { ApiError } from "@open-gateway/api-client";
import { exportErrorMessage } from "@/lib/account";
import { exportFileName } from "@/lib/download";
import { resolveProductName } from "@/lib/meta";

const fallback = () => "fallback";

describe("data export", () => {
  it("names the file after the username", () => {
    expect(exportFileName("ada_l")).toBe("ada_l-export.json");
    expect(exportFileName("a/b")).toBe("a_b-export.json");
  });
  it("explains the daily limit on 429", () => {
    expect(exportErrorMessage(new ApiError({ status: 429, code: "RATE_LIMITED", message: "x" }), fallback)).toBe("You can export 3 times a day. Try again tomorrow.");
    expect(exportErrorMessage(new ApiError({ status: 500, code: "SERVER_ERROR", message: "x" }), fallback)).toBe("fallback");
  });
});

describe("app name", () => {
  it("uses the admin-set name when set, else the runtime product name", () => {
    expect(resolveProductName({ appName: "Book Club" }, "Open AI Chat")).toBe("Book Club");
    expect(resolveProductName({ appName: "  " }, "Open AI Chat")).toBe("Open AI Chat");
    expect(resolveProductName(undefined, "Open AI Chat")).toBe("Open AI Chat");
  });
});
