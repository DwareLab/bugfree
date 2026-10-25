"use client";

import { useEffect, useRef, useState } from "react";
import type { Point } from "@/lib/api";

/** Clean y-axis ticks (0 / 5 / 10 …) covering `max` with about `count` steps. */
function niceTicks(max: number, count = 3): number[] {
  if (max <= 0) return [0, 1];
  const raw = max / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  // Counts are integers: never step by less than 1.
  const step = Math.max(1, [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag);
  const ticks: number[] = [];
  for (let v = 0; v <= max + step * 0.001 || ticks.length < 2; v += step) ticks.push(Math.round(v * 1000) / 1000);
  if (ticks[ticks.length - 1] < max) ticks.push(ticks[ticks.length - 1] + step);
  return ticks;
}

/** Column with a 4px rounded data-end and a square baseline. */
function barPath(x: number, y: number, w: number, h: number, r = 4): string {
  const rr = Math.min(r, w / 2, h);
  return `M${x},${y + h}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h}Z`;
}

function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}

const fmt = new Intl.NumberFormat("en");

/**
 * Volume over time. One hue, no legend (the card title names it), hover tooltip per bucket, and an equivalent
 * table for screen readers. With `errorsLabel`, each bar's `errors` share is stacked at its base in the critical color.
 */
export function EventsChart({
  points,
  bucket,
  height = 140,
  label = "Events",
  errorsLabel,
}: {
  points: Array<Point & { errors?: number }>;
  bucket: "minute" | "hour" | "day";
  height?: number;
  label?: string;
  errorsLabel?: string;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(0, ...points.map((p) => p.count));
  const ticks = niceTicks(max);
  const top = ticks[ticks.length - 1] || 1;

  const padL = 36;
  const padB = 22;
  const padT = 8;
  const plotW = Math.max(0, width - padL);
  const plotH = height - padB - padT;
  const band = points.length ? plotW / points.length : 0;
  const barW = Math.max(1, Math.min(24, band - 2));

  const fmtTime = (iso: string) =>
    bucket === "minute"
      ? new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
      : bucket === "hour"
        ? new Date(iso).toLocaleTimeString(undefined, { hour: "numeric" })
        : new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const fmtFull = (iso: string) =>
    bucket === "day"
      ? new Date(iso).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })
      : new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  const labelEvery = Math.max(1, Math.ceil(points.length / Math.max(1, Math.floor(plotW / 64))));

  return (
    <div ref={ref} className="relative w-full select-none" style={{ height }}>
      {width > 0 && (
        <svg width={width} height={height} role="img" aria-label={`${label} per ${bucket}, max ${fmt.format(max)}`}>
          {ticks.map((t) => {
            const y = padT + plotH - (t / top) * plotH;
            return (
              <g key={t}>
                <line x1={padL} x2={width} y1={y} y2={y} stroke="var(--grid)" strokeWidth={1} shapeRendering="crispEdges" />
                <text x={padL - 8} y={y} dy="0.32em" textAnchor="end" fontSize={11} fill="var(--muted)" className="tabular">
                  {fmt.format(t)}
                </text>
              </g>
            );
          })}
          {points.map((p, i) => {
            const h = (p.count / top) * plotH;
            const eh = errorsLabel && p.errors ? (p.errors / top) * plotH : 0;
            const x = padL + i * band + (band - barW) / 2;
            const opacity = hover === null || hover === i ? 1 : 0.55;
            return (
              <g key={p.t}>
                {p.count > 0 && <path d={barPath(x, padT + plotH - h, barW, h)} fill="var(--series)" opacity={opacity} />}
                {/* Errors sit at the base of the bar; a 1px surface gap separates the two segments. */}
                {eh > 0 && (
                  <g opacity={opacity}>
                    {eh < h ? (
                      <rect x={x} y={padT + plotH - eh} width={barW} height={eh} fill="var(--critical)" />
                    ) : (
                      <path d={barPath(x, padT + plotH - eh, barW, eh)} fill="var(--critical)" />
                    )}
                    {eh < h && <line x1={x} x2={x + barW} y1={padT + plotH - eh} y2={padT + plotH - eh} stroke="var(--surface)" strokeWidth={1} />}
                  </g>
                )}
                {i % labelEvery === 0 && (
                  <text x={padL + i * band + band / 2} y={height - 6} textAnchor="middle" fontSize={11} fill="var(--muted)">
                    {fmtTime(p.t)}
                  </text>
                )}
                {/* Hit target spans the whole band and plot height, much bigger than the mark. */}
                <rect
                  x={padL + i * band}
                  y={padT}
                  width={band}
                  height={plotH}
                  fill="transparent"
                  onMouseEnter={() => setHover(i)}
                  onMouseLeave={() => setHover(null)}
                />
              </g>
            );
          })}
          <line x1={padL} x2={width} y1={padT + plotH} y2={padT + plotH} stroke="var(--axis)" strokeWidth={1} shapeRendering="crispEdges" />
        </svg>
      )}
      {hover !== null && points[hover] && (
        <div
          className="pointer-events-none absolute z-10 -translate-x-1/2 rounded-md border border-line bg-surface px-2.5 py-1.5 text-xs shadow-lg"
          style={{ left: Math.min(Math.max(padL + hover * band + band / 2, 60), width - 60), top: 0 }}
        >
          <div className="text-muted">{fmtFull(points[hover].t)}</div>
          <div className="mt-0.5 flex items-center gap-1.5 font-medium text-ink">
            <span className="inline-block size-2 rounded-sm" style={{ background: "var(--series)" }} aria-hidden />
            <span className="tabular">{fmt.format(points[hover].count)}</span> {label.toLowerCase()}
          </div>
          {errorsLabel && (
            <div className="mt-0.5 flex items-center gap-1.5 font-medium text-ink">
              <span className="inline-block size-2 rounded-sm" style={{ background: "var(--critical)" }} aria-hidden />
              <span className="tabular">{fmt.format(points[hover].errors ?? 0)}</span> {errorsLabel}
            </div>
          )}
        </div>
      )}
      <table className="sr-only">
        <caption>{label}</caption>
        <tbody>
          {points.map((p) => (
            <tr key={p.t}>
              <th scope="row">{fmtFull(p.t)}</th>
              <td>{p.count}</td>
              {errorsLabel && <td>{p.errors ?? 0}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Tiny 24h activity column chart for issue rows. */
export function Sparkline({ values, width = 96, height = 24 }: { values: number[]; width?: number; height?: number }) {
  const max = Math.max(1, ...values);
  const band = width / values.length;
  const barW = Math.max(1, band - 1);
  const total = values.reduce((a, b) => a + b, 0);
  return (
    <svg width={width} height={height} role="img" aria-label={`${total} events in the last 24 hours`}>
      <line x1={0} x2={width} y1={height - 0.5} y2={height - 0.5} stroke="var(--grid)" strokeWidth={1} />
      {values.map((v, i) => {
        if (!v) return null;
        const h = Math.max(2, (v / max) * (height - 1));
        return (
          <rect key={i} x={i * band} y={height - h} width={barW} height={h} rx={1} fill={i === values.length - 1 ? "var(--series)" : "var(--series-dim)"}>
            <title>{`${v} event${v === 1 ? "" : "s"}, ${values.length - 1 - i}h ago`}</title>
          </rect>
        );
      })}
    </svg>
  );
}
