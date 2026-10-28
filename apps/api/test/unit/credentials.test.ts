import { describe, expect, it } from "vitest";
import { decryptCredential, encryptCredential, last4 } from "../../src/security/credentials";

describe("provider credentials at rest", () => {
  const secret = "sk-test-fake-provider-key-0001";

  it("round trips for the same credential id and hides the plaintext", () => {
    const enc = encryptCredential(secret, "cred_1");
    expect(enc).toMatch(/^v1:[A-Za-z0-9_-]+$/);
    expect(enc).not.toContain(secret);
    expect(decryptCredential(enc, "cred_1")).toBe(secret);
  });

  it("uses a fresh IV each time", () => {
    expect(encryptCredential(secret, "cred_1")).not.toBe(encryptCredential(secret, "cred_1"));
  });

  it("does not decrypt under another credential id", () => {
    expect(() => decryptCredential(encryptCredential(secret, "cred_1"), "cred_2")).toThrow();
  });

  it("refuses tampered ciphertext and unknown formats", () => {
    const raw = Buffer.from(encryptCredential(secret, "cred_1").slice(3), "base64url");
    raw[raw.length - 1] ^= 1;
    expect(() => decryptCredential(`v1:${raw.toString("base64url")}`, "cred_1")).toThrow();
    expect(() => decryptCredential(secret, "cred_1")).toThrow(/unknown credential format/);
  });
});

describe("last4", () => {
  it("returns the last four characters after trimming", () => {
    expect(last4(" sk-abcd1234 \n")).toBe("1234");
    expect(last4("ab")).toBe("ab");
  });
});
