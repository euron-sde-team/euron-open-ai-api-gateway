/**
 * Provider credentials at rest. provider_credentials.ciphertext is AES-256-GCM with a key
 * derived (HKDF-SHA256) from CREDENTIALS_KEY, and the credential row id bound in as
 * associated data, so a ciphertext copied onto another row does not decrypt. Format:
 * "v1:" + base64url(iv[12] | tag[16] | ciphertext).
 *
 * The plaintext exists only in memory, on the request path that calls the provider (and
 * in the short-lived catalogue cache of each process). It never reaches a log line, an
 * error, a response or the browser.
 */
import crypto from "node:crypto";
import { config } from "../core/config";

function key(): Buffer {
  return Buffer.from(crypto.hkdfSync("sha256", Buffer.from(config.CREDENTIALS_KEY, "base64"), Buffer.alloc(0), "open-gateway:provider-credential", 32));
}

export function encryptCredential(secret: string, credentialId: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key(), iv);
  cipher.setAAD(Buffer.from(credentialId));
  const body = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return `v1:${Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64url")}`;
}

/** Throws when the ciphertext was tampered with, belongs to another row, or the key changed. */
export function decryptCredential(ciphertext: string, credentialId: string): string {
  if (!ciphertext.startsWith("v1:")) throw new Error("unknown credential format");
  const raw = Buffer.from(ciphertext.slice(3), "base64url");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key(), raw.subarray(0, 12));
  decipher.setAAD(Buffer.from(credentialId));
  decipher.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
}

/** The last four characters, for recognising a credential in /admin. */
export function last4(secret: string): string {
  return secret.trim().slice(-4);
}
