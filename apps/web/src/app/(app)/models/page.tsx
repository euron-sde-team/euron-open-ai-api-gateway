import { Suspense } from "react";
import type { Metadata } from "next";
import { ModelsPage } from "@/components/console/models";

export const metadata: Metadata = { title: "Models" };

export default function Page() {
  return (
    <Suspense>
      <ModelsPage />
    </Suspense>
  );
}
