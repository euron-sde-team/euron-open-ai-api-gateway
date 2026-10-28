import type { Me, UserSummary } from "@open-gateway/types";

export const user = (id: string, name = `User ${id}`): UserSummary => ({ id, username: `user-${id}`, displayName: name, role: "USER" });

export const me: Me = {
  ...user("me", "Ada Lovelace"),
  email: "ada@example.org",
  status: "ACTIVE",
  suspendedUntil: null,
  emailVerified: true,
  totpEnabled: false,
  deletionRequestedAt: null,
  canOpenAdmin: false,
};
