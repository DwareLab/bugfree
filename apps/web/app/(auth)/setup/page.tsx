import { Suspense } from "react";
import { AuthForm } from "@/components/auth-form";

export const metadata = { title: "Setup" };

export default function Page() {
  return (
    <Suspense>
      <AuthForm mode="setup" />
    </Suspense>
  );
}
