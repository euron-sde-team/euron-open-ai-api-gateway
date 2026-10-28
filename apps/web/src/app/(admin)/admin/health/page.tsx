import type { Metadata } from "next";
import { Suspense } from "react";
import { AdminHealth } from "@/components/admin/pages/health";

export const metadata: Metadata = { title: "Health" };

export default function Page() {
  return (
    <Suspense>
      <AdminHealth />
    </Suspense>
  );
}
