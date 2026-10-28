/** The developer console: meta, catalogue, keys, wallet, top-ups, promo codes and usage. Thin controllers. */
import type { Request, Response } from "express";
import { z } from "zod";
import { id, idParam, pageQuery, parse } from "../core/validate";
import { actorOf, meta as reqMeta } from "../middleware/http";
import * as billing from "../services/billing.service";
import * as keys from "../services/keys.service";
import { appMeta } from "../services/meta.service";
import { catalogFor, publicCatalog } from "../services/models.service";
import * as usage from "../services/usage.service";

export async function meta(_req: Request, res: Response) {
  res.setHeader("Cache-Control", "public, max-age=30");
  res.json(await appMeta());
}

/** Signed in: prices at the account's margin. Signed out: the public list prices. */
export async function catalog(req: Request, res: Response) {
  if (req.actor) {
    res.setHeader("Cache-Control", "private, no-store");
    res.json(await catalogFor(req.actor.id));
    return;
  }
  res.setHeader("Cache-Control", "public, max-age=30");
  res.json(await publicCatalog());
}

// ─── Keys ───────────────────────────────────────────────────────────────────

const modelName = z.string().trim().min(1).max(120);
const keyBody = z
  .object({
    name: z.string().trim().min(1).max(80),
    expiresAt: z.string().datetime().nullable().optional(),
    allowedModels: z.array(modelName).max(200).optional(),
    monthlyBudgetMicros: z.number().int().min(1).max(1_000_000_000_000).nullable().optional(),
    rpm: z.number().int().min(1).max(1_000_000).nullable().optional(),
    tpm: z.number().int().min(1).max(100_000_000).nullable().optional(),
    ipAllowlist: z.array(z.string().trim().min(2).max(64)).max(50).optional(),
    logBodies: z.boolean().optional(),
  })
  .strict();

export async function listKeys(req: Request, res: Response) {
  res.json(await keys.listKeys(actorOf(req)));
}
export async function createKey(req: Request, res: Response) {
  res.setHeader("Cache-Control", "no-store");
  res.status(201).json(await keys.createKey(actorOf(req), parse(keyBody, req.body), reqMeta(req)));
}
export async function updateKey(req: Request, res: Response) {
  res.json(await keys.updateKey(actorOf(req), parse(idParam, req.params).id, parse(keyBody.partial(), req.body), reqMeta(req)));
}
export async function revokeKey(req: Request, res: Response) {
  await keys.revokeKey(actorOf(req), parse(idParam, req.params).id, reqMeta(req));
  res.status(204).end();
}

// ─── Billing ────────────────────────────────────────────────────────────────

export async function wallet(req: Request, res: Response) {
  res.json(await billing.walletView(actorOf(req).id));
}
export async function ledger(req: Request, res: Response) {
  const q = parse(pageQuery.extend({ type: z.enum(["TOPUP", "GRANT", "PROMO", "SIGNUP", "USAGE", "REFUND", "ADJUSTMENT"]).optional() }), req.query);
  res.json(await billing.ledger(actorOf(req), q));
}
export async function topups(req: Request, res: Response) {
  res.json(await billing.topups(actorOf(req), parse(pageQuery, req.query)));
}
export async function topup(req: Request, res: Response) {
  res.json(await billing.topup(actorOf(req), parse(idParam, req.params).id));
}
export async function createTopup(req: Request, res: Response) {
  const body = parse(z.object({ currency: z.enum(["USD", "INR"]), amount: z.number().positive().max(10_000_000) }).strict(), req.body);
  res.status(201).json(await billing.createTopup(actorOf(req), body, reqMeta(req)));
}
export async function verifyRazorpay(req: Request, res: Response) {
  const body = parse(z.object({ orderId: z.string().min(1).max(100), paymentId: z.string().min(1).max(100), signature: z.string().min(1).max(200) }).strict(), req.body);
  res.json(await billing.verifyRazorpay(actorOf(req), body));
}
export async function confirmStub(req: Request, res: Response) {
  res.json(await billing.confirmStubTopup(actorOf(req), parse(idParam, req.params).id));
}
export async function receipt(req: Request, res: Response) {
  const topupId = parse(idParam, req.params).id;
  const pdf = await billing.receiptPdf(actorOf(req), topupId);
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="receipt-${topupId}.pdf"`);
  res.setHeader("Cache-Control", "private, no-store");
  res.end(pdf);
}
export async function redeem(req: Request, res: Response) {
  const body = parse(z.object({ code: z.string().trim().min(3).max(40) }).strict(), req.body);
  res.json(await billing.redeemPromo(actorOf(req), body.code, reqMeta(req)));
}

/** POST /api/webhooks/stripe and /api/webhooks/razorpay. The body arrives raw (express.raw) for the signature check. */
export function webhook(gateway: "STRIPE" | "RAZORPAY") {
  return async (req: Request, res: Response) => {
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const { status } = await billing.handleWebhook(gateway, raw, req.headers);
    res.status(status).json({ received: status === 200 });
  };
}

// ─── Usage ──────────────────────────────────────────────────────────────────

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export async function usageSummary(req: Request, res: Response) {
  const q = parse(z.object({ from: day.optional(), to: day.optional(), apiKeyId: id().optional(), modelId: modelName.optional() }), req.query);
  res.json(await usage.summary(actorOf(req), q));
}
export async function usageRequests(req: Request, res: Response) {
  const q = parse(pageQuery.extend({ apiKeyId: id().optional(), modelId: modelName.optional(), status: z.enum(["ok", "error"]).optional() }), req.query);
  res.json(await usage.requests(actorOf(req), q));
}
export async function usageRequest(req: Request, res: Response) {
  const p = parse(z.object({ id: z.string().regex(/^req_[0-9A-HJKMNP-TV-Z]{26}$/, "must be a request id") }), req.params);
  res.json(await usage.request(actorOf(req), p.id));
}
