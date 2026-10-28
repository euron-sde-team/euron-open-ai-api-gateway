"use client";

/**
 * The app frame: the sidebar (collapsible on desktop, a sheet on phones) and the main
 * area. Signed-out visitors are sent to sign in. The collapsed choice is a device
 * preference kept in localStorage.
 */
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { Menu } from "lucide-react";
import { cn, Sheet, SheetContent } from "@open-gateway/ui";
import { RequireAuth } from "@/components/common/require-auth";
import { Sidebar } from "./sidebar";

const KEY = "console.sidebar.collapsed";

interface ShellState {
  collapsed: boolean;
  mobile: boolean;
  open: () => void;
}

const ShellContext = createContext<ShellState>({ collapsed: false, mobile: false, open: () => undefined });
export const useShell = () => useContext(ShellContext);

function useIsMobile(): boolean {
  const [mobile, setMobile] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 767px)");
    const on = () => setMobile(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return mobile;
}

export function AppShell({ children }: { children: ReactNode }) {
  const mobile = useIsMobile();
  const [collapsed, setCollapsed] = useState(false);
  const [sheet, setSheet] = useState(false);
  useEffect(() => {
    try {
      setCollapsed(window.localStorage.getItem(KEY) === "1");
    } catch {
      /* storage blocked */
    }
  }, []);
  const setCollapsedSaved = (v: boolean) => {
    setCollapsed(v);
    try {
      window.localStorage.setItem(KEY, v ? "1" : "0");
    } catch {
      /* storage blocked */
    }
  };

  return (
    <RequireAuth>
      <ShellContext.Provider value={{ collapsed, mobile, open: () => (mobile ? setSheet(true) : setCollapsedSaved(false)) }}>
        <div className="flex h-dvh overflow-hidden">
          {!mobile ? (
            <aside className={cn("shrink-0 border-r border-border transition-[width] duration-200", collapsed ? "w-0 overflow-hidden border-r-0" : "w-[272px]")}>
              <div className="h-full w-[272px]">
                <Sidebar onCollapse={() => setCollapsedSaved(true)} />
              </div>
            </aside>
          ) : (
            <Sheet open={sheet} onOpenChange={setSheet}>
              <SheetContent side="left" width="max-w-[300px]" className="w-[86vw] p-0" aria-label="Console">
                <Sidebar onNavigate={() => setSheet(false)} />
              </SheetContent>
            </Sheet>
          )}
          <main id="main" className="min-w-0 flex-1 overflow-y-auto">
            {children}
          </main>
        </div>
      </ShellContext.Provider>
    </RequireAuth>
  );
}

/** A page's top bar: the menu button (when the sidebar is hidden), the title, and actions on the right. */
export function PageBar({ title, actions }: { title?: ReactNode; actions?: ReactNode }) {
  const { collapsed, mobile, open } = useShell();
  return (
    <div className="sticky top-0 z-10 flex h-14 items-center gap-2 border-b border-transparent bg-background/90 px-4 backdrop-blur sm:px-6">
      {collapsed || mobile ? (
        <button type="button" onClick={open} aria-label="Open sidebar" className="-ml-1 inline-flex size-9 items-center justify-center rounded-lg text-subtle-foreground hover:bg-muted hover:text-foreground">
          <Menu className="size-[18px]" />
        </button>
      ) : null}
      <div className="min-w-0 flex-1 truncate text-[14px] font-medium text-muted-foreground">{title}</div>
      {actions}
    </div>
  );
}
