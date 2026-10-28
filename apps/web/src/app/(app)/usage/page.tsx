import { Suspense } from "react";
import type { Metadata } from "next";
import { UsagePage } from "@/components/console/usage";

export const metadata: Metadata = { title: "Usage" };

export default function Page() {
  return (
    <Suspense>
      <UsagePage />
    </Suspense>
  );
}
