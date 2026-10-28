/**
 * Money and usage formatting shared by the console and /admin. The API speaks integer
 * micro-USD (1 USD = 1 000 000), basis points for margins, and minor units (cents or
 * paise) for top-ups. Pure (tested in test/money.test.ts).
 */

/** "$12.40"; amounts under a cent keep up to six decimals ("$0.000184") so a cheap request never reads as zero. */
export function usd(micros: number, locale?: string): string {
  const v = micros / 1_000_000;
  const abs = Math.abs(v);
  const digits = abs === 0 || abs >= 0.01 ? 2 : 6;
  return new Intl.NumberFormat(locale, { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: digits }).format(v);
}

/** A ledger amount with an explicit sign: "+$10.00", "-$0.0031". */
export function signedUsd(micros: number, locale?: string): string {
  return `${micros > 0 ? "+" : micros < 0 ? "-" : ""}${usd(Math.abs(micros), locale)}`;
}

/** A per-million-token price: "$2.50 / 1M". */
export function perMillion(micros: number, locale?: string): string {
  return `${usd(micros, locale)} / 1M`;
}

/** Minor units of a currency: 123450 INR is "₹1,234.50", 1000 USD is "$10.00". */
export function minor(amountMinor: number, currency: "USD" | "INR", locale?: string): string {
  return new Intl.NumberFormat(locale ?? (currency === "INR" ? "en-IN" : undefined), { style: "currency", currency, minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(amountMinor / 100);
}

/** "₹1,234.50" from a decimal rupee amount. */
export function inr(v: number): string {
  return new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2 }).format(v);
}

/** Basis points as a percent: 1500 is "15%", 250 is "2.5%", 0 is "0% (at cost)" when `atCost`. */
export function bpsLabel(bps: number, atCost = false): string {
  const pct = `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(bps / 100)}%`;
  return bps === 0 && atCost ? `${pct} (at cost)` : pct;
}

/** Dollars typed into a form to micro-USD (rounded to the micro). Null for anything not a non-negative number. */
export function dollarsToMicros(input: string): number | null {
  const t = input.trim().replace(/^\$/, "");
  if (!/^\d+(\.\d{0,6})?$/.test(t)) return null;
  return Math.round(Number(t) * 1_000_000);
}

/** A percent typed into a form to basis points: "15" is 1500, "2.5" is 250. */
export function percentToBps(input: string): number | null {
  const t = input.trim().replace(/%$/, "");
  if (!/^\d+(\.\d{0,2})?$/.test(t)) return null;
  return Math.round(Number(t) * 100);
}

/** 12,345 or 3.5M for large token counts. */
export function tokensLabel(v: number, locale?: string): string {
  return new Intl.NumberFormat(locale, { notation: v >= 100_000 ? "compact" : "standard", maximumFractionDigits: 1 }).format(v);
}

/** "840 ms", "2.4 s". */
export function msLabel(v: number | null | undefined): string {
  if (v === null || v === undefined) return "";
  return v < 1000 ? `${Math.round(v)} ms` : `${(v / 1000).toFixed(v < 10_000 ? 1 : 0)} s`;
}

/** What a top-up costs and credits, before the server confirms it (it prices the order itself). */
export function previewTopup(currency: "USD" | "INR", amount: number, taxBps: number, inrPerUsd: number): { taxMinor: number; totalMinor: number; creditMicros: number } {
  const amountMinor = Math.round(amount * 100);
  const taxMinor = Math.ceil((amountMinor * taxBps) / 10_000);
  const creditMicros = currency === "USD" ? amountMinor * 10_000 : Math.floor((amountMinor * 10_000) / inrPerUsd);
  return { taxMinor, totalMinor: amountMinor + taxMinor, creditMicros };
}
