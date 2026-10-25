export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { init } = await import("@bugfree/nextjs/server");
    init({ debug: true });
  }
}

export { captureRequestError as onRequestError } from "@bugfree/nextjs";
