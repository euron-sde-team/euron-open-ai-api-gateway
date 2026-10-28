/**
 * API keys: API_KEY_PREFIX + 40 base62 characters (about 238 bits). Only an HMAC-SHA256
 * with a server pepper is stored, so a database dump cannot be turned into working keys
 * and lookups stay a single indexed equality. The display hint keeps the prefix, four
 * characters and the last four, enough to recognise a key and never enough to use it.
 */
import crypto from "node:crypto";
import { config } from "../core/config";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const BODY_LENGTH = 40;

export function newApiKey(): string {
  const bytes = crypto.randomBytes(BODY_LENGTH * 2);
  let body = "";
  // Rejection sampling: 248 is the largest multiple of 62 below 256, so every character is uniform.
  for (let i = 0; i < bytes.length && body.length < BODY_LENGTH; i++) if (bytes[i]! < 248) body += ALPHABET[bytes[i]! % 62];
  while (body.length < BODY_LENGTH) body += ALPHABET[crypto.randomInt(62)];
  return `${config.API_KEY_PREFIX}${body}`;
}

export function hashApiKey(key: string): string {
  return crypto.createHmac("sha256", config.API_KEY_PEPPER).update(key).digest("hex");
}

export function looksLikeApiKey(key: string): boolean {
  return key.startsWith(config.API_KEY_PREFIX) && key.length === config.API_KEY_PREFIX.length + BODY_LENGTH && /^[A-Za-z0-9]+$/.test(key.slice(config.API_KEY_PREFIX.length));
}

export function keyHint(key: string): string {
  const body = key.slice(config.API_KEY_PREFIX.length);
  return `${config.API_KEY_PREFIX}${body.slice(0, 4)}...${body.slice(-4)}`;
}
