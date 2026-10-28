/** The admin sidebar model. Every admin sees every area (the API has one admin role). Pure (tested). */
import { Activity, Boxes, CreditCard, Gauge, Plug, ScrollText, Settings2, SlidersHorizontal, Users, type LucideIcon } from "lucide-react";

export interface AdminNavItem {
  href: string;
  label: string;
  icon: LucideIcon;
}

export const ADMIN_NAV: AdminNavItem[] = [
  { href: "/admin", label: "Overview", icon: Gauge },
  { href: "/admin/users", label: "Users", icon: Users },
  { href: "/admin/providers", label: "Providers", icon: Plug },
  { href: "/admin/models", label: "Models", icon: Boxes },
  { href: "/admin/health", label: "Health", icon: Activity },
  { href: "/admin/topups", label: "Billing", icon: CreditCard },
  { href: "/admin/tiers", label: "Limits", icon: SlidersHorizontal },
  { href: "/admin/settings", label: "Settings", icon: Settings2 },
  { href: "/admin/audit", label: "Audit log", icon: ScrollText },
];

/** The item a pathname belongs to: the longest matching href ("/admin" only matches itself). */
export function activeNavHref(pathname: string, items: readonly AdminNavItem[] = ADMIN_NAV): string | null {
  let best: string | null = null;
  for (const i of items) {
    const hit = i.href === "/admin" ? pathname === "/admin" || pathname === "/admin/" : pathname === i.href || pathname.startsWith(`${i.href}/`);
    if (hit && (!best || i.href.length > best.length)) best = i.href;
  }
  return best;
}

/** The page heading for the top bar on phones ("Users"). */
export function navLabel(pathname: string, items: readonly AdminNavItem[] = ADMIN_NAV): string {
  const href = activeNavHref(pathname, items);
  return items.find((i) => i.href === href)?.label ?? "Admin";
}
