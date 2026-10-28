/** Every React Query key in one place, so cache surgery (optimistic updates, invalidation) finds them. */
type F = Record<string, unknown>;

export const qk = {
  me: ["me"] as const,
  meta: ["meta"] as const,
  sessions: ["sessions"] as const,

  wallet: ["wallet"] as const,
  keys: ["keys"] as const,
  catalog: ["catalog"] as const,
  ledger: (f: F = {}) => ["ledger", f] as const,
  ledgerAll: ["ledger"] as const,
  topups: ["topups"] as const,
  topup: (id: string) => ["topup", id] as const,
  usageSummary: (f: F = {}) => ["usage-summary", f] as const,
  usageAll: ["usage-summary"] as const,
  requests: (f: F = {}) => ["requests", f] as const,
  requestsAll: ["requests"] as const,
  request: (id: string) => ["request", id] as const,

  // Admin
  admin: {
    session: ["admin", "session"] as const,
    all: ["admin"] as const,
    list: (area: string, f?: F) => ["admin", area, "list", f ?? {}] as const,
    detail: (area: string, id: string) => ["admin", area, "detail", id] as const,
    area: (area: string) => ["admin", area] as const,
  },
};
