/** /api/admin. Admins only; every service call starts with requireAdmin. */
import type { Request, Response } from "express";
import { z } from "zod";
import { requireAdmin } from "../core/context";
import { badRequest } from "../core/errors";
import { id, idParam, parse } from "../core/validate";
import { actorOf, meta } from "../middleware/http";
import * as catalogAdmin from "../services/admin-catalog.service";
import * as admin from "../services/admin.service";
import { listAudit } from "../services/audit.service";

const page = { cursor: z.string().max(300).optional(), limit: z.coerce.number().int().min(1).max(100).default(30) };
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
/** Basis points: 0 (at cost) up to 100 000 (11x). */
const bps = z.number().int().min(0).max(100_000);
/** Micro-USD: up to 1 million dollars in one entry. */
const micros = z.number().int().min(-1_000_000_000_000).max(1_000_000_000_000);
const perMinuteLimit = z.number().int().min(1).max(10_000_000).nullable();

export async function me(req: Request, res: Response) {
  const a = requireAdmin(actorOf(req));
  res.json({ role: a.role });
}

export async function stats(req: Request, res: Response) {
  const today = new Date().toISOString().slice(0, 10);
  const monthAgo = new Date(Date.now() - 29 * 86_400_000).toISOString().slice(0, 10);
  const q = parse(z.object({ from: day.default(monthAgo), to: day.default(today) }), req.query);
  if (q.from > q.to) throw badRequest("from must be before to", "RANGE_INVALID");
  if ((Date.parse(q.to) - Date.parse(q.from)) / 86_400_000 > 366) throw badRequest("At most a year at a time", "RANGE_TOO_LONG");
  res.json(await admin.stats(actorOf(req), q.from, q.to));
}

// ─── Accounts ───────────────────────────────────────────────────────────────

export async function users(req: Request, res: Response) {
  const q = parse(z.object({ ...page, q: z.string().max(200).optional(), status: z.enum(["PENDING_VERIFICATION", "ACTIVE", "SUSPENDED", "BANNED", "DEACTIVATED"]).optional(), role: z.enum(["USER", "ADMIN"]).optional(), tierId: id().optional() }), req.query);
  res.json(await admin.listUsers(actorOf(req), q));
}
export async function user(req: Request, res: Response) {
  res.json(await admin.userDetail(actorOf(req), parse(idParam, req.params).id));
}
export async function setRole(req: Request, res: Response) {
  res.json(await admin.setRole(actorOf(req), parse(idParam, req.params).id, parse(z.object({ role: z.enum(["USER", "ADMIN"]) }).strict(), req.body).role, meta(req)));
}
export function status(action: "suspend" | "unsuspend" | "ban" | "unban") {
  return async (req: Request, res: Response) => {
    const body = parse(z.object({ days: z.number().int().min(1).max(365).optional(), reason: z.string().trim().max(300).optional() }).strict(), req.body);
    res.json(await admin.setStatus(actorOf(req), parse(idParam, req.params).id, action, body, meta(req)));
  };
}
export async function erase(req: Request, res: Response) {
  const body = parse(z.object({ reason: z.string().trim().min(3).max(300) }).strict(), req.body);
  await admin.eraseUser(actorOf(req), parse(idParam, req.params).id, body.reason, meta(req));
  res.status(204).end();
}
export async function setTier(req: Request, res: Response) {
  res.json(await admin.setUserTier(actorOf(req), parse(idParam, req.params).id, parse(z.object({ tierId: id().nullable() }).strict(), req.body).tierId, meta(req)));
}
export async function setUserMargin(req: Request, res: Response) {
  res.json(await admin.setUserMargin(actorOf(req), parse(idParam, req.params).id, parse(z.object({ marginBps: bps.nullable() }).strict(), req.body).marginBps, meta(req)));
}
export async function setKeyMargin(req: Request, res: Response) {
  const p = parse(z.object({ id: id(), keyId: id() }), req.params);
  res.json(await admin.setKeyMargin(actorOf(req), p.id, p.keyId, parse(z.object({ marginBps: bps.nullable() }).strict(), req.body).marginBps, meta(req)));
}
export async function credit(req: Request, res: Response) {
  const body = parse(z.object({ type: z.enum(["GRANT", "ADJUSTMENT"]), amountMicros: micros, reason: z.string().trim().min(3).max(300) }).strict(), req.body);
  res.json(await admin.creditUser(actorOf(req), parse(idParam, req.params).id, body, meta(req)));
}

// ─── Rate-limit tiers ───────────────────────────────────────────────────────

const tierBody = z.object({ name: z.string().trim().min(1).max(60), rpm: perMinuteLimit, tpm: perMinuteLimit, concurrency: z.number().int().min(1).max(10_000).nullable(), isDefault: z.boolean().optional() }).strict();
export async function tiers(req: Request, res: Response) {
  res.json(await admin.listTiers(actorOf(req)));
}
export async function createTier(req: Request, res: Response) {
  res.status(201).json(await admin.saveTier(actorOf(req), null, parse(tierBody, req.body), meta(req)));
}
export async function updateTier(req: Request, res: Response) {
  res.json(await admin.saveTier(actorOf(req), parse(idParam, req.params).id, parse(tierBody, req.body), meta(req)));
}
export async function deleteTier(req: Request, res: Response) {
  res.json(await admin.deleteTier(actorOf(req), parse(idParam, req.params).id, meta(req)));
}

