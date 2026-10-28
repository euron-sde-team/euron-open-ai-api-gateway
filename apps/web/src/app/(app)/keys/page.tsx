import { Suspense } from "react";
import type { Metadata } from "next";
import { KeysPage } from "@/components/console/keys";

export const metadata: Metadata = { title: "API keys" };

export default function Page() {
  return (
    <Suspense>
      <KeysPage />
    </Suspense>
  );
}
