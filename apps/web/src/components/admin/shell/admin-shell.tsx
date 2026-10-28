"use client";

import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ArrowLeft, Menu, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { DialogTitle, IconButton, Sheet, SheetContent, Skeleton, Tooltip, cn } from "@open-gateway/ui";
import { productName } from "@/lib/runtime-env";
import { RequireAuth } from "@/components/common/require-auth";
import { ErrorState } from "@/components/common/states";
import { AvatarMenu } from "@/components/shell/avatar-menu";
import { ForbiddenArea } from "./forbidden";
import { ADMIN_NAV, activeNavHref } from "./nav";
import { isForbidden, useAdminSessionQuery } from "./session";

const COLLAPSE_KEY = "os.admin.sidebar";

/**
 * The /admin frame. Signed-out visitors go to /login?next=..., signed-in accounts that
 * are not admins (403 FORBIDDEN_ADMIN on /admin/me) get a plain forbidden page.
 */
export function AdminShell({ children }: { children: ReactNode }) {
  return (
    <RequireAuth>
      <ShellInner>{children}</ShellInner>
    </RequireAuth>
  );
}

function ShellInner({ children }: { children: ReactNode }) {
  const q = useAdminSessionQuery();
  if (q.isPending) return <ShellSkeleton />;
  if (q.isError) {
    if (isForbidden(q.error)) return <ForbiddenArea />;
    return (
      <div className="px-4 py-16">
        <ErrorState error={q.error} onRetry={() => void q.refetch()} />
      </div>
    );
  }
  if (q.data.role !== "ADMIN") return <ForbiddenArea />;
  return <Frame>{children}</Frame>;
}

function Frame({ children }: { children: ReactNode }) {
  const pathname = usePathname() ?? "/admin";
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  useEffect(() => {
    try {
      setCollapsed(window.localStorage.getItem(COLLAPSE_KEY) === "1");
    } catch {
      /* storage blocked: start expanded */
    }
  }, []);
  useEffect(() => setMobileOpen(false), [pathname]);
  const toggle = () =>
    setCollapsed((c) => {
      try {
        window.localStorage.setItem(COLLAPSE_KEY, c ? "0" : "1");
      } catch {
        /* ignore */
      }
      return !c;
    });

  return (
    <div className="flex min-h-dvh bg-background">
      <a href="#admin-main" className="sr-only z-[100] rounded-md bg-card px-3 py-2 font-semibold focus:not-sr-only focus:fixed focus:left-3 focus:top-3">
        Skip to content
      </a>
      <aside
        className={cn("sticky top-0 hidden h-dvh shrink-0 flex-col border-r border-border bg-background md:flex", collapsed ? "w-[64px]" : "w-[224px]")}
        data-testid="admin-sidebar"
      >
        <SidebarHead collapsed={collapsed} />
        <SideNav pathname={pathname} collapsed={collapsed} />
        <div className={cn("flex items-center gap-1 border-t border-border p-2", collapsed ? "flex-col" : "justify-between")}>
          <BackToApp collapsed={collapsed} />
          <IconButton label={collapsed ? "Expand sidebar" : "Collapse sidebar"} variant="ghost" size="sm" onClick={toggle} data-testid="admin-sidebar-toggle">
            {collapsed ? <PanelLeftOpen /> : <PanelLeftClose />}
          </IconButton>
        </div>
      </aside>

      <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
        <SheetContent side="left" width="max-w-[280px]" aria-describedby={undefined}>
          <DialogTitle className="sr-only">Admin areas</DialogTitle>
          <SidebarHead collapsed={false} />
          <SideNav pathname={pathname} collapsed={false} />
          <div className="border-t border-border p-2">
            <BackToApp collapsed={false} />
          </div>
        </SheetContent>
      </Sheet>

      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar onMenu={() => setMobileOpen(true)} />
        <main id="admin-main" className="min-w-0 flex-1" tabIndex={-1}>
          {children}
        </main>
      </div>
    </div>
  );
}

function SidebarHead({ collapsed }: { collapsed: boolean }) {
  return (
    <div className={cn("flex h-header shrink-0 items-center px-5", collapsed && "justify-center px-0")}>
      <Link href="/admin" className="rounded-md font-display text-[17px] font-semibold tracking-[-0.02em] text-foreground focus-visible:ring-2" aria-label="Admin overview">
        {collapsed ? "A" : "Admin"}
      </Link>
    </div>
  );
}

function SideNav({ pathname, collapsed }: { pathname: string; collapsed: boolean }) {
  const active = activeNavHref(pathname);
  return (
    <nav aria-label="Admin areas" className="min-h-0 flex-1 overflow-y-auto px-2 pb-4" data-testid="admin-nav">
      <ul className="space-y-0.5">
        {ADMIN_NAV.map((i) => {
          const current = active === i.href;
          const link = (
            <Link
              href={i.href}
              aria-current={current ? "page" : undefined}
              aria-label={collapsed ? i.label : undefined}
              data-testid={`admin-nav-${i.href.split("/")[2] ?? "overview"}`}
              className={cn(
                "flex h-9 items-center gap-2.5 rounded-[10px] text-[14px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                collapsed ? "justify-center" : "px-3",
                current ? "bg-primary/10 text-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground",
              )}
            >
              <i.icon className={cn("size-[18px] shrink-0", current ? "text-foreground" : "text-subtle-foreground")} aria-hidden />
              {collapsed ? null : <span className="truncate">{i.label}</span>}
            </Link>
          );
          return (
            <li key={i.href}>
              {collapsed ? (
                <Tooltip content={i.label} side="right">
                  {link}
                </Tooltip>
              ) : (
                link
              )}
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

function BackToApp({ collapsed }: { collapsed: boolean }) {
  const link = (
    <Link
      href="/"
      aria-label={collapsed ? "Back to the console" : undefined}
      data-testid="admin-back-to-chat"
      className={cn(
        "flex h-8 items-center gap-2 rounded-[10px] text-[13.5px] font-medium text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        collapsed ? "w-8 justify-center" : "px-3",
      )}
    >
      <ArrowLeft className="size-4 shrink-0" aria-hidden />
      {collapsed ? null : "Back to the console"}
    </Link>
  );
  return collapsed ? (
    <Tooltip content="Back to the console" side="right">
      {link}
    </Tooltip>
  ) : (
    link
  );
}

function TopBar({ onMenu }: { onMenu: () => void }) {
  return (
    <header className="sticky top-0 z-40 flex h-header shrink-0 items-center gap-3 border-b border-border/70 bg-background/85 px-4 backdrop-blur-xl supports-[backdrop-filter]:bg-background/70 sm:px-6">
      <IconButton label="Open menu" variant="ghost" size="md" className="md:hidden" onClick={onMenu} data-testid="admin-menu">
        <Menu />
      </IconButton>
      <p className="min-w-0 truncate text-[14.5px] font-semibold text-foreground" data-testid="admin-product-name">
        {productName()}
        <span className="font-normal text-muted-foreground"> · Admin</span>
      </p>
      <div className="flex flex-1 items-center justify-end">
        <AvatarMenu />
      </div>
    </header>
  );
}

function ShellSkeleton() {
  return (
    <div className="flex min-h-dvh" aria-busy>
      <div className="hidden w-[224px] shrink-0 space-y-3 border-r border-border p-4 md:block">
        <Skeleton className="h-8 w-24" />
        {Array.from({ length: 9 }, (_, i) => (
          <Skeleton key={i} className="h-8" />
        ))}
      </div>
      <div className="flex-1 space-y-4 p-6">
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-64" />
      </div>
    </div>
  );
}
