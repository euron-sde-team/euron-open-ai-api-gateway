import type { Metadata } from "next";
import { Suspense } from "react";
import { AdminSettings } from "@/components/admin/pages/settings";

export const metadata: Metadata = { title: "Settings" };

export default function Page() {
  return (
    <Suspense>
      <AdminSettings />
    </Suspense>
  );
}
