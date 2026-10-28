import type { Metadata } from "next";
import { Suspense } from "react";
import { AdminOverview } from "@/components/admin/pages/overview";

export const metadata: Metadata = { title: "Overview" };

export default function Page() {
  return (
    <Suspense>
      <AdminOverview />
    </Suspense>
  );
}