// ─── Providers and credentials ──────────────────────────────────────────────

const slug = z.string().regex(/^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/, "lowercase letters, digits and hyphens");
const providerBody = z.object({ kind: z.enum(["OPENAI_COMPATIBLE", "ANTHROPIC", "GEMINI", "STUB"]), displayName: z.string().trim().min(1).max(60), baseUrl: z.string().trim().max(300).nullable(), enabled: z.boolean() }).strict();
const providerParam = z.object({ id: slug });
export async function providers(req: Request, res: Response) {
  res.json(await catalogAdmin.listProviders(actorOf(req)));
}
export async function createProvider(req: Request, res: Response) {
  res.status(201).json(await catalogAdmin.saveProvider(actorOf(req), parse(providerBody.extend({ id: slug }), req.body), true, meta(req)));
}
export async function updateProvider(req: Request, res: Response) {
  const p = parse(providerParam, req.params);
  res.json(await catalogAdmin.saveProvider(actorOf(req), { ...parse(providerBody, req.body), id: p.id }, false, meta(req)));
}
export async function deleteProvider(req: Request, res: Response) {
  res.json(await catalogAdmin.deleteProvider(actorOf(req), parse(providerParam, req.params).id, meta(req)));
}
export async function addCredential(req: Request, res: Response) {
  const body = parse(z.object({ label: z.string().trim().min(1).max(60), secret: z.string().min(8).max(4000) }).strict(), req.body);
  res.status(201).json(await catalogAdmin.addCredential(actorOf(req), parse(providerParam, req.params).id, body, meta(req)));
}
export async function setCredentialEnabled(req: Request, res: Response) {
  const p = parse(z.object({ id: slug, credentialId: id() }), req.params);
  res.json(await catalogAdmin.setCredentialEnabled(actorOf(req), p.id, p.credentialId, parse(z.object({ enabled: z.boolean() }).strict(), req.body).enabled, meta(req)));
}
export async function deleteCredential(req: Request, res: Response) {
  const p = parse(z.object({ id: slug, credentialId: id() }), req.params);
  res.json(await catalogAdmin.deleteCredential(actorOf(req), p.id, p.credentialId, meta(req)));
}

// ─── Models and routes ──────────────────────────────────────────────────────

const modelId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,118}[A-Za-z0-9]$/, "letters, digits and . _ : / -");
const modelBody = z
  .object({
    kind: z.enum(["CHAT", "EMBEDDING", "IMAGE", "SPEECH", "TRANSCRIPTION"]),
    displayName: z.string().trim().min(1).max(80),
    description: z.string().trim().max(300).optional(),
    ownedBy: z.string().trim().max(60).optional(),
    aliases: z.array(modelId).max(20).optional(),
    contextWindow: z.number().int().min(1).max(100_000_000).nullable().optional(),
    maxOutputTokens: z.number().int().min(1).max(10_000_000).nullable().optional(),
    supportsTools: z.boolean().optional(),
    supportsVision: z.boolean().optional(),
    supportsJson: z.boolean().optional(),
    marginBps: bps.nullable().optional(),
    enabled: z.boolean().optional(),
    sortOrder: z.number().int().min(0).max(10_000).optional(),
  })
  .strict();
// Model ids may contain "/" (vendor/model), so they travel URL-encoded in one path segment.
const modelParam = z.object({ id: modelId });
const priceMicros = z.number().int().min(0).max(1_000_000_000_000);
const routeBody = z
  .object({
    providerId: slug,
    upstreamModel: z.string().trim().min(1).max(160),
    priority: z.number().int().min(1).max(100),
    timeoutMs: z.number().int().min(1000).max(600_000).optional(),
    inputMicrosPerMtok: priceMicros,
    outputMicrosPerMtok: priceMicros,
    cachedMicrosPerMtok: priceMicros.nullable().optional(),
    unitMicros: priceMicros.optional(),
    enabled: z.boolean().optional(),
  })
  .strict();

