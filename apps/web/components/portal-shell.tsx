"use client";

import { Bug, LogOut } from "lucide-react";
import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { createContext, type ReactNode, useContext, useState } from "react";
import { API_URL, type PortalState, api, useApi } from "@/lib/api";
import { Avatar } from "./tickets";
import { Button, EmptyState, ErrorBox, Spinner } from "./ui";

/**
 * A public report page (/report/:slug), covering one or more projects. Reporters sign in with GitHub; this is
 * separate from the dashboard's team sign-in and never shows anything but their own reports.
 */
const Ctx = createContext<(PortalState & { slug: string }) | null>(null);

export function usePortal() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("usePortal must be used inside <PortalShell>");
  return ctx;
}

export function PortalShell({ children }: { children: ReactNode }) {
  const { slug } = useParams<{ slug: string }>();
  const state = useApi<PortalState>(`/api/portal/${encodeURIComponent(slug)}`);

  if (state.error) {
    return (
      <Frame>
        <EmptyState icon={<Bug className="size-8" />} title="Page not found">
          {state.error.message}
        </EmptyState>
      </Frame>
    );
  }
  if (!state.data) return <Spinner />;
  const { portal, reporter } = state.data;

  return (
    <Ctx.Provider value={{ ...state.data, slug }}>
      <Frame
        title={
          <Link href={`/report/${slug}`} className="hover:underline">
            {portal.name}
          </Link>
        }
        account={
          reporter && (
            <div className="flex items-center gap-2 text-sm">
              <Avatar src={reporter.avatar_url} name={reporter.login} size={24} />
              <span className="hidden font-medium text-ink sm:inline">{reporter.login}</span>
              <Button
                variant="ghost"
                size="sm"
                onClick={async () => {
                  await api("/api/portal/auth/logout", { method: "POST" });
                  await state.reload();
                }}
              >
                <LogOut className="size-3.5" aria-hidden />
                Sign out
              </Button>
            </div>
          )
        }
      >
        {reporter ? children : <SignIn state={state.data} slug={slug} onSignedIn={state.reload} />}
      </Frame>
    </Ctx.Provider>
  );
}

function Frame({ title, account, children }: { title?: ReactNode; account?: ReactNode; children: ReactNode }) {
  return (
    <div className="min-h-dvh">
      <header className="border-b border-line bg-surface">
        <div className="mx-auto flex h-14 max-w-5xl items-center justify-between gap-3 px-4">
          <div className="flex min-w-0 items-center gap-2.5">
            <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-accent text-white">
              <Bug className="size-4" aria-hidden />
            </span>
            <div className="min-w-0 leading-tight">
              {title && <div className="truncate text-sm font-semibold text-ink">{title}</div>}
              <div className="text-xs text-muted">Bug reports</div>
            </div>
          </div>
          {account}
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-4 py-6 md:py-8">{children}</main>
      <footer className="pb-8 text-center text-xs text-muted">
        Powered by{" "}
        <a href="https://github.com/DwareLab/bugfree" target="_blank" rel="noreferrer" className="hover:underline">
          bugfree
        </a>
      </footer>
    </div>
  );
}

function SignIn({ state, slug, onSignedIn }: { state: PortalState; slug: string; onSignedIn: () => Promise<void> }) {
  const search = useSearchParams();
  const signin = search.get("signin");
  const [error, setError] = useState<Error | null>(null);
  const [busy, setBusy] = useState(false);
  // The report form's `?url=` prefill survives the trip through GitHub.
  const github = `${API_URL}/api/portal/auth/github?${new URLSearchParams({ slug, ...(search.get("url") ? { url: search.get("url")! } : {}) })}`;

  return (
    <div className="mx-auto max-w-md rounded-xl border border-line bg-surface p-6 shadow-sm">
      <h1 className="text-lg font-semibold tracking-tight text-ink">Report a bug in {state.portal.name}</h1>
      <p className="mt-1.5 text-sm text-ink-2">
        Sign in so the team can follow up with you. Only your public GitHub username and avatar are shared, and you&apos;ll only see the reports you file.
      </p>
      <div className="mt-5 space-y-3">
        {signin === "failed" && <ErrorBox error={new Error("GitHub sign-in didn't work. Please try again.")} />}
        {signin === "cancelled" && <p className="text-sm text-ink-2">Sign-in was cancelled.</p>}
        {error && <ErrorBox error={error} />}
        {state.signIn.github && (
          <a
            href={github}
            className="flex h-10 w-full items-center justify-center gap-2 rounded-md bg-[#1f2328] text-sm font-medium text-white hover:brightness-125"
          >
            <GitHubMark />
            Continue with GitHub
          </a>
        )}
        {state.signIn.dev && (
          <Button
            className="w-full"
            loading={busy}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                await api("/api/portal/auth/dev", { method: "POST", json: {} });
                await onSignedIn();
              } catch (err) {
                setError(err as Error);
                setBusy(false);
              }
            }}
          >
            Continue as a test reporter (development only)
          </Button>
        )}
        {!state.signIn.github && !state.signIn.dev && (
          <p className="text-sm text-ink-2">Sign-in isn&apos;t set up for this page yet. Please contact the {state.portal.name} team directly.</p>
        )}
      </div>
    </div>
  );
}

function GitHubMark() {
  return (
    <svg viewBox="0 0 16 16" width="18" height="18" fill="currentColor" aria-hidden>
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}
