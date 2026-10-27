import { Suspense } from "react";
import { PortalShell } from "@/components/portal-shell";
import { Spinner } from "@/components/ui";

export const metadata = { title: "Report a bug" };

export default function PortalLayout({ children }: { children: React.ReactNode }) {
  return (
    <Suspense fallback={<Spinner />}>
      <PortalShell>{children}</PortalShell>
    </Suspense>
  );
}
