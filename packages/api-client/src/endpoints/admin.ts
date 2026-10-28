/** The /admin control plane. Admins only. */
import type {
  AdminModel,
  AdminProvider,
  AdminSession,
  AdminStats,
  AdminTopupRow,
  AdminUserDetail,
  AdminUserRow,
  AppSettings,
  AuditEntry,
  HealthRow,
  IntegrationStatus,
  LimitTier,
  ModelKind,
  ModelTestResult,
  Page,
  PromoCode,
  ProviderKind,
  UserRole,
  UserStatus,
} from "@open-gateway/types";
import { enc, type Helpers, type PageQuery } from "./helpers";

export interface ProviderInput {
  id: string;
  kind: ProviderKind;
  displayName: string;
  baseUrl: string | null;
  enabled: boolean;
}

export interface ModelInput {
  id: string;
  kind: ModelKind;
  displayName: string;
  description?: string;
  ownedBy?: string;
  aliases?: string[];
  contextWindow?: number | null;
  maxOutputTokens?: number | null;
  supportsTools?: boolean;
  supportsVision?: boolean;
  supportsJson?: boolean;
  marginBps?: number | null;
  enabled?: boolean;
  sortOrder?: number;
}

export interface RouteInput {
  providerId: string;
  upstreamModel: string;
  priority: number;
  timeoutMs?: number;
  inputMicrosPerMtok: number;
  outputMicrosPerMtok: number;
  cachedMicrosPerMtok?: number | null;
  unitMicros?: number;
  enabled?: boolean;
}

export type TierInput = { name: string; rpm: number | null; tpm: number | null; concurrency: number | null; isDefault?: boolean };
type DeepPartial<T> = { [K in keyof T]?: T[K] extends Record<string, unknown> ? Partial<T[K]> : T[K] };

