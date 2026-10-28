/**
 * Keyset cursors for every list: opaque base64url JSON of `[at, id]`, the (created_at, id)
 * of the last row the client has. The time is read as exact text with `atKey(...)`, so a
 * cursor never drifts by a rounding step whatever the column precision. Lists ask for one
 * more row than the page size to know whether a next page exists: no COUNT(*).
 */
import { sql, type Expression, type SqlBool } from "kysely";
import { badRequest } from "../core/errors";
import { ID_PATTERN } from "../core/ids";

export interface TimeKey {
  at: string;
  id: string;
}

const AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}\+00$/;

/** Select a timestamptz column as exact UTC text, aliased `alias` (default "_at"). */
export function atKey<A extends string = "_at">(column: string, alias: A = "_at" as A) {
  return sql<string>`to_char(${sql.ref(column)} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"+00"')`.as(alias);
}

function encode(parts: unknown[]): string {
  return Buffer.from(JSON.stringify(parts), "utf8").toString("base64url");
}

function decodeParts(raw: unknown): unknown[] | null {
  if (raw === undefined || raw === null || raw === "") return null;
  if (typeof raw !== "string" || raw.length > 300) throw badRequest("Invalid cursor", "INVALID_CURSOR");
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (!Array.isArray(parsed)) throw new Error("not an array");
    return parsed;
  } catch {
    throw badRequest("Invalid cursor", "INVALID_CURSOR");
  }
}

function encodeTime(at: string, id: string): string {
  return encode([at, id]);
}

export function decodeTime(raw: unknown): TimeKey | null {
  const p = decodeParts(raw);
  if (!p) return null;
  const [at, id] = p;
  if (p.length !== 2 || typeof at !== "string" || !AT.test(at) || typeof id !== "string" || !ID_PATTERN.test(id)) throw badRequest("Invalid cursor", "INVALID_CURSOR");
  return { at, id };
}

/** Rows strictly after the cursor in (at DESC, id DESC) order. */
export function olderThan(atColumn: string, idColumn: string, key: TimeKey | null): (eb: unknown) => Expression<SqlBool> {
  return () => (key ? sql<boolean>`(${sql.ref(atColumn)}, ${sql.ref(idColumn)}) < (${key.at}::timestamptz, ${key.id})` : sql<boolean>`true`);
}

interface Paged<T> {
  items: T[];
  nextCursor: string | null;
}

/** Trim the look-ahead row and build the cursor from the last kept row. */
function pageBy<T>(rows: T[], limit: number, cursorOf: (last: T) => string): Paged<T> {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items[items.length - 1];
  return { items, nextCursor: hasMore && last !== undefined ? cursorOf(last) : null };
}

export function timePage<T extends { _at: string; id: string }>(rows: T[], limit: number): Paged<T> {
  return pageBy(rows, limit, (r) => encodeTime(r._at, r.id));
}
