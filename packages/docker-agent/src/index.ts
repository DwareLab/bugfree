import { promises as fs, readFileSync } from "node:fs";
import type http from "node:http";
import os from "node:os";
import path from "node:path";
import { parseDsn } from "@dwarelab/bugfree-core";
import { type ContainerInfo, type ContainerSummary, Docker, type DockerEvent } from "./docker";
import { compareTimestamps, globMatcher, LogStreamParser, MultilineMerger, sinceAfter } from "./lines";
import { type Queued, Shipper } from "./shipper";

const HELP = `bugfree-docker-agent: ships the logs of every Docker container on this host to bugfree,
so they survive container restarts and re-creates.

Environment:
  BUGFREE_DSN            Project DSN (Settings & setup page)                         required
  BUGFREE_HOST_NAME      Host name shown in bugfree        default: the Docker host's name
  BUGFREE_INCLUDE        Only these containers: comma-separated globs on the container
                         or compose service name, e.g. "shop-*,worker"
  BUGFREE_EXCLUDE        Skip these containers (same syntax). Label a container
                         bugfree.logs=false to skip it too
  BUGFREE_INITIAL_TAIL   Lines to read from already-running containers on first start   default: 200
  BUGFREE_STATE_DIR      Where read positions are kept, so restarts neither lose nor
                         duplicate lines                       default: ~/.bugfree-agent
  DOCKER_HOST            unix:///var/run/docker.sock (default) or tcp://socket-proxy:2375
`;

const log = (msg: string) => console.log(`[bugfree-agent] ${msg}`);

interface State {
  /** Container id → timestamp of the last line stored in bugfree. */
  cursors: Record<string, string>;
}

class Agent {
  private readonly docker = new Docker();
  private readonly followers = new Map<string, http.IncomingMessage | null>();
  /** Last line read per container (ahead of `state.cursors` while lines are queued). */
  private readonly readCursors = new Map<string, string>();
  private state: State = { cursors: {} };
  private stateDirty = false;
  private paused = false;
  private stopping = false;
  private events: http.IncomingMessage | null = null;
  private shipper!: Shipper;
  private selfIds: string[] = [];
  private readonly include = globMatcher(process.env.BUGFREE_INCLUDE);
  private readonly exclude = globMatcher(process.env.BUGFREE_EXCLUDE);
  private readonly initialTail = Number(process.env.BUGFREE_INITIAL_TAIL ?? 200);
  private readonly stateFile = path.join(process.env.BUGFREE_STATE_DIR || path.join(os.homedir(), ".bugfree-agent"), "state.json");

  async start(): Promise<void> {
    const dsnString = process.env.BUGFREE_DSN;
    if (!dsnString) {
      console.error(HELP);
      throw new Error("Set BUGFREE_DSN to the project's DSN");
    }
    const dsn = parseDsn(dsnString);
    const version = await this.docker.json<{ Version: string }>("/version").catch((err: Error) => {
      throw new Error(`Cannot reach Docker at ${this.docker.description}: ${err.message}. Mount /var/run/docker.sock or set DOCKER_HOST.`);
    });
    // Socket proxies often deny /info; it only provides the host's name.
    const info = await this.docker.json<{ Name?: string }>("/info").catch(() => ({ Name: undefined }));
    const host = process.env.BUGFREE_HOST_NAME || info.Name || os.hostname();
    this.selfIds = selfContainerIds();
    await this.loadState();

    this.shipper = new Shipper({
      url: `${dsn.apiUrl}/api/logs/${encodeURIComponent(dsn.projectId)}`,
      key: dsn.publicKey,
      host,
      log,
      onShipped: (batch) => this.shipped(batch),
      onPressure: (paused) => {
        this.paused = paused;
        for (const res of this.followers.values()) paused ? res?.pause() : res?.resume();
      },
    });

    log(`Docker ${version.Version} on ${host}; shipping to ${dsn.apiUrl} (project ${dsn.projectId})`);
    void this.watchEvents();
    await this.attachAll();
    setInterval(() => void this.saveState(), 2000).unref();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.events?.destroy();
    for (const res of this.followers.values()) res?.destroy();
    // Followers flush their last partial lines as their streams close.
    await new Promise((r) => setTimeout(r, 400));
    await this.shipper?.drain(5000);
    await this.saveState();
    if (this.shipper?.size) log(`${this.shipper.size} lines not shipped; they will be re-read from Docker on the next start`);
  }

