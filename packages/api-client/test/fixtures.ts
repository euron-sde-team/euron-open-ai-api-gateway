import type { AuthResult, Me } from "@open-gateway/types";

export const me: Me = {
  id: "01J00000000000000000000001",
  username: "ada",
  displayName: "Ada L",
  role: "USER",
  email: "ada@example.org",
  status: "ACTIVE",
  emailVerified: true,
  totpEnabled: false,
  suspendedUntil: null,
  deletionRequestedAt: null,
  canOpenAdmin: false,
};

export const authResult = (token: string): AuthResult => ({ accessToken: token, expiresIn: 900, user: me });

export function json(status: number, body: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: body === undefined ? {} : { "content-type": "application/json" },
  });
}