export function adminEndpoints(h: Helpers) {
  const { get, post, put, patch, del, pq } = h;
  const admin = {
    session: () => get<AdminSession>("/admin/me"),
    stats: (q: { from?: string; to?: string } = {}) => get<AdminStats>("/admin/stats", pq(q)),

    users: (q: PageQuery & { q?: string; status?: UserStatus; role?: UserRole; tierId?: string } = {}) => get<Page<AdminUserRow>>("/admin/users", pq(q)),
    user: (id: string) => get<AdminUserDetail>(`/admin/users/${enc(id)}`),
    setRole: (id: string, role: UserRole) => patch<AdminUserRow>(`/admin/users/${enc(id)}/role`, { role }),
    suspend: (id: string, days: number, reason?: string) => post<AdminUserRow>(`/admin/users/${enc(id)}/suspend`, { days, reason }),
    unsuspend: (id: string) => post<AdminUserRow>(`/admin/users/${enc(id)}/unsuspend`, {}),
    ban: (id: string, reason?: string) => post<AdminUserRow>(`/admin/users/${enc(id)}/ban`, { reason }),
    unban: (id: string) => post<AdminUserRow>(`/admin/users/${enc(id)}/unban`, {}),
    erase: (id: string, reason: string) => post(`/admin/users/${enc(id)}/erase`, { reason }),
    setTier: (id: string, tierId: string | null) => put<AdminUserRow>(`/admin/users/${enc(id)}/tier`, { tierId }),
    setUserMargin: (id: string, marginBps: number | null) => put<AdminUserDetail>(`/admin/users/${enc(id)}/margin`, { marginBps }),
    setKeyMargin: (userId: string, keyId: string, marginBps: number | null) => put<AdminUserDetail>(`/admin/users/${enc(userId)}/keys/${enc(keyId)}/margin`, { marginBps }),
    /** A signed ledger entry (GRANT for credits, ADJUSTMENT for corrections). Audited. */
    credit: (id: string, body: { type: "GRANT" | "ADJUSTMENT"; amountMicros: number; reason: string }) => post<AdminUserDetail>(`/admin/users/${enc(id)}/credit`, body),

    tiers: () => get<LimitTier[]>("/admin/tiers"),
    createTier: (body: TierInput) => post<LimitTier[]>("/admin/tiers", body),
    updateTier: (id: string, body: TierInput) => put<LimitTier[]>(`/admin/tiers/${enc(id)}`, body),
    deleteTier: (id: string) => del<LimitTier[]>(`/admin/tiers/${enc(id)}`),

    providers: () => get<AdminProvider[]>("/admin/providers"),
    createProvider: (body: ProviderInput) => post<AdminProvider[]>("/admin/providers", body),
    updateProvider: (id: string, body: Omit<ProviderInput, "id">) => put<AdminProvider[]>(`/admin/providers/${enc(id)}`, body),
    deleteProvider: (id: string) => del<AdminProvider[]>(`/admin/providers/${enc(id)}`),
    /** The secret is encrypted on arrival and never returned. */
    addCredential: (providerId: string, body: { label: string; secret: string }) => post<AdminProvider[]>(`/admin/providers/${enc(providerId)}/credentials`, body),
    setCredentialEnabled: (providerId: string, credentialId: string, enabled: boolean) => patch<AdminProvider[]>(`/admin/providers/${enc(providerId)}/credentials/${enc(credentialId)}`, { enabled }),
    deleteCredential: (providerId: string, credentialId: string) => del<AdminProvider[]>(`/admin/providers/${enc(providerId)}/credentials/${enc(credentialId)}`),

    models: () => get<AdminModel[]>("/admin/models"),
    createModel: (body: ModelInput) => post<AdminModel[]>("/admin/models", body),
    updateModel: (id: string, body: Omit<ModelInput, "id">) => put<AdminModel[]>(`/admin/models/${enc(id)}`, body),
    deleteModel: (id: string) => del<AdminModel[]>(`/admin/models/${enc(id)}`),
    addRoute: (modelId: string, body: RouteInput) => post<AdminModel[]>(`/admin/models/${enc(modelId)}/routes`, body),
    updateRoute: (modelId: string, routeId: string, body: RouteInput) => put<AdminModel[]>(`/admin/models/${enc(modelId)}/routes/${enc(routeId)}`, body),
    deleteRoute: (modelId: string, routeId: string) => del<AdminModel[]>(`/admin/models/${enc(modelId)}/routes/${enc(routeId)}`),
    /** One small real call through a route (`ModelTestResult`). */
    testRoute: (modelId: string, routeId: string) => post<ModelTestResult>(`/admin/models/${enc(modelId)}/routes/${enc(routeId)}/test`),
    /** Force a route's circuit open (skipped) or closed (used). */
    setCircuit: (routeId: string, state: "open" | "closed") => post(`/admin/health/${enc(routeId)}/circuit`, { state }),
    health: () => get<HealthRow[]>("/admin/health"),

    topups: (q: PageQuery & { status?: string; userId?: string } = {}) => get<Page<AdminTopupRow>>("/admin/topups", pq(q)),
    /** Mark a paid top-up refunded and debit its credit (the gateway refund itself is done in its dashboard). */
    refundTopup: (id: string, reason: string) => post(`/admin/topups/${enc(id)}/refund`, { reason }),

    promos: () => get<PromoCode[]>("/admin/promos"),
    createPromo: (body: { code: string; amountMicros: number; maxRedemptions?: number | null; expiresAt?: string | null }) => post<PromoCode[]>("/admin/promos", body),
    setPromoActive: (id: string, active: boolean) => patch<PromoCode[]>(`/admin/promos/${enc(id)}`, { active }),

    settings: () => get<AppSettings>("/admin/settings"),
    updateSettings: (body: DeepPartial<AppSettings>) => patch<AppSettings>("/admin/settings", body),
    integrations: () => get<IntegrationStatus>("/admin/integrations"),
    audit: (q: PageQuery & { action?: string; actorId?: string; entityType?: string; entityId?: string } = {}) => get<Page<AuditEntry>>("/admin/audit", pq(q)),
  };
  return { admin };
}
