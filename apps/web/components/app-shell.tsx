"use client";

import { Bug, FolderKanban, LogOut, Menu, MessageSquareWarning, Package, Plus, ScrollText, Settings, Users, X } from "lucide-react";
import Link from "next/link";
import { useParams, usePathname, useRouter } from "next/navigation";
import { createContext, type ReactNode, useContext, useEffect, useState } from "react";
import { type ProjectSummary, type User, api, useApi } from "@/lib/api";
import { cx } from "@/lib/format";
import { Spinner } from "./ui";

interface ShellContext {
  user: User;
  projects: ProjectSummary[];
  reloadProjects: () => Promise<void>;
}

const Ctx = createContext<ShellContext | null>(null);

export function useShell(): ShellContext {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useShell must be used inside <AppShell>");
  return ctx;
}

export function AppShell({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [user, setUser] = useState<User | null>(null);
  const projects = useApi<ProjectSummary[]>(user ? "/api/projects" : null, { refreshMs: 60_000 });

  useEffect(() => {
    api<{ setupRequired: boolean; user: User | null }>("/api/auth/state")
      .then((state) => {
        if (state.setupRequired) router.replace("/setup");
        else if (!state.user) router.replace(`/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`);
        else setUser(state.user);
      })
      .catch(() => router.replace("/login"));
  }, [router]);

  if (!user) return <Spinner label="Checking your session" />;

  return (
    <Ctx.Provider value={{ user, projects: projects.data ?? [], reloadProjects: projects.reload }}>
      <Layout key={pathname.split("/").slice(0, 3).join("/")}>{children}</Layout>
    </Ctx.Provider>
  );
}

function Layout({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="min-h-dvh md:flex">
      <div className="sticky top-0 z-30 flex h-12 items-center justify-between border-b border-line bg-surface px-4 md:hidden">
        <Brand />
        <button onClick={() => setOpen((o) => !o)} aria-label={open ? "Close menu" : "Open menu"} className="rounded p-1.5 text-ink-2 hover:bg-surface-hover">
          {open ? <X className="size-5" /> : <Menu className="size-5" />}
        </button>
      </div>
      <aside
        className={cx(
          "z-20 w-full shrink-0 border-line bg-surface md:sticky md:top-0 md:block md:h-dvh md:w-60 md:border-r",
          open ? "block border-b" : "hidden",
        )}
      >
        <Sidebar onNavigate={() => setOpen(false)} />
      </aside>
      <main className="min-w-0 flex-1">{children}</main>
    </div>
  );
}

function Brand() {
  return (
    <Link href="/projects" className="flex items-center gap-2 font-semibold tracking-tight text-ink">
      <span className="flex size-6 items-center justify-center rounded-md bg-accent text-white">
        <Bug className="size-3.5" aria-hidden />
      </span>
      bugfree
    </Link>
  );
}

function Sidebar({ onNavigate }: { onNavigate: () => void }) {
  const { user, projects } = useShell();
  const params = useParams<{ projectId?: string }>();
  const pathname = usePathname();
  const router = useRouter();
  const activeProject = params.projectId ? Number(params.projectId) : null;

  const item = (href: string, icon: ReactNode, label: ReactNode, active: boolean, extra?: ReactNode) => (
    <Link
      href={href}
      onClick={onNavigate}
      className={cx(
        "flex items-center gap-2 rounded-md px-2.5 py-1.5 text-sm transition-colors",
        active ? "bg-accent-wash font-medium text-accent-ink" : "text-ink-2 hover:bg-surface-hover hover:text-ink",
      )}
    >
      {icon}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {extra}
    </Link>
  );

  return (
    <div className="flex h-full flex-col">
      <div className="hidden h-14 items-center px-4 md:flex">
        <Brand />
      </div>
      <nav className="flex-1 overflow-y-auto px-2 py-2 md:py-0">
        <div className="mb-1 flex items-center justify-between px-2.5 pt-2 pb-1">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-muted">Projects</span>
          <Link href="/projects?new=1" onClick={onNavigate} className="rounded p-0.5 text-muted hover:bg-surface-hover hover:text-ink" aria-label="New project">
            <Plus className="size-3.5" />
          </Link>
        </div>
        {projects.map((p) => (
          <div key={p.id}>
            {item(
              `/projects/${p.id}`,
              <FolderKanban className="size-4 shrink-0" aria-hidden />,
              p.name,
              activeProject === p.id && pathname === `/projects/${p.id}`,
              p.unresolved_issues > 0 ? <span className="tabular text-xs text-muted">{p.unresolved_issues}</span> : null,
            )}
            {activeProject === p.id && (
              <div className="ml-4 border-l border-line pl-2">
                {item(
                  `/projects/${p.id}/tickets`,
                  <MessageSquareWarning className="size-3.5" aria-hidden />,
                  "Bug reports",
                  pathname.endsWith("/tickets"),
                  p.new_tickets > 0 ? (
                    <span className="tabular rounded-full bg-accent px-1.5 text-[11px] font-medium text-white" title={`${p.new_tickets} new`}>
                      {p.new_tickets}
                    </span>
                  ) : null,
                )}
                {item(`/projects/${p.id}/logs`, <ScrollText className="size-3.5" aria-hidden />, "Logs", pathname.endsWith("/logs"))}
                {item(`/projects/${p.id}/releases`, <Package className="size-3.5" aria-hidden />, "Releases", pathname.endsWith("/releases"))}
                {item(`/projects/${p.id}/settings`, <Settings className="size-3.5" aria-hidden />, "Settings & setup", pathname.endsWith("/settings"))}
              </div>
            )}
          </div>
        ))}
        {!projects.length && <p className="px-2.5 py-1 text-xs text-muted">No projects yet.</p>}
      </nav>
      <div className="border-t border-line p-2">
        {item("/account", <Users className="size-4" aria-hidden />, "Team & account", pathname === "/account")}
        <button
          onClick={async () => {
            await api("/api/auth/logout", { method: "POST" });
            router.replace("/login");
          }}
          className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-sm text-ink-2 hover:bg-surface-hover hover:text-ink"
        >
          <LogOut className="size-4" aria-hidden />
          <span className="min-w-0 flex-1 truncate text-left">Sign out</span>
        </button>
        <p className="truncate px-2.5 pt-1 text-xs text-muted" title={user.email}>
          {user.email}
        </p>
      </div>
    </div>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 border-b border-line bg-surface px-4 py-4 md:px-6">
      <div className="min-w-0">
        <h1 className="truncate text-lg font-semibold tracking-tight text-ink">{title}</h1>
        {subtitle && <div className="mt-0.5 text-sm text-ink-2">{subtitle}</div>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}
