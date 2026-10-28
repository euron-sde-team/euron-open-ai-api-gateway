"use client";

import { useEffect, useRef } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Check, LogOut, Monitor, Moon, PanelLeftClose, Settings, Shield, Sun } from "lucide-react";
import { Avatar, cn, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger, Tooltip } from "@open-gateway/ui";
import { LogoMark } from "@/components/common/wordmark";
import { useAuth } from "@/lib/auth";
import { useWallet } from "@/lib/console";
import { activeConsoleHref, CONSOLE_NAV } from "@/lib/console-nav";
import { useProductName } from "@/lib/meta";
import { usd } from "@/lib/money";
import { useTheme } from "@/lib/stores/theme";

/** The available balance as one quiet line above the account menu. */
function BalanceLine() {
  const { data } = useWallet();
  if (!data) return <div className="mx-4 mb-2 h-4 w-28 animate-pulse rounded bg-muted" aria-hidden />;
  const low = data.availableMicros <= 0;
  return (
    <Link href="/billing" className="mx-2 mb-1 flex items-baseline justify-between rounded-lg px-2 py-1.5 text-[13px] hover:bg-muted" data-testid="sidebar-balance">
      <span className="text-subtle-foreground">Balance</span>
      <span className={cn("tabular-nums font-medium", low && "text-danger")}>{usd(data.availableMicros)}</span>
    </Link>
  );
}

export function Sidebar({ onCollapse, onNavigate }: { onCollapse?: () => void; onNavigate?: () => void }) {
  const pathname = usePathname();
  const router = useRouter();
  const name = useProductName();
  const { user, isAdmin, logout } = useAuth();
  const { pref, setPref } = useTheme();
  const active = activeConsoleHref(pathname);

  // Close the phone sheet after navigating, but not when it first opens (mount).
  const lastPath = useRef(pathname);
  useEffect(() => {
    if (lastPath.current === pathname) return;
    lastPath.current = pathname;
    onNavigate?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  return (
    <nav aria-label="Console" className="flex h-full flex-col bg-ground-2/60">
      <div className="flex items-center justify-between px-3 pb-2 pt-3">
        <Link href="/" className="flex min-w-0 items-center gap-2 rounded-md" aria-label={`${name} home`}>
          <LogoMark className="size-7" />
          <span className="truncate font-display text-[14px] font-semibold tracking-[-0.01em]">{name}</span>
        </Link>
        {onCollapse ? (
          <Tooltip content="Close sidebar">
            <button type="button" onClick={onCollapse} aria-label="Close sidebar" className="inline-flex size-8 items-center justify-center rounded-lg text-subtle-foreground hover:bg-muted hover:text-foreground">
              <PanelLeftClose className="size-[18px]" />
            </button>
          </Tooltip>
        ) : null}
      </div>
      <div className="mt-2 min-h-0 flex-1 overflow-y-auto px-2 pb-4 scrollbar-thin">
        {CONSOLE_NAV.map(({ href, label, icon: Icon }) => (
          <Link
            key={href}
            href={href}
            aria-current={active === href ? "page" : undefined}
            data-testid={`nav-${label.toLowerCase().replace(/\s+/g, "-")}`}
            className={cn("flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-[14px]", active === href ? "bg-muted font-medium text-foreground" : "text-muted-foreground hover:bg-muted/70 hover:text-foreground")}
          >
            <Icon className="size-[18px]" /> {label}
          </Link>
        ))}
      </div>

      <div className="border-t border-border pt-2">
        <BalanceLine />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button type="button" data-testid="account-menu" className="mx-2 mb-2 flex w-[calc(100%-1rem)] items-center gap-2.5 rounded-lg px-2 py-2 text-left hover:bg-muted">
              <span className="sr-only">Account menu: </span>
              <Avatar name={user?.displayName ?? "?"} size="sm" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[14px] font-medium">{user?.displayName}</span>
                <span className="block truncate text-[12px] text-subtle-foreground">{user?.email}</span>
              </span>
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" side="top" className="w-60">
            <DropdownMenuItem onSelect={() => router.push("/settings")}>
              <Settings className="size-4" /> Settings
            </DropdownMenuItem>
            {isAdmin ? (
              <DropdownMenuItem onSelect={() => router.push("/admin")}>
                <Shield className="size-4" /> Admin
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-[12px] font-semibold uppercase tracking-[0.06em] text-subtle-foreground">Theme</DropdownMenuLabel>
            {(
              [
                ["system", "System", Monitor],
                ["light", "Light", Sun],
                ["dark", "Dark", Moon],
              ] as const
            ).map(([v, label, Icon]) => (
              <DropdownMenuItem key={v} onSelect={(e) => (e.preventDefault(), setPref(v))}>
                <Icon className="size-4" /> {label}
                {pref === v ? <Check className="ml-auto size-4 text-primary" /> : null}
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem data-testid="sign-out" onSelect={() => void logout()}>
              <LogOut className="size-4" /> Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </nav>
  );
}
