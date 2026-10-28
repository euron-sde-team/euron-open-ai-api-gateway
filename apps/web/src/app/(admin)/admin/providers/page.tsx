import type { Metadata } from "next";
import { Suspense } from "react";
import { AdminProviders } from "@/components/admin/pages/providers";

export const metadata: Metadata = { title: "Providers" };

export default function Page() {
  return (
    <Suspense>
      <AdminProviders />
    </Suspense>
  );
}
