"use client";

import { ChevronDown, ChevronRight } from "lucide-react";
import { useState } from "react";
import type { ExceptionValue, Frame } from "@/lib/api";
import { cx } from "@/lib/format";
import { Segmented } from "./ui";

type View = "app" | "full" | "raw";

/** Exception chain: the error that was thrown, then each `cause`. */
export function Exceptions({ values }: { values: ExceptionValue[] }) {
  const hasInApp = values.some((v) => v.stacktrace?.frames.some((f) => f.in_app));
  const hasMapped = values.some((v) => v.stacktrace?.frames.some((f) => f.mapped));
  const [view, setView] = useState<View>(hasInApp ? "app" : "full");

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs text-muted">Most recent call first{hasMapped ? " · un-minified with source maps" : ""}</span>
        <Segmented<View>
          value={view}
          onChange={setView}
          options={[
            ...(hasInApp ? [{ value: "app" as View, label: "App frames" }] : []),
            { value: "full", label: "Full trace" },
            ...(hasMapped ? [{ value: "raw" as View, label: "Minified" }] : []),
          ]}
        />
      </div>
      {values.map((exc, i) => (
        <div key={i}>
          {i > 0 && <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted">Caused by</div>}
          <div className="mb-2">
            <div className="flex flex-wrap items-baseline gap-2">
              <span className="font-semibold text-ink">{exc.type}</span>
              {exc.mechanism && (
                <span className="rounded bg-surface-2 px-1.5 py-0.5 text-[11px] text-ink-2">
                  {exc.mechanism.type} · {exc.mechanism.handled ? "handled" : "unhandled"}
                </span>
              )}
            </div>
            <p className="mt-0.5 whitespace-pre-wrap break-words text-sm text-ink-2">{exc.value}</p>
          </div>
          {exc.stacktrace?.frames.length ? <Frames frames={exc.stacktrace.frames} view={view} /> : <p className="text-sm text-muted">No stack trace.</p>}
        </div>
      ))}
    </div>
  );
}

function Frames({ frames, view }: { frames: Frame[]; view: View }) {
  const visible = view === "app" ? frames.map((f, i) => [f, i] as const).filter(([f]) => f.in_app) : frames.map((f, i) => [f, i] as const);
  const firstApp = frames.findIndex((f) => f.in_app);
  const hidden = frames.length - visible.length;
  return (
    <div className="overflow-hidden rounded-md border border-line">
      {visible.map(([frame, i]) => (
        <FrameRow key={i} frame={frame} raw={view === "raw"} defaultOpen={i === (firstApp >= 0 ? firstApp : 0)} />
      ))}
      {hidden > 0 && <div className="bg-surface-2 px-3 py-1.5 text-xs text-muted">{hidden} framework / library frame{hidden === 1 ? "" : "s"} hidden</div>}
    </div>
  );
}

function FrameRow({ frame, raw, defaultOpen }: { frame: Frame; raw: boolean; defaultOpen: boolean }) {
  const hasContext = !raw && frame.context_line !== undefined;
  const [open, setOpen] = useState(defaultOpen && hasContext);
  const filename = raw && frame.mapped ? frame.raw_filename : frame.filename;
  const fn = raw && frame.mapped ? frame.raw_function : frame.function;
  const line = raw && frame.mapped ? frame.raw_lineno : frame.lineno;
  const col = raw && frame.mapped ? frame.raw_colno : frame.colno;

  return (
    <div className={cx("border-b border-line last:border-0", !frame.in_app && "opacity-75")}>
      <button
        type="button"
        onClick={() => hasContext && setOpen((o) => !o)}
        className={cx("flex w-full items-start gap-2 px-3 py-2 text-left font-mono text-[12.5px]", hasContext ? "hover:bg-surface-hover" : "cursor-default", frame.in_app ? "bg-surface" : "bg-surface-2")}
        aria-expanded={hasContext ? open : undefined}
      >
        <span className="mt-0.5 w-3.5 shrink-0 text-muted">{hasContext && (open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />)}</span>
        <span className="min-w-0 flex-1 break-all">
          <span className={frame.in_app ? "text-ink" : "text-ink-2"}>{filename ?? "<unknown>"}</span>
          {fn && (
            <>
              <span className="text-muted"> in </span>
              <span className="font-semibold text-ink">{fn}</span>
            </>
          )}
          {line !== undefined && (
            <span className="text-muted">
              {" "}
              at line {line}
              {col !== undefined ? `:${col}` : ""}
            </span>
          )}
        </span>
        {frame.in_app && <span className="shrink-0 rounded bg-accent-wash px-1.5 py-0.5 font-sans text-[10px] font-medium text-accent-ink">in app</span>}
      </button>
      {open && hasContext && <Context frame={frame} />}
    </div>
  );
}

function Context({ frame }: { frame: Frame }) {
  const start = (frame.lineno ?? 1) - (frame.pre_context?.length ?? 0);
  const lines = [...(frame.pre_context ?? []), frame.context_line ?? "", ...(frame.post_context ?? [])];
  const current = frame.pre_context?.length ?? 0;
  return (
    <div className="overflow-x-auto border-t border-line bg-code py-1.5 font-mono text-[12.5px] leading-6">
      {lines.map((l, i) => (
        <div key={i} className={cx("flex min-w-max", i === current && "bg-critical-wash")}>
          <span className="tabular w-14 shrink-0 select-none pr-3 text-right text-muted">{start + i}</span>
          <span className={cx("whitespace-pre pr-4", i === current ? "text-ink" : "text-ink-2")}>{l || " "}</span>
        </div>
      ))}
    </div>
  );
}