  /** Follows running containers, and catches up on stopped ones that logged after their cursor while we were away. */
  private async attachAll(): Promise<void> {
    const list = await this.docker.json<ContainerSummary[]>("/containers/json?all=1");
    const exists = new Set(list.map((c) => c.Id));
    for (const id of Object.keys(this.state.cursors)) {
      if (exists.has(id)) continue;
      delete this.state.cursors[id];
      this.stateDirty = true;
    }
    let following = 0;
    for (const c of list) {
      if (c.State !== "running" && !this.state.cursors[c.Id]) continue;
      if (await this.attach(c.Id, "startup")) following++;
    }
    log(`Following ${following} container(s)`);
  }

  private async watchEvents(): Promise<void> {
    const filters = encodeURIComponent(JSON.stringify({ type: ["container"], event: ["start", "destroy"] }));
    let delay = 1000;
    while (!this.stopping) {
      try {
        this.events = await this.docker.stream(`/events?filters=${filters}`);
        delay = 1000;
        let buf = "";
        this.events.setEncoding("utf8");
        for await (const chunk of this.events) {
          buf += chunk;
          let nl: number;
          while ((nl = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (line) this.onEvent(JSON.parse(line) as DockerEvent);
          }
        }
      } catch (err) {
        if (!this.stopping) log(`Docker events stream failed: ${(err as Error).message}`);
      }
      if (this.stopping) return;
      // The daemon restarted or the connection dropped: reconnect and pick up containers started meanwhile.
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, 30_000);
      await this.attachAll().catch(() => {});
    }
  }

  private onEvent(e: DockerEvent): void {
    const id = e.Actor?.ID ?? e.id;
    if (!id) return;
    if (e.Action === "start") void this.attachWhenFree(id);
    else if (e.Action === "destroy") {
      // Give the follower time to ship its last lines, then forget the container.
      setTimeout(() => {
        if (this.followers.has(id)) return;
        delete this.state.cursors[id];
        this.readCursors.delete(id);
        this.stateDirty = true;
      }, 60_000).unref();
    }
  }

  /** On `docker restart` the start event can arrive before the previous run's log stream has closed. */
  private async attachWhenFree(id: string): Promise<void> {
    for (let i = 0; i < 20 && this.followers.has(id); i++) await new Promise((r) => setTimeout(r, 500));
    await this.attach(id, "start");
  }

  private skip(c: ContainerInfo, name: string, service: string | undefined): string | null {
    if (this.selfIds.some((s) => c.Id.startsWith(s))) return "the agent itself";
    if (c.Config.Labels?.["bugfree.logs"] === "false") return "label bugfree.logs=false";
    const names = [name, service].filter((n): n is string => !!n);
    if (this.include && !names.some(this.include)) return "not in BUGFREE_INCLUDE";
    if (this.exclude && names.some(this.exclude)) return "in BUGFREE_EXCLUDE";
    const driver = c.HostConfig.LogConfig?.Type;
    if (driver && !["json-file", "local", "journald"].includes(driver)) return `log driver "${driver}" can't be read back`;
    return null;
  }

