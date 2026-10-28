"use client";

import { useQuery } from "@tanstack/react-query";
import { isApiError } from "@open-gateway/api-client";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { qk } from "@/lib/query-keys";

/** GET /admin/me as a query. The shell loads it once; a 403 means "not an admin". */
export function useAdminSessionQuery() {
  const { status } = useAuth();
  return useQuery({
    queryKey: qk.admin.session,
    queryFn: () => api().admin.session(),
    enabled: status === "signed-in",
    staleTime: 5 * 60_000,
    retry: (n, e) => !(isApiError(e) && e.status > 0 && e.status < 500) && n < 2,
    meta: { silent: true },
  });
}

/** Is a session error the API saying "not an admin"? */
export function isForbidden(e: unknown): boolean {
  return isApiError(e) && e.status === 403;
}
