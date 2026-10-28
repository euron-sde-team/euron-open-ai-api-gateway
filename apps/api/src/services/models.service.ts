/**
 * The public model catalogue (GET /api/catalog): every model a key can call right now,
 * with the price a caller pays at the default margin (the model's own margin if it has
 * one). Account and key margin overrides are private to the admin who set them, so
 * the console shows an account its own effective prices from `catalogFor`.
 */
import type { ModelInfo } from "@open-gateway/types";
import { db } from "../db/kysely";
import { catalog, type CatalogModel } from "../gateway/catalog";
import { effectiveMargin, priceList } from "../gateway/pricing";
import { getSettings } from "./settings.service";

function toInfo(m: CatalogModel, marginBps: number): ModelInfo {
  return {
    id: m.id,
    kind: m.kind,
    displayName: m.displayName,
    description: m.description,
    ownedBy: m.ownedBy,
    aliases: m.aliases,
    contextWindow: m.contextWindow,
    maxOutputTokens: m.maxOutputTokens,
    supportsTools: m.supportsTools,
    supportsVision: m.supportsVision,
    supportsJson: m.supportsJson,
    price: priceList(m.listCost, marginBps),
    routes: m.routes.length,
  };
}

export async function publicCatalog(): Promise<ModelInfo[]> {
  const [{ models }, s] = await Promise.all([catalog(), getSettings()]);
  return models.map((m) => toInfo(m, effectiveMargin(null, null, m.marginBps, s.defaultMarginBps)));
}

/** The catalogue at one account's margin (keys may still override it per key). */
export async function catalogFor(userId: string): Promise<ModelInfo[]> {
  const [{ models }, s, user] = await Promise.all([catalog(), getSettings(), db.selectFrom("users").select("margin_bps").where("id", "=", userId).executeTakeFirst()]);
  return models.map((m) => toInfo(m, effectiveMargin(null, user?.margin_bps ?? null, m.marginBps, s.defaultMarginBps)));
}
