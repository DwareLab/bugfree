export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { init } = await import("@dwarelab/bugfree-nextjs/server");
    init({ debug: true });
  }
  if (process.env.NEXT_RUNTIME === "edge") {
    const { initEdge } = await import("@dwarelab/bugfree-nextjs");
    initEdge({ debug: true });
  }
}

export { captureRequestError as onRequestError } from "@dwarelab/bugfree-nextjs";
