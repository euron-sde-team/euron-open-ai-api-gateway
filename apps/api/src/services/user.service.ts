/** Your own account: name and signed-in sessions. Preferences live in preferences.service.ts. */
import type { Me, SessionInfo } from "@open-gateway/types";
import type { Actor, RequestMeta } from "../core/context";
import { requireActive } from "../core/context";
import { badRequest, notFound } from "../core/errors";
import { db } from "../db/kysely";
import { cleanDisplayName } from "../domain/display-name";
import { toMe } from "../presenters/user.presenter";
import { sessionRepo } from "../repositories/session.repository";
import { userRepo } from "../repositories/user.repository";
import { audit } from "./audit.service";

export async function me(actor: Actor): Promise<Me> {
  const row = await userRepo.findById(actor.id);
  if (!row) throw notFound("User not found");
  return toMe(row);
}

export interface AccountPatch {
  displayName?: string;
}

export async function updateMe(actor: Actor, patch: AccountPatch): Promise<Me> {
  requireActive(actor);
  let displayName: string | undefined;
  if (patch.displayName !== undefined) {
    const cleaned = cleanDisplayName(patch.displayName);
    if (!cleaned) throw badRequest("Use your name, not an email address or phone number", "DISPLAY_NAME_INVALID");
    displayName = cleaned;
  }
  const row = await userRepo.update(actor.id, {
    ...(displayName !== undefined ? { display_name: displayName } : {}),
  });
  if (!row) throw notFound("User not found");
  return toMe(row);
}

/**
 * Active sessions. The access token does not name its session, so `current` marks the
 * most recently used session from this browser (same user agent).
 */
export async function sessions(actor: Actor, meta: RequestMeta): Promise<SessionInfo[]> {
  const rows = await sessionRepo.listActive(actor.id);
  const currentId = rows.find((r) => r.user_agent === (meta.userAgent?.slice(0, 300) ?? null))?.id ?? null;
  return rows.map((r) => ({
    id: r.id,
    userAgent: r.user_agent,
    ip: r.ip,
    createdAt: r.created_at.toISOString(),
    lastUsedAt: r.last_used_at.toISOString(),
    current: r.id === currentId,
  }));
}

export async function revokeSession(actor: Actor, sessionId: string, meta: RequestMeta): Promise<void> {
  const row = await db.selectFrom("sessions").select(["id", "family_id"]).where("id", "=", sessionId).where("user_id", "=", actor.id).where("revoked_at", "is", null).executeTakeFirst();
  if (!row) throw notFound("Session not found");
  await sessionRepo.revokeFamily(row.family_id);
  await audit({ actorId: actor.id, action: "session.revoke", entityType: "session", entityId: row.id, ip: meta.ip });
}
