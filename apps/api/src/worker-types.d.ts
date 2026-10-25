// The few Workers runtime APIs worker.ts uses (`npx wrangler types` generates the full set).

declare module "cloudflare:node" {
  export function httpServerHandler(options: { port: number }): {
    fetch(request: Request, env: unknown, ctx: ExecutionContext): Promise<Response>;
  };
}

/** Wrangler bundles .sql files as strings. */
declare module "*.sql" {
  const sql: string;
  export default sql;
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}
