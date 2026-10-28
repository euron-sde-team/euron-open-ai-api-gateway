import { Suspense } from "react";
import type { Metadata } from "next";
import { BillingPage } from "@/components/console/billing";

export const metadata: Metadata = { title: "Billing" };

export default function Page() {
  return (
    <Suspense>
      <BillingPage />
    </Suspense>
  );
}
