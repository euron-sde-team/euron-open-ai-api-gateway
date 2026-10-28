"use client";

import Link from "next/link";
import { Button } from "@open-gateway/ui";

/** The plain 403 for a signed-in account that is not an admin. */
export function ForbiddenArea({
  title = "This area is for admins",
  description = "Your account does not have admin access. Ask an admin if you need it.",
  homeHref = "/",
  homeLabel = "Back to the console",
}: {
  title?: string;
  description?: string;
  homeHref?: string;
  homeLabel?: string;
}) {
  return (
    <div className="mx-auto flex min-h-[60dvh] max-w-md flex-col items-center justify-center px-4 text-center" data-testid="admin-forbidden">
      <h1 className="font-display text-[22px] font-semibold tracking-[-0.015em] text-foreground">{title}</h1>
      <p className="mt-2 text-[14.5px] text-muted-foreground">{description}</p>
      <Button asChild variant="outline" size="sm" className="mt-5">
        <Link href={homeHref}>{homeLabel}</Link>
      </Button>
    </div>
  );
}
