import type { Metadata } from "next";
import { Suspense } from "react";
import { AdminModels } from "@/components/admin/pages/models";

export const metadata: Metadata = { title: "Models" };

export default function Page() {
  return (
    <Suspense>
      <AdminModels />
    </Suspense>
  );
}
