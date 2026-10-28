import type { Metadata } from "next";
import { Suspense } from "react";
import { AdminTiers } from "@/components/admin/pages/tiers";

export const metadata: Metadata = { title: "Limits" };

export default function Page() {
  return (
    <Suspense>
      <AdminTiers />
    </Suspense>
  );
}
