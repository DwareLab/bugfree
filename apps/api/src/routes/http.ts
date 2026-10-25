import type { Request, Response } from "express";
import type { z } from "zod";

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function intParam(req: Request, name: string): number {
  const n = Number(req.params[name]);
  if (!Number.isSafeInteger(n) || n <= 0) throw new HttpError(404, "Not found");
  return n;
}

export function parseBody<T extends z.ZodType>(schema: T, req: Request): z.infer<T> {
  const result = schema.safeParse(req.body ?? {});
  if (!result.success) {
    const first = result.error.issues[0];
    throw new HttpError(400, first ? `${first.path.join(".") || "body"}: ${first.message}` : "Invalid request");
  }
  return result.data;
}

export function notFound(res: Response, what = "Not found"): void {
  res.status(404).json({ error: what });
}
