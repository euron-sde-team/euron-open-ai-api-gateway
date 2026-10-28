import { describe, expect, it } from "vitest";
import { hashApiKey, keyHint, looksLikeApiKey, newApiKey } from "../../src/security/api-keys";

describe("newApiKey", () => {
  it("is gw- followed by 40 base62 characters", () => {
    for (let i = 0; i < 50; i++) expect(newApiKey()).toMatch(/^gw-[A-Za-z0-9]{40}$/);
  });

  it("never repeats over many draws", () => {
    const keys = new Set(Array.from({ length: 2000 }, () => newApiKey()));
    expect(keys.size).toBe(2000);
  });
});

describe("looksLikeApiKey", () => {
  it("accepts generated keys and refuses the wrong prefix, length or alphabet", () => {
    expect(looksLikeApiKey(newApiKey())).toBe(true);
    expect(looksLikeApiKey(`sk-${"a".repeat(40)}`)).toBe(false);
    expect(looksLikeApiKey(`gw-${"a".repeat(39)}`)).toBe(false);
    expect(looksLikeApiKey(`gw-${"a".repeat(41)}`)).toBe(false);
    expect(looksLikeApiKey(`gw-${"a".repeat(39)}-`)).toBe(false);
    expect(looksLikeApiKey("")).toBe(false);
  });
});

describe("keyHint", () => {
  it("keeps the prefix, the first four and the last four characters", () => {
    expect(keyHint(`gw-abcd${"x".repeat(32)}wxyz`)).toBe("gw-abcd...wxyz");
  });
});

describe("hashApiKey", () => {
  it("is a deterministic hex digest that does not contain the key", () => {
    const key = newApiKey();
    const h = hashApiKey(key);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(hashApiKey(key)).toBe(h);
    expect(h).not.toContain(key.slice(3));
    expect(hashApiKey(newApiKey())).not.toBe(h);
  });
});
