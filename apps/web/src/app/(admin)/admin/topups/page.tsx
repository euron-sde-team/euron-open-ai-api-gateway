import type { Metadata } from "next";
import { Suspense } from "react";
import { AdminBilling } from "@/components/admin/pages/billing";

export const metadata: Metadata = { title: "Billing" };

export default function Page() {
  return (
    <Suspense>
      <AdminBilling />
    </Suspense>
  );
}
