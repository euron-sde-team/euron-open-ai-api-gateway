import { describe, expect, it } from "vitest";
import { ipAllowed, isIpEntry } from "../../src/gateway/auth";

describe("ipAllowed", () => {
  it("allows everything when the list is empty", () => {
    expect(ipAllowed(undefined, [])).toBe(true);
    expect(ipAllowed("203.0.113.4", [])).toBe(true);
  });

  it("refuses an unknown address when the list is not empty", () => {
    expect(ipAllowed(undefined, ["203.0.113.4"])).toBe(false);
  });

  it("matches exact IPv4 addresses and CIDRs", () => {
    expect(ipAllowed("203.0.113.4", ["203.0.113.4"])).toBe(true);
    expect(ipAllowed("203.0.113.5", ["203.0.113.4"])).toBe(false);
    expect(ipAllowed("10.1.2.3", ["10.0.0.0/8"])).toBe(true);
    expect(ipAllowed("192.0.2.1", ["10.0.0.0/8"])).toBe(false);
    expect(ipAllowed("192.168.1.77", ["172.16.0.0/12", "192.168.1.0/24"])).toBe(true);
    expect(ipAllowed("198.51.100.8", ["0.0.0.0/0"])).toBe(true);
  });

  it("matches IPv6 addresses and CIDRs", () => {
    expect(ipAllowed("2001:db8::1", ["2001:db8::1"])).toBe(true);
    expect(ipAllowed("2001:db8::1", ["2001:db8::/32"])).toBe(true);
    expect(ipAllowed("2001:db9::1", ["2001:db8::/32"])).toBe(false);
    expect(ipAllowed("::1", ["::1/128"])).toBe(true);
  });

  it("treats IPv4-mapped IPv6 as the IPv4 address", () => {
    expect(ipAllowed("::ffff:203.0.113.4", ["203.0.113.4"])).toBe(true);
    expect(ipAllowed("::ffff:10.0.0.5", ["10.0.0.0/24"])).toBe(true);
    expect(ipAllowed("203.0.113.4", ["::ffff:203.0.113.4"])).toBe(true);
  });

  it("never matches across families or on malformed entries", () => {
    expect(ipAllowed("203.0.113.4", ["::/0"])).toBe(false);
    expect(ipAllowed("2001:db8::1", ["0.0.0.0/0"])).toBe(false);
    expect(ipAllowed("203.0.113.4", ["not-an-ip/8"])).toBe(false);
    expect(ipAllowed("203.0.113.4", ["203.0.113.0/40"])).toBe(false);
    expect(ipAllowed("203.0.113.4", [""])).toBe(false);
  });
});

describe("isIpEntry", () => {
  it("accepts addresses and CIDRs of both families", () => {
    for (const e of [
      "203.0.113.4",
      "10.0.0.0/8",
      "0.0.0.0/0",
      "::1",
      "2001:db8::/32",
      "2001:db8::1/128",
      "::ffff:203.0.113.4",
      " 10.0.0.1 ",
    ])
      expect(isIpEntry(e), e).toBe(true);
  });

  it("refuses malformed entries and prefixes that do not fit", () => {
    for (const e of [
      "",
      "hello",
      "1.2.3",
      "256.1.1.1",
      "203.0.113.4/33",
      "2001:db8::/129",
      "203.0.113.4/",
      "203.0.113.4/abc",
      "203.0.113.4/8/1",
      "1:2:3:4:5:6:7:8:9",
      "gggg::1",
    ])
      expect(isIpEntry(e), e).toBe(false);
  });
});

describe("allow-list normalisation", () => {
  it("matches an exact IPv6 entry however it is written", async () => {
    const { ipAllowed, isIpEntry } = await import("../../src/gateway/auth");
    expect(ipAllowed("2001:db8::1", ["2001:DB8::1"])).toBe(true);
    expect(ipAllowed("2001:db8::1", ["2001:db8:0::1"])).toBe(true);
    expect(isIpEntry("2001:db8::12zz")).toBe(false);
    expect(isIpEntry("2001:db8::12345")).toBe(false);
  });
});
