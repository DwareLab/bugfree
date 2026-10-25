import { defineCloudflareConfig } from "@opennextjs/cloudflare";

// Every dashboard page renders on the client, so no incremental cache (R2/KV) is needed.
export default defineCloudflareConfig({});
