import { gzipSync } from "node:zlib";

export interface OutgoingLog {
  timestamp: string;
  message: string;
  stream: "stdout" | "stderr";
  container: string;
  service?: string;
  image?: string;
  container_id: string;
}

export interface Queued {
  log: OutgoingLog;
  /** Full container id and the resume cursor for that container once this line is stored. */
  containerId: string;
  cursor: string;
}

export interface ShipperOptions {
  url: string;
  key: string;
  host: string;
  batchSize?: number;
  flushMs?: number;
  /** Followers are paused above this many queued lines (Docker keeps the rest until we catch up). */
  highWater?: number;
  onShipped: (batch: Queued[]) => void;
  onPressure: (paused: boolean) => void;
  log: (msg: string) => void;
}

/** Batches lines and POSTs them (gzipped) in order, one request at a time, retrying with backoff. */
export class Shipper {
  private queue: Queued[] = [];
  private sending = false;
  private paused = false;
  private retryAt = 0;
  private failures = 0;
  private timer: NodeJS.Timeout | null = null;
  private readonly batchSize: number;
  private readonly flushMs: number;
  private readonly highWater: number;

  constructor(private readonly o: ShipperOptions) {
    this.batchSize = o.batchSize ?? 1000;
    this.flushMs = o.flushMs ?? 1000;
    this.highWater = o.highWater ?? 20_000;
  }

  get size(): number {
    return this.queue.length;
  }

  push(item: Queued): void {
    this.queue.push(item);
    if (!this.paused && this.queue.length >= this.highWater) {
      this.paused = true;
      this.o.log(`API is behind (${this.queue.length} lines queued); pausing log streams until it catches up`);
      this.o.onPressure(true);
    }
    if (this.queue.length >= this.batchSize) void this.send();
    else this.schedule();
  }

  /** Sends everything queued; gives up after `timeoutMs` (used on shutdown). */
  async drain(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    this.retryAt = 0;
    while (this.queue.length && Date.now() < deadline) {
      if (!this.sending) await this.send();
      else await new Promise((r) => setTimeout(r, 50));
      if (this.failures) break;
    }
  }

  private schedule(delay = this.flushMs): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.send();
    }, delay);
    this.timer.unref?.();
  }

  private async send(): Promise<void> {
    if (this.sending || !this.queue.length) return;
    const wait = this.retryAt - Date.now();
    if (wait > 0) return this.schedule(wait);
    this.sending = true;
    const batch = this.queue.slice(0, this.batchSize);
    try {
      const status = await this.post(batch.map((q) => q.log));
      if (status === "ok" || status === "drop") {
        this.queue.splice(0, batch.length);
        if (status === "ok") this.o.onShipped(batch);
        if (this.failures) this.o.log("Shipping logs again");
        this.failures = 0;
        if (this.paused && this.queue.length < this.highWater / 2) {
          this.paused = false;
          this.o.onPressure(false);
        }
      } else {
        this.backoff(status === "rate-limited" ? 5000 : undefined);
      }
    } catch (err) {
      this.backoff();
      if (this.failures === 1 || this.failures % 20 === 0) this.o.log(`Could not reach ${new URL(this.o.url).origin}: ${(err as Error).message}`);
    } finally {
      this.sending = false;
    }
    if (!this.queue.length) return;
    const retryIn = this.retryAt - Date.now();
    this.schedule(retryIn > 0 ? retryIn : this.queue.length >= this.batchSize ? 0 : this.flushMs);
  }

  private backoff(minMs = 0): void {
    this.failures++;
    this.retryAt = Date.now() + Math.max(minMs, Math.min(30_000, 500 * 2 ** Math.min(this.failures, 6)));
  }

  private async post(logs: OutgoingLog[]): Promise<"ok" | "drop" | "retry" | "rate-limited"> {
    const res = await fetch(this.o.url, {
      method: "POST",
      headers: { "content-type": "application/json", "content-encoding": "gzip", "x-bugfree-key": this.o.key },
      body: gzipSync(JSON.stringify({ host: this.o.host, logs })),
      signal: AbortSignal.timeout(30_000),
    });
    if (res.ok) return "ok";
    const text = await res.text().catch(() => "");
    if (res.status === 429) return "rate-limited";
    if (res.status === 400 || res.status === 413) {
      // Retrying would fail the same way forever.
      this.o.log(`Dropped ${logs.length} lines rejected by the API (${res.status}): ${text.slice(0, 300)}`);
      return "drop";
    }
    if (this.failures === 0 || this.failures % 20 === 0) this.o.log(`API answered ${res.status}: ${text.slice(0, 300)}${res.status === 401 ? " (check BUGFREE_DSN)" : ""}`);
    return "retry";
  }
}
