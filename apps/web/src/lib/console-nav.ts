/** The console sidebar model. Pure (tested in test/console). */
import { BookOpen, Boxes, CreditCard, Gauge, KeyRound, ListTree, Sparkles, type LucideIcon } from "lucide-react";

export const CONSOLE_NAV: { href: string; label: string; icon: LucideIcon }[] = [
  { href: "/", label: "Overview", icon: Gauge },
  { href: "/keys", label: "API keys", icon: KeyRound },
  { href: "/usage", label: "Usage", icon: ListTree },
  { href: "/models", label: "Models", icon: Boxes },
  { href: "/playground", label: "Playground", icon: Sparkles },
  { href: "/billing", label: "Billing", icon: CreditCard },
  { href: "/docs", label: "Docs", icon: BookOpen },
];

/** The nav item a pathname belongs to ("/" only matches itself). */
export function activeConsoleHref(pathname: string): string | null {
  let best: string | null = null;
  for (const i of CONSOLE_NAV) {
    const hit = i.href === "/" ? pathname === "/" : pathname === i.href || pathname.startsWith(`${i.href}/`);
    if (hit && (!best || i.href.length > best.length)) best = i.href;
  }
  return best;
}
