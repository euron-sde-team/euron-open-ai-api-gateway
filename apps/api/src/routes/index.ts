/**
 * Every console router and where it is mounted. scripts/gen-openapi.ts reads this file,
 * so keep one `[prefix, router]` entry per line. The data plane (/v1) and the payment
 * webhooks are mounted in app.ts, ahead of the JSON body parser.
 */
import type { Express } from "express";
import { router as admin } from "./admin.routes";
import { router as auth } from "./auth.routes";
import { billing, catalog, keys, meta, usage } from "./console.routes";
import { router as users } from "./users.routes";

export const MOUNTS = [
  ["/api/auth", auth],
  ["/api/users", users],
  ["/api/meta", meta],
  ["/api/catalog", catalog],
  ["/api/keys", keys],
  ["/api/billing", billing],
  ["/api/usage", usage],
  ["/api/admin", admin],
] as const;

export function mountRoutes(app: Express): void {
  for (const [prefix, router] of MOUNTS) app.use(prefix, router);
}