export async function models(req: Request, res: Response) {
  res.json(await catalogAdmin.listModels(actorOf(req)));
}
export async function createModel(req: Request, res: Response) {
  const body = parse(modelBody.extend({ id: modelId }), req.body);
  res.status(201).json(await catalogAdmin.saveModel(actorOf(req), body.id, body, true, meta(req)));
}
export async function updateModel(req: Request, res: Response) {
  res.json(await catalogAdmin.saveModel(actorOf(req), parse(modelParam, req.params).id, parse(modelBody, req.body), false, meta(req)));
}
export async function deleteModel(req: Request, res: Response) {
  res.json(await catalogAdmin.deleteModel(actorOf(req), parse(modelParam, req.params).id, meta(req)));
}
export async function addRoute(req: Request, res: Response) {
  res.status(201).json(await catalogAdmin.saveRoute(actorOf(req), parse(modelParam, req.params).id, null, parse(routeBody, req.body), meta(req)));
}
export async function updateRoute(req: Request, res: Response) {
  const p = parse(z.object({ id: modelId, routeId: id() }), req.params);
  res.json(await catalogAdmin.saveRoute(actorOf(req), p.id, p.routeId, parse(routeBody, req.body), meta(req)));
}
export async function deleteRoute(req: Request, res: Response) {
  const p = parse(z.object({ id: modelId, routeId: id() }), req.params);
  res.json(await catalogAdmin.deleteRoute(actorOf(req), p.id, p.routeId, meta(req)));
}
export async function testRoute(req: Request, res: Response) {
  const p = parse(z.object({ id: modelId, routeId: id() }), req.params);
  res.json(await catalogAdmin.testRoute(actorOf(req), p.id, p.routeId));
}

// ─── Health ─────────────────────────────────────────────────────────────────

export async function health(req: Request, res: Response) {
  res.json(await catalogAdmin.health(actorOf(req)));
}
export async function setCircuit(req: Request, res: Response) {
  const p = parse(z.object({ routeId: id() }), req.params);
  await catalogAdmin.setCircuit(actorOf(req), p.routeId, parse(z.object({ state: z.enum(["open", "closed"]) }).strict(), req.body).state, meta(req));
  res.status(204).end();
}

// ─── Top-ups and promo codes ────────────────────────────────────────────────

export async function topups(req: Request, res: Response) {
  const q = parse(z.object({ ...page, status: z.enum(["CREATED", "PAID", "FAILED", "REFUNDED"]).optional(), userId: id().optional() }), req.query);
  res.json(await admin.listTopups(actorOf(req), q));
}
export async function refundTopup(req: Request, res: Response) {
  await admin.refundTopup(actorOf(req), parse(idParam, req.params).id, parse(z.object({ reason: z.string().trim().min(3).max(200) }).strict(), req.body).reason, meta(req));
  res.status(204).end();
}
export async function promos(req: Request, res: Response) {
  res.json(await admin.listPromos(actorOf(req)));
}
export async function createPromo(req: Request, res: Response) {
  const body = parse(
    z
      .object({
        code: z.string().trim().regex(/^[A-Za-z0-9_-]{3,40}$/, "3 to 40 letters, digits, - or _"),
        amountMicros: z.number().int().min(1).max(1_000_000_000_000),
        maxRedemptions: z.number().int().min(1).max(10_000_000).nullable().optional(),
        expiresAt: z.string().datetime().nullable().optional(),
      })
      .strict(),
    req.body,
  );
  res.status(201).json(await admin.createPromo(actorOf(req), body, meta(req)));
}
export async function setPromoActive(req: Request, res: Response) {
  res.json(await admin.setPromoActive(actorOf(req), parse(idParam, req.params).id, parse(z.object({ active: z.boolean() }).strict(), req.body).active, meta(req)));
}

// ─── Settings, integrations, audit ──────────────────────────────────────────

const settingsBody = z
  .object({
    appName: z.string().trim().min(1).max(60),
    tagline: z.string().trim().max(160),
    registration: z.enum(["OPEN", "INVITE_ONLY", "CLOSED"]),
    allowedEmailDomains: z.array(z.string().trim().toLowerCase().regex(/^[a-z0-9.-]+\.[a-z]{2,}$/)).max(100),
    supportEmail: z.string().trim().email().max(200).nullable(),
    gatewayBaseUrl: z.string().trim().url().max(300),
    defaultMarginBps: bps,
    signupCreditMicros: z.number().int().min(0).max(1_000_000_000),
    taxBps: z.number().int().min(0).max(5_000),
    taxLabel: z.string().trim().min(1).max(30),
    topupLimits: z.object({ usdMin: z.number().min(1).max(100_000), usdMax: z.number().min(1).max(100_000), inrMin: z.number().min(1).max(10_000_000), inrMax: z.number().min(1).max(10_000_000) }).partial().strict(),
    lowBalanceMicros: z.number().int().min(0).max(1_000_000_000),
    bodyRetentionDays: z.number().int().min(1).max(90),
    requestRetentionDays: z.number().int().min(30).max(3650).nullable(),
    minSupportedVersion: z.string().regex(/^\d+\.\d+\.\d+$/).nullable(),
  })
  .partial()
  .strict();
export async function getSettings(req: Request, res: Response) {
  res.json(await admin.readSettings(actorOf(req)));
}
export async function patchSettings(req: Request, res: Response) {
  res.json(await admin.updateSettings(actorOf(req), parse(settingsBody, req.body) as admin.SettingsPatch, meta(req)));
}
export async function integrations(req: Request, res: Response) {
  res.json(await admin.integrations(actorOf(req)));
}

export async function audit(req: Request, res: Response) {
  const q = parse(z.object({ ...page, action: z.string().max(80).optional(), actorId: id().optional(), entityType: z.string().max(40).optional(), entityId: z.string().max(64).optional() }), req.query);
  res.json(await listAudit(actorOf(req), q));
}
