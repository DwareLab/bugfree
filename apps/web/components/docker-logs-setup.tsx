"use client";

import { useState } from "react";
import type { Project } from "@/lib/api";
import { CodeBlock, Segmented } from "./ui";

const C = ({ children }: { children: React.ReactNode }) => <code className="rounded bg-surface-2 px-1 py-0.5 font-mono text-[12px] text-ink">{children}</code>;

/** How to run the Docker log agent on a host, with this project's DSN filled in. */
export function DockerLogsSetup({ project }: { project: Project }) {
  const [how, setHow] = useState<"compose" | "run">("compose");
  return (
    <div className="space-y-3">
      <p className="text-sm text-ink-2">
        Run the agent once per Docker host. It follows the stdout and stderr of every container on the host, including ones started later, and
        ships them here, so the logs survive <C>docker compose up</C> re-creates, restarts and crashes.
      </p>
      <Segmented
        value={how}
        onChange={setHow}
        options={[
          { value: "compose", label: "Docker Compose" },
          { value: "run", label: "docker run" },
        ]}
      />
      {how === "compose" ? (
        <CodeBlock
          title="docker-compose.yml"
          code={`services:
  bugfree-agent:
    image: ghcr.io/dwarelab/bugfree-docker-agent:latest
    restart: unless-stopped
    environment:
      BUGFREE_DSN: "${project.dsn}"
      # BUGFREE_EXCLUDE: "redis,*-migrate"   # or only some: BUGFREE_INCLUDE: "shop-*"
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
      - bugfree-agent:/data   # read positions: no gaps or duplicates across restarts

volumes:
  bugfree-agent:`}
        />
      ) : (
        <CodeBlock
          title="terminal"
          code={`docker run -d --name bugfree-agent --restart unless-stopped \\
  -e BUGFREE_DSN="${project.dsn}" \\
  -v /var/run/docker.sock:/var/run/docker.sock:ro \\
  -v bugfree-agent:/data \\
  ghcr.io/dwarelab/bugfree-docker-agent:latest`}
        />
      )}
      <p className="text-sm text-ink-2">
        Not on GHCR yet? Build it from the bugfree repository:{" "}
        <C>docker build -f packages/docker-agent/Dockerfile -t ghcr.io/dwarelab/bugfree-docker-agent .</C>
      </p>
      <p className="text-sm text-ink-2">
        Skip a container with the label <C>bugfree.logs=false</C>. JSON lines (pino, winston, zap …) become searchable fields, and stack traces
        are kept together as one entry. Access to the Docker socket is root-equivalent; to limit it, point <C>DOCKER_HOST</C> at a socket proxy
        that allows only <C>CONTAINERS</C> and <C>EVENTS</C>.
      </p>
    </div>
  );
}
