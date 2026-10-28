import type { Metadata } from "next";
import { Suspense } from "react";
import { AdminUsers } from "@/components/admin/pages/users";

export const metadata: Metadata = { title: "Users" };

export default function Page() {
  return (
    <Suspense>
      <AdminUsers />
    </Suspense>
  );
}
