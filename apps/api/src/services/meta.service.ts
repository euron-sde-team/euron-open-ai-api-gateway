/** GET /api/meta: what a client needs before anyone signs in. Never a key, never a provider name. */
import type { AppMeta } from "@open-gateway/types";
import { config } from "../core/config";
import { gatewayFor } from "../billing/payments";
import { inrPerUsd } from "./fx.service";
import { getSettings } from "./settings.service";

export async function appMeta(): Promise<AppMeta> {
  const [s, rate] = await Promise.all([getSettings(), inrPerUsd()]);
  const topups: AppMeta["billing"]["topups"] = [];
  for (const currency of ["USD", "INR"] as const) {
    const gateway = gatewayFor(currency);
    if (!gateway) continue;
    const [min, max] = currency === "USD" ? [s.topupLimits.usdMin, s.topupLimits.usdMax] : [s.topupLimits.inrMin, s.topupLimits.inrMax];
    topups.push({ currency, gateway: gateway.name, minMinor: Math.round(min * 100), maxMinor: Math.round(max * 100) });
  }
  return {
    appName: s.appName,
    tagline: s.tagline,
    registration: s.registration,
    gatewayBaseUrl: s.gatewayBaseUrl,
    keyPrefix: config.API_KEY_PREFIX,
    billing: { topups, taxBps: s.taxBps, taxLabel: s.taxLabel, signupCreditMicros: s.signupCreditMicros, inrPerUsd: rate },
    support: { email: s.supportEmail },
    minSupportedVersion: s.minSupportedVersion,
  };
}
