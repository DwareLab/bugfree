import { Bug } from "lucide-react";

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center px-4 py-10">
      <div className="mb-6 flex items-center gap-2 text-lg font-semibold tracking-tight">
        <span className="flex size-8 items-center justify-center rounded-lg bg-accent text-white">
          <Bug className="size-4.5" aria-hidden />
        </span>
        bugfree
      </div>
      <div className="w-full max-w-sm rounded-xl border border-line bg-surface p-6 shadow-sm">{children}</div>
    </div>
  );
}
