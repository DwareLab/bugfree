import http from "node:http";

export interface ContainerSummary {
  Id: string;
  Names: string[];
  State: string;
}

export interface ContainerInfo {
  Id: string;
  Name: string;
  Config: { Image: string; Tty: boolean; Labels: Record<string, string> | null };
  State: { Running: boolean; StartedAt: string; FinishedAt: string };
  HostConfig: { LogConfig?: { Type: string } };
}

export interface DockerEvent {
  Type: string;
  Action: string;
  Actor: { ID: string; Attributes: Record<string, string> };
  id?: string;
}

/** Read-only Docker Engine API client: a unix socket (default) or `tcp://host:port` (e.g. a socket proxy). */
export class Docker {
  private readonly target: { socketPath: string } | { host: string; port: number };

  constructor(dockerHost = process.env.DOCKER_HOST || "unix:///var/run/docker.sock") {
    if (dockerHost.startsWith("unix://")) this.target = { socketPath: dockerHost.slice("unix://".length) };
    else if (dockerHost.startsWith("/")) this.target = { socketPath: dockerHost };
    else {
      const url = new URL(dockerHost.replace(/^tcp:/, "http:"));
      this.target = { host: url.hostname, port: Number(url.port || 2375) };
    }
  }

  get description(): string {
    return "socketPath" in this.target ? this.target.socketPath : `${this.target.host}:${this.target.port}`;
  }

  /** A streaming GET; the caller consumes (and eventually destroys) the response. */
  stream(path: string): Promise<http.IncomingMessage> {
    return new Promise((resolve, reject) => {
      const req = http.request({ ...this.target, path, method: "GET", headers: { host: "docker" } }, (res) => {
        if ((res.statusCode ?? 500) >= 400) {
          let body = "";
          res.setEncoding("utf8");
          res.on("data", (c) => (body += c));
          res.on("end", () => reject(new DockerError(res.statusCode ?? 500, parseMessage(body) || `HTTP ${res.statusCode}`)));
          return;
        }
        resolve(res);
      });
      req.on("error", reject);
      req.end();
    });
  }

  async json<T>(path: string): Promise<T> {
    const res = await this.stream(path);
    let body = "";
    res.setEncoding("utf8");
    for await (const chunk of res) body += chunk;
    return JSON.parse(body) as T;
  }
}

export class DockerError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function parseMessage(body: string): string {
  try {
    return (JSON.parse(body) as { message?: string }).message ?? body;
  } catch {
    return body.trim();
  }
}
