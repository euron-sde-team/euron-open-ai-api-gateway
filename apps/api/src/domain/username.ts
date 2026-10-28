/**
 * Usernames are the account handle (sign in with it, shown in admin). Rules: 3 to 40 characters,
 * letters, digits and hyphens, starting and ending with a letter or digit (the same
 * shape the users.username CHECK enforces). A small reserved list keeps handles from
 * colliding with routes or impersonating the operator.
 */
export const USERNAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9-]{1,38}[a-zA-Z0-9]$/;

const RESERVED = new Set([
  "account", "admin", "administrator", "api", "app", "assistant", "auth", "bot", "c", "chat", "chats", "dashboard",
  "edit", "help", "home", "images", "login", "logout", "me", "moderation", "moderator", "new", "official",
  "privacy", "projects", "root", "search", "security", "settings", "share", "shared", "signin", "signup",
  "staff", "static", "support", "system", "team", "terms", "verify", "www",
]);

export function isReservedUsername(username: string): boolean {
  return RESERVED.has(username.toLowerCase());
}

/**
 * Candidate handles for a display name, best first: "ada-lovelace", "adalovelace",
 * "ada-lovelace-2", ... The caller checks availability.
 */
export function usernameSuggestions(displayName: string, count = 5): string[] {
  const words = displayName
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/[\s-]+/)
    .filter(Boolean)
    .slice(0, 3);
  const base = (words.length ? words.join("-") : "member").slice(0, 34).replace(/^-+|-+$/g, "");
  const padded = base.length >= 3 ? base : `${base}-me`.slice(0, 34);
  const out = new Set<string>([padded, padded.replace(/-/g, "")]);
  for (let i = 2; out.size < count + 1; i++) out.add(`${padded}-${i}`);
  return [...out].filter((u) => USERNAME_PATTERN.test(u) && !isReservedUsername(u)).slice(0, count);
}
