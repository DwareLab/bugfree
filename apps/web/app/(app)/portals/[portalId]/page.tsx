"use client";

import { ExternalLink, Settings } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { Suspense } from "react";
import { PageHeader } from "@/components/app-shell";
import { TicketBoard } from "@/components/ticket-board";
import { Button, CopyButton, ErrorBox, Spinner } from "@/components/ui";
import { type PortalSummary, useApi } from "@/lib/api";

export default function PortalBoardPage() {
  return (
    <Suspense fallback={<Spinner />}>
      <PortalBoard />
    </Suspense>
  );
}

/** Everything filed on one report page, across its projects, including reports still waiting to be routed. */
function PortalBoard() {
  const { portalId } = useParams<{ portalId: string }>();
  const portal = useApi<PortalSummary>(`/api/portals/${portalId}`);

  if (portal.error) return <div className="p-6"><ErrorBox error={portal.error} onRetry={portal.reload} /></div>;
  if (!portal.data) return <Spinner />;
  const po = portal.data;

  return (
    <>
      <PageHeader
        title={po.name}
        subtitle={
          po.enabled ? (
            <span className="inline-flex flex-wrap items-center gap-1">
              Shared at
              <a href={po.url} target="_blank" rel="noreferrer" className="text-accent-ink hover:underline">
                {po.url.replace(/^https?:\/\//, "")}
              </a>
              <CopyButton text={po.url} label="Copy link" />
            </span>
          ) : (
            "This page is off: its link shows “not found”. Turn it on in Settings."
          )
        }
        actions={
          <>
            {po.enabled && (
              <a href={po.url} target="_blank" rel="noreferrer">
                <Button>
                  <ExternalLink className="size-4" aria-hidden />
                  Open page
                </Button>
              </a>
            )}
            <Link href={`/portals/${po.id}/settings`}>
              <Button>
                <Settings className="size-4" aria-hidden />
                Settings
              </Button>
            </Link>
          </>
        }
      />
      <TicketBoard
        scope={{ portalId: po.id, projects: po.projects }}
        empty={
          <>
            Share{" "}
            <a href={po.url} target="_blank" rel="noreferrer" className="text-accent-ink hover:underline">
              the page&apos;s link
            </a>{" "}
            with your users, or link to it from your app&apos;s help menu. New reports land in the New column.
          </>
        }
      />
    </>
  );
}
