import { z } from "zod";

const level = z.enum(["fatal", "error", "warning", "info", "debug"]);
const str = (max: number) => z.string().transform((s) => (s.length > max ? `${s.slice(0, max)}…` : s));
const lines = z.array(str(500)).max(20);

const frame = z.object({
  filename: str(1000).optional(),
  abs_path: str(1000).optional(),
  function: str(500).optional(),
  lineno: z.number().int().nonnegative().optional(),
  colno: z.number().int().nonnegative().optional(),
  in_app: z.boolean().optional(),
  pre_context: lines.optional(),
  context_line: str(500).optional(),
  post_context: lines.optional(),
});

const exception = z.object({
  type: str(200).default("Error"),
  value: str(8000).default(""),
  stacktrace: z.object({ frames: z.array(frame).max(100) }).optional(),
  mechanism: z
    .object({ type: str(100), handled: z.boolean(), data: z.record(z.string(), z.unknown()).optional() })
    .optional(),
});

const breadcrumb = z.object({
  timestamp: z.string(),
  type: str(50).optional(),
  category: str(100).optional(),
  message: str(2000).optional(),
  level: level.optional().catch(undefined),
  data: z.record(z.string(), z.unknown()).optional(),
});

export const eventSchema = z.object({
  event_id: z.string().regex(/^[0-9a-f]{32}$/i, "event_id must be 32 hex chars"),
  timestamp: z.string().optional(),
  platform: z.enum(["node", "javascript"]).catch("javascript"),
  level: level.catch("error"),
  environment: str(100).optional(),
  release: str(200).optional(),
  server_name: str(200).optional(),
  transaction: str(300).optional(),
  message: str(8000).optional(),
  exception: z.object({ values: z.array(exception).max(10) }).optional(),
  breadcrumbs: z.array(breadcrumb).max(200).optional(),
  request: z
    .object({
      method: str(20).optional(),
      url: str(2000).optional(),
      query_string: str(2000).optional(),
      headers: z.record(z.string(), str(1000)).optional(),
      data: z.unknown().optional(),
    })
    .optional(),
  user: z.record(z.string(), z.unknown()).optional(),
  tags: z.record(z.string(), z.coerce.string()).optional(),
  contexts: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
  extra: z.record(z.string(), z.unknown()).optional(),
  fingerprint: z.array(str(200)).max(20).optional(),
  sdk: z.object({ name: str(100), version: str(50) }).optional(),
});

export type IncomingEvent = z.infer<typeof eventSchema>;
export type Frame = z.infer<typeof frame>;
export type ExceptionValue = z.infer<typeof exception>;
