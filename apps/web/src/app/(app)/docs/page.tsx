import { Suspense } from "react";
import type { Metadata } from "next";
import { DocsPage } from "@/components/console/docs";

export const metadata: Metadata = { title: "Docs" };

export default function Page() {
  return (
    <Suspense>
      <DocsPage />
    </Suspense>
  );
}
