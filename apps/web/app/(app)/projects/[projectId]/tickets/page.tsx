"use client";

import { Globe, Plus } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { Suspense } from "react";
import { PageHeader, useShell } from "@/components/app-shell";
import { TicketBoard } from "@/components/ticket-board";
import { Button, Spinner } from "@/components/ui";

export default function TicketsPage() {
  return (
    <Suspense fallback={<Spinner />}>
      <ProjectBoard />
    </Suspense>
  );
}

/** The bug reports routed to this project, from any report page. */
function ProjectBoard() {
  const { projectId } = useParams<{ projectId: string }>();
  const { projects, portals } = useShell();
  const project = projects.find((p) => p.id === Number(projectId));
  const pages = portals.filter((po) => po.projects.some((p) => p.id === Number(projectId)));

  return (
    <>
      <PageHeader
        title={`${project?.name ?? "Project"} · Bug reports`}
        subtitle={
          pages.length ? (
            <>
              Reports routed here from{" "}
              {pages.map((po, i) => (
                <span key={po.id}>
                  {i > 0 && ", "}
                  <Link href={`/portals/${po.id}`} className="text-accent-ink hover:underline">
                    {po.name}
                  </Link>
                </span>
              ))}
            </>
          ) : (
            "No report page includes this project yet."
          )
        }
        actions={
          <Link href={`/portals?new=1&project=${projectId}`}>
            <Button variant={pages.length ? "secondary" : "primary"}>
              {pages.length ? <Plus className="size-4" aria-hidden /> : <Globe className="size-4" aria-hidden />}
              {pages.length ? "New report page" : "Create a report page"}
            </Button>
          </Link>
        }
      />
      <TicketBoard
        scope={{ projectId: Number(projectId) }}
        empty={
          pages.length
            ? "Reports show up here once they're routed to this project: by the reporter, or from the report page's board."
            : "Create a report page that includes this project and share its link with your users."
        }
      />
    </>
  );
}
