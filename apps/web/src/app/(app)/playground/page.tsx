import { Suspense } from "react";
import type { Metadata } from "next";
import { PlaygroundPage } from "@/components/console/playground";

export const metadata: Metadata = { title: "Playground" };

export default function Page() {
  return (
    <Suspense>
      <PlaygroundPage />
    </Suspense>
  );
}