  /** Starts reading a container's logs from where we left off. Returns whether it is being followed. */
  private async attach(id: string, reason: "startup" | "start"): Promise<boolean> {
    if (this.followers.has(id) || this.stopping) return false;
    this.followers.set(id, null);
    try {
      const c = await this.docker.json<ContainerInfo>(`/containers/${id}/json`);
      const name = c.Name.replace(/^\//, "");
      const service = c.Config.Labels?.["com.docker.compose.service"];
      const skipped = this.skip(c, name, service);
      if (skipped) {
        if (reason === "start" || process.env.BUGFREE_DEBUG) log(`Skipping ${name}: ${skipped}`);
        this.followers.delete(id);
        return false;
      }

      const cursor = this.readCursors.get(id) ?? this.state.cursors[id];
      if (!c.State.Running && (!cursor || compareTimestamps(c.State.FinishedAt, cursor) <= 0)) {
        this.followers.delete(id);
        return false;
      }
      const params = new URLSearchParams({ stdout: "1", stderr: "1", timestamps: "1", follow: c.State.Running ? "1" : "0" });
      if (cursor) params.set("since", sinceAfter(cursor));
      // A container we have never seen: everything since it started; one that was already running: the last few lines.
      else if (reason === "start") params.set("since", String(Math.floor(Date.parse(c.State.StartedAt) / 1000) - 1));
      else params.set("tail", String(this.initialTail));

      const res = await this.docker.stream(`/containers/${id}/logs?${params}`);
      this.followers.set(id, res);
      if (this.paused) res.pause();
      if (reason === "start") log(`Following ${name}`);

      const meta = { container: name, service, image: c.Config.Image, container_id: id.slice(0, 12) };
      const merger = new MultilineMerger((entry) => {
        this.readCursors.set(id, entry.lastTimestamp);
        const item: Queued = { log: { ...meta, timestamp: entry.timestamp, message: entry.message, stream: entry.stream }, containerId: id, cursor: entry.lastTimestamp };
        this.shipper.push(item);
      });
      const parser = new LogStreamParser(c.Config.Tty, (line) => merger.add(line));
      res.on("data", (chunk: Buffer) => parser.push(chunk));
      const done = () => {
        parser.end();
        merger.flush();
        if (this.followers.get(id) === res) this.followers.delete(id);
      };
      res.on("end", done);
      res.on("close", done);
      res.on("error", done);
      return true;
    } catch (err) {
      this.followers.delete(id);
      if (!this.stopping) log(`Cannot read logs of ${id.slice(0, 12)}: ${(err as Error).message}`);
      return false;
    }
  }

  private shipped(batch: Queued[]): void {
    for (const q of batch) {
      const prev = this.state.cursors[q.containerId];
      if (!prev || compareTimestamps(q.cursor, prev) > 0) this.state.cursors[q.containerId] = q.cursor;
    }
    this.stateDirty = true;
  }

  private async loadState(): Promise<void> {
    try {
      this.state = { cursors: {}, ...JSON.parse(await fs.readFile(this.stateFile, "utf8")) };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") log(`Ignoring unreadable ${this.stateFile}: ${(err as Error).message}`);
    }
    await fs.mkdir(path.dirname(this.stateFile), { recursive: true }).catch((err: Error) => log(`Cannot create ${path.dirname(this.stateFile)}: ${err.message}`));
  }

  private async saveState(): Promise<void> {
    if (!this.stateDirty) return;
    this.stateDirty = false;
    const tmp = `${this.stateFile}.tmp`;
    try {
      await fs.writeFile(tmp, JSON.stringify(this.state));
      await fs.rename(tmp, this.stateFile);
    } catch (err) {
      this.stateDirty = true;
      log(`Cannot save ${this.stateFile}: ${(err as Error).message}`);
    }
  }
}

/** Ids this process may be running as, so the agent doesn't ship its own output. */
function selfContainerIds(): string[] {
  const ids = new Set<string>();
  try {
    for (const m of readFileSync("/proc/self/mountinfo", "utf8").matchAll(/\/containers\/([0-9a-f]{64})\//g)) ids.add(m[1]);
  } catch {
    // Not Linux, or not in a container.
  }
  if (/^[0-9a-f]{12}$/.test(os.hostname())) ids.add(os.hostname());
  return [...ids];
}

async function main(): Promise<void> {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log(HELP);
    return;
  }
  const agent = new Agent();
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    log("Shutting down");
    await agent.stop();
    process.exit(0);
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  await agent.start();
}

main().catch((err) => {
  console.error(`[bugfree-agent] ${(err as Error).message}`);
  process.exit(1);
});
