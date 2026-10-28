import { describe, expect, it } from "vitest";
import { priceTopup } from "../../src/services/billing.service";

describe("priceTopup", () => {
  it("credits USD one to one in micro-USD and adds tax on top", () => {
    expect(priceTopup("USD", 10, 1800, 85)).toEqual({
      amountMinor: 1000,
      taxMinor: 180,
      totalMinor: 1180,
      creditMicros: 10_000_000,
      inrPerUsd: null,
    });
  });

  it("converts INR at the locked rate, rounding the credit down", () => {
    // 100000 paise x 10000 / 85 = 11764705.88
    expect(priceTopup("INR", 1000, 1800, 85)).toEqual({
      amountMinor: 100_000,
      taxMinor: 18_000,
      totalMinor: 118_000,
      creditMicros: 11_764_705,
      inrPerUsd: 85,
    });
    expect(priceTopup("INR", 1, 0, 83.5).creditMicros).toBe(11_976);
  });

  it("rounds tax up and never credits it", () => {
    const p = priceTopup("USD", 0.01, 1800, 85);
    expect(p).toMatchObject({ amountMinor: 1, taxMinor: 1, totalMinor: 2, creditMicros: 10_000 });
    expect(priceTopup("USD", 10, 0, 85).creditMicros).toBe(
      priceTopup("USD", 10, 1800, 85).creditMicros
    );
  });

  it("converts a fractional amount to whole minor units", () => {
    expect(priceTopup("USD", 19.99, 0, 85)).toMatchObject({
      amountMinor: 1999,
      totalMinor: 1999,
      creditMicros: 19_990_000,
    });
  });
});
