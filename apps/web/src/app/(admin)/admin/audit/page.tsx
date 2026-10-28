import type { Metadata } from "next";
import { Suspense } from "react";
import { AdminAudit } from "@/components/admin/pages/audit";

export const metadata: Metadata = { title: "Audit log" };

export default function Page() {
  return (
    <Suspense>
      <AdminAudit />
    </Suspense>
  );
}
