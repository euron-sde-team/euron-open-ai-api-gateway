import { describe, expect, it } from "vitest";
import {
  effectiveMargin,
  microsToUsd,
  priceList,
  tokenAmount,
  unitAmount,
  withMargin,
} from "../../src/gateway/pricing";

describe("effectiveMargin", () => {
  it("prefers key, then account, then model, then default", () => {
    expect(effectiveMargin(250, 500, 300, 1000)).toBe(250);
    expect(effectiveMargin(null, 500, 300, 1000)).toBe(500);
    expect(effectiveMargin(undefined, null, 300, 1000)).toBe(300);
    expect(effectiveMargin(null, undefined, null, 1000)).toBe(1000);
  });

  it("treats 0 as a real margin, not unset", () => {
    expect(effectiveMargin(0, 500, 300, 1000)).toBe(0);
    expect(effectiveMargin(null, 0, 300, 1000)).toBe(0);
    expect(effectiveMargin(null, null, 0, 1000)).toBe(0);
  });
});

describe("withMargin", () => {
  it("adds the margin and rounds up", () => {
    expect(withMargin(100, 2000)).toBe(120);
    expect(withMargin(333, 0)).toBe(333);
    expect(withMargin(1, 1)).toBe(2);
    expect(withMargin(3_000_000, 1500)).toBe(3_450_000);
  });

  it("is 0 for zero or negative cost", () => {
    expect(withMargin(0, 5000)).toBe(0);
    expect(withMargin(-5, 5000)).toBe(0);
  });
});

describe("priceList", () => {
  it("applies the margin to every price and keeps a null cached price null", () => {
    expect(
      priceList(
        {
          inputMicrosPerMtok: 3_000_000,
          outputMicrosPerMtok: 15_000_000,
          cachedMicrosPerMtok: 300_000,
          unitMicros: 0,
        },
        1000
      )
    ).toEqual({
      inputMicrosPerMtok: 3_300_000,
      outputMicrosPerMtok: 16_500_000,
      cachedMicrosPerMtok: 330_000,
      unitMicros: 0,
    });
    expect(
      priceList(
        {
          inputMicrosPerMtok: 1,
          outputMicrosPerMtok: 1,
          cachedMicrosPerMtok: null,
          unitMicros: 40_000,
        },
        1000
      ).cachedMicrosPerMtok
    ).toBeNull();
    expect(
      priceList(
        {
          inputMicrosPerMtok: 1,
          outputMicrosPerMtok: 1,
          cachedMicrosPerMtok: null,
          unitMicros: 40_000,
        },
        1000
      ).unitMicros
    ).toBe(44_000);
  });
});

describe("tokenAmount", () => {
  const p = {
    inputMicrosPerMtok: 3_000_000,
    outputMicrosPerMtok: 15_000_000,
    cachedMicrosPerMtok: 300_000,
  };

  it("bills fresh input, cached input and output at their own prices", () => {
    // 600 x 3 + 400 x 0.3 + 500 x 15 = 9420 micros
    expect(tokenAmount(p, { inputTokens: 1000, outputTokens: 500, cachedTokens: 400 })).toBe(9420);
  });

  it("never counts more cached tokens than input tokens", () => {
    expect(tokenAmount(p, { inputTokens: 100, outputTokens: 0, cachedTokens: 500 })).toBe(30);
  });

  it("bills cached tokens at the input price when there is no cached price", () => {
    expect(
      tokenAmount(
        { ...p, cachedMicrosPerMtok: null },
        { inputTokens: 1000, outputTokens: 0, cachedTokens: 400 }
      )
    ).toBe(3000);
  });

  it("rounds up and ignores negative counts", () => {
    expect(
      tokenAmount(
        { inputMicrosPerMtok: 1, outputMicrosPerMtok: 1, cachedMicrosPerMtok: null },
        { inputTokens: 1, outputTokens: 0, cachedTokens: 0 }
      )
    ).toBe(1);
    expect(tokenAmount(p, { inputTokens: 0, outputTokens: 0, cachedTokens: 0 })).toBe(0);
    expect(tokenAmount(p, { inputTokens: -10, outputTokens: -10, cachedTokens: -10 })).toBe(0);
  });
});

describe("unitAmount", () => {
  it("multiplies per unit", () => {
    expect(unitAmount(40_000, 3)).toBe(120_000);
    expect(unitAmount(40_000, -1)).toBe(0);
  });

  it("divides by a million and rounds up for per-million prices", () => {
    expect(unitAmount(15_000_000, 1000, true)).toBe(15_000);
    expect(unitAmount(15_000_000, 1, true)).toBe(15);
    expect(unitAmount(1, 1, true)).toBe(1);
  });
});

describe("microsToUsd", () => {
  it("trims trailing zeros", () => {
    expect(microsToUsd(1_500_000)).toBe("1.5");
    expect(microsToUsd(2_000_000)).toBe("2");
    expect(microsToUsd(1)).toBe("0.000001");
  });
});
