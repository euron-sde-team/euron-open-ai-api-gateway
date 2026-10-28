"use client";

import { useQuery } from "@tanstack/react-query";
import type { AppMeta } from "@open-gateway/types";
import { api } from "./api";
import { qk } from "./query-keys";
import { productName } from "./runtime-env";

/** The deployment's own name (set by an admin) wins over the image's PRODUCT_NAME. */
export function resolveProductName(meta: Pick<AppMeta, "appName"> | null | undefined, fallback: string): string {
  const name = meta?.appName?.trim();
  return name || fallback;
}

/** Public facts about the deployment (name, features, limits, registration). Readable signed out. */
export function useAppMeta() {
  return useQuery({
    queryKey: qk.meta,
    queryFn: ({ signal }) => api().meta.get(signal),
    staleTime: 5 * 60_000,
    retry: 1,
    meta: { silent: true },
  });
}

/** The product title to show: the name an admin set, else the runtime PRODUCT_NAME. */
export function useProductName(): string {
  const { data } = useAppMeta();
  return resolveProductName(data, productName());
}
