"use client";

import type { ReactNode } from "react";
import { Avatar, cn, toast, type AvatarSize } from "@open-gateway/ui";
import type { UserSummary } from "@open-gateway/types";
import { adminErrorMessage } from "@/lib/admin";
import { qk } from "@/lib/query-keys";

/** Query keys for the admin pages, built on the shared `qk.admin` factory. */
export const ak = {
  stats: (range: { from: string; to: string }) => qk.admin.list("stats", range),
  usersPrefix: [...qk.admin.area("users"), "list"] as const,
  users: (f: Record<string, unknown>) => qk.admin.list("users", f),
  user: (id: string) => qk.admin.detail("users", id),
  tiers: qk.admin.list("tiers"),
  providers: qk.admin.list("providers"),
  models: qk.admin.list("models"),
  settings: qk.admin.list("settings"),
  integrations: qk.admin.list("integrations"),
  health: qk.admin.list("health"),
  topupsPrefix: [...qk.admin.area("topups"), "list"] as const,
  topups: (f: Record<string, unknown>) => qk.admin.list("topups", f),
  promos: qk.admin.list("promos"),
  audit: (f: Record<string, unknown>) => qk.admin.list("audit", f),
};

/**
 * Mutation options for admin actions: the global toast is silenced (it would show generic
 * copy) and the admin message is toasted instead. Pass `inline` when a dialog shows the
 * error in place.
 */
export function adminMutation(opts: { inline?: boolean } = {}) {
  return {
    meta: { silent: true },
    onError: opts.inline ? undefined : (e: unknown) => toast.error({ title: adminErrorMessage(e) }),
  } as const;
}

/** A row of a settings-like list: label and help on the left, a control on the right, a hairline below. */
export function LineItem({ title, description, control, className, testId }: { title: ReactNode; description?: ReactNode; control?: ReactNode; className?: string; testId?: string }) {
  return (
    <div className={cn("flex flex-col gap-2 border-b border-border py-3.5 last:border-b-0 sm:flex-row sm:items-center sm:justify-between sm:gap-6", className)} data-testid={testId}>
      <div className="min-w-0">
        <p className="text-[14px] font-medium text-foreground">{title}</p>
        {description ? <p className="mt-0.5 text-[13px] text-muted-foreground">{description}</p> : null}
      </div>
      {control ? <div className="flex shrink-0 items-center gap-2">{control}</div> : null}
    </div>
  );
}

/** A person's initials avatar in admin lists. Accounts here carry no picture, so it is name and colour only. */
export function PersonAvatar({ user, size = "md", className }: { user: Pick<UserSummary, "id" | "displayName">; size?: AvatarSize; className?: string }) {
  return <Avatar name={user.displayName} seed={user.id} size={size} className={className} />;
}
