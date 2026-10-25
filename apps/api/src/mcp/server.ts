import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler, McpServer, type AuthInfo, type McpRequestContext } from "@modelcontextprotocol/server";
import { type NextFunction, type Request, type Response, Router } from "express";
import { z } from "zod";
import { loadTokenUser } from "../auth";
import { config } from "../config";
import { findEvent, getEvent, getIssue, listEvents, listIssues, setIssueStatus } from "../routes/issues";
import { logSources, searchLogs } from "../routes/logs";
import { listProjects } from "../routes/projects";
import { formatEvent, formatIssue, formatIssueRow, type IssueDetail, type StoredEvent } from "./format";

const VERSION = "0.1.0";

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
const fail = (t: string) => ({ ...text(t), isError: true });
const issueLink = (id: number) => `${config.appUrls[0]}/issues/${id}`;

const issueId = z.number().int().positive().describe("Issue id (the number after # in list_issues)");
const status = z.enum(["unresolved", "resolved", "ignored"]);
const readOnly = { readOnlyHint: true, openWorldHint: false } as const;

/** A fresh server per request (stateless): tools read the database directly, scoped like the dashboard (all projects). */
function createServer({ authInfo }: McpRequestContext): McpServer {
  const canWrite = authInfo?.scopes.includes("write") ?? false;
  const server = new McpServer(
    { name: "bugfree", title: "bugfree error tracking", version: VERSION },
    {
      instructions:
        "bugfree is a self-hosted error tracker. Start with list_projects, then list_issues to find errors, then get_issue " +
        "for an issue's latest event with its symbolicated stack trace, breadcrumbs and request. Frames marked [library] are " +
        "not application code. search_logs reads the container logs collected by the Docker log agent, e.g. around an event's " +
        "time. After fixing a bug, update_issue_status can mark it resolved (not with a read-only token); an event from a " +
        "release that hadn't seen the issue before it was resolved reopens it as a regression.",
    },
  );

  server.registerTool(
    "list_projects",
    {
      title: "List projects",
      description: "All projects with their id, platform, unresolved issue count, event volume in the last 24h and last event time.",
      annotations: readOnly,
    },
    async () => {
      const rows = await listProjects();
      if (!rows.length) return text("No projects yet. Create one in the bugfree dashboard.");
      return text(
        rows
          .map(
            (p) =>
              `- ${p.name} (id ${p.id}, ${p.platform}): ${p.unresolved_issues} unresolved issues, ${p.events_24h} events in 24h, ` +
              `last event ${p.last_event_at ? new Date(p.last_event_at).toISOString() : "never"}`,
          )
          .join("\n"),
      );
    },
  );

  server.registerTool(
    "list_issues",
    {
      title: "List issues",
      description:
        "Search a project's issues (errors grouped by type and stack). `query` matches title/culprit text and supports " +
        'tag filters like `browser:Chrome url:/checkout release:1.2.0 is:resolved`, quoting values with spaces (`os:"Mac OS"`).',
      inputSchema: z.object({
        project_id: z.number().int().positive(),
        query: z.string().optional().describe("Free text and key:value tag filters"),
        status: z.enum(["unresolved", "resolved", "ignored", "all"]).default("unresolved"),
        environment: z.string().optional(),
        release: z.string().optional(),
        sort: z.enum(["last_seen", "first_seen", "times_seen", "users"]).default("last_seen"),
        limit: z.number().int().min(1).max(50).default(20),
        offset: z.number().int().min(0).default(0),
      }),
      annotations: readOnly,
    },
    async ({ project_id, ...opts }) => {
      const page = await listIssues(project_id, opts);
      if (!page.issues.length) return text(page.total ? `No issues at offset ${opts.offset} (total ${page.total}).` : "No matching issues.");
      const end = opts.offset + page.issues.length;
      const more = end < page.total ? `\n\n${page.total - end} more: call again with offset ${end}.` : "";
      return text(`${page.total} matching issues, showing ${opts.offset + 1}–${end}:\n\n${page.issues.map(formatIssueRow).join("\n")}${more}`);
    },
  );

  server.registerTool(
    "get_issue",
    {
      title: "Get issue",
      description:
        "Details of one issue (counts, releases, tag distribution) plus its latest event: the symbolicated stack trace with " +
        "source context, breadcrumbs leading up to the error, request, user and contexts.",
      inputSchema: z.object({ issue_id: issueId }),
      annotations: readOnly,
    },
    async ({ issue_id }) => {
      const issue = await getIssue(issue_id);
      if (!issue) return fail(`Issue ${issue_id} not found.`);
      const event = await getEvent(issue_id, "latest");
      const latest = event ? formatEvent(event as StoredEvent) : "No stored events (they may have expired).";
      return text(`${formatIssue(issue as IssueDetail, issueLink(issue_id))}\n\n# Latest event\n\n${latest}`);
    },
  );

  server.registerTool(
    "list_issue_events",
    {
      title: "List an issue's events",
      description: "The stored events of an issue, newest first, 50 per page, with the URL, release, environment and browser of each.",
      inputSchema: z.object({
        issue_id: issueId,
        before: z.number().int().positive().optional().describe("Event id to continue from (the `next` value of the previous page)"),
      }),
      annotations: readOnly,
    },
    async ({ issue_id, before }) => {
      const page = await listEvents(issue_id, before ?? null);
      if (!page.events.length) return text("No stored events.");
      const lines = page.events.map((e) =>
        [
          `- event ${e.id} · ${new Date(e.occurred_at).toISOString()}`,
          e.environment,
          e.release && `release ${e.release}`,
          e.transaction_name,
          e.url,
          e.browser,
          e.user_key && `user ${e.user_key}`,
        ]
          .filter(Boolean)
          .join(" · "),
      );
      return text(lines.join("\n") + (page.next ? `\n\nMore: call again with before=${page.next}.` : ""));
    },
  );

  server.registerTool(
    "get_event",
    {
      title: "Get event",
      description:
        "One event of an issue with its full stack trace, breadcrumbs and request: `latest`, `oldest` or an event id from " +
        "list_issue_events. The result names the neighbouring older/newer event ids.",
      inputSchema: z.object({
        issue_id: issueId,
        event: z.union([z.enum(["latest", "oldest"]), z.number().int().positive()]).default("latest"),
      }),
      annotations: readOnly,
    },
    async ({ issue_id, event }) => {
      const row = await getEvent(issue_id, String(event));
      if (!row) return fail(`No stored event ${event} for issue ${issue_id}.`);
      return text(formatEvent(row as StoredEvent));
    },
  );

  server.registerTool(
    "find_event",
    {
      title: "Find event by event_id",
      description: "Looks up an event by the id the SDK generated (e.g. shown to a user on an error page or in logs) and returns it with its issue id.",
      inputSchema: z.object({ event_id: z.string().min(8).max(64) }),
      annotations: readOnly,
    },
    async ({ event_id }) => {
      const found = await findEvent(event_id);
      if (!found) return fail(`No event with event_id ${event_id} (it may have expired).`);
      const row = await getEvent(found.issue_id, String(found.id));
      return text(`Issue #${found.issue_id} in project ${found.project_id} · ${issueLink(found.issue_id)}\n\n${formatEvent(row as StoredEvent)}`);
    },
  );

  server.registerTool(
    "search_logs",
    {
      title: "Search container logs",
      description:
        "Log lines collected from Docker containers, newest first. `query` matches message text and supports filters like " +
        "`container:api level:error` or a JSON log field (`reqId:abc`). Use `around` (an ISO time, e.g. an event's timestamp) " +
        "to see what the containers logged just before and after an error. Without a container, also lists the known containers.",
      inputSchema: z.object({
        project_id: z.number().int().positive(),
        query: z.string().optional().describe("Free text and key:value filters"),
        container: z.string().optional(),
        level: z.enum(["fatal", "error", "warning", "info", "debug"]).optional().describe("Minimum level"),
        around: z.string().datetime({ offset: true }).optional().describe("Show lines within `minutes` before and after this time"),
        minutes: z.number().int().min(1).max(7 * 24 * 60).default(60).describe("Look-back window (or half-window with `around`)"),
        limit: z.number().int().min(1).max(200).default(100),
        before: z.string().optional().describe("The `next` cursor of a previous call, for older lines"),
      }),
      annotations: readOnly,
    },
    async ({ project_id, query, container, level, around, minutes, limit, before }) => {
      const center = around ? new Date(around) : null;
      const span = minutes * 60_000;
      const from = new Date((center?.getTime() ?? Date.now()) - span);
      const to = center ? new Date(center.getTime() + span) : undefined;
      const page = await searchLogs(project_id, { query, container, level, from, to, limit, before });
      const lines = page.logs
        .slice()
        .reverse()
        .map((l) => `${l.ts} ${l.level.toUpperCase().padEnd(7)} [${l.container ?? l.host ?? "?"}] ${l.message}${l.attributes ? ` ${JSON.stringify(l.attributes)}` : ""}`);
      const sources = container ? "" : (await logSources(project_id)).map((s) => s.container).slice(0, 50).join(", ");
      const header = sources ? `Containers: ${sources}

` : "";
      if (!lines.length) return text(`${header}No log lines match between ${from.toISOString()} and ${(to ?? new Date()).toISOString()}.`);
      return text(`${header}${lines.join("\n")}${page.next ? `\n\nOlder lines: call again with before="${page.next}".` : ""}`);
    },
  );

  // Read-only tokens don't get the one tool that changes data.
  if (canWrite) server.registerTool(
    "update_issue_status",
    {
      title: "Resolve, ignore or reopen an issue",
      description:
        "Sets an issue's status. Mark it resolved once a fix ships: an event from a new release reopens it and alerts as a " +
        "regression, while events from releases that already had the issue (e.g. stale browser tabs) don't. " +
        "Ignored issues stay hidden from the default list.",
      inputSchema: z.object({ issue_id: issueId, status }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ issue_id, status }) => {
      const issue = await setIssueStatus(issue_id, status);
      if (!issue) return fail(`Issue ${issue_id} not found.`);
      return text(`Issue #${issue_id} is now ${status}. ${issueLink(issue_id)}`);
    },
  );

  return server;
}

const handler = createMcpHandler(createServer, {
  onerror: (err) => console.error("[mcp]", err),
});
const serve = toNodeHandler(handler);

/** Streamable HTTP MCP endpoint, authenticated with a personal API token (`Authorization: Bearer bfu_…`). */
export const mcpRouter = Router();

mcpRouter.all("/mcp", requireApiToken, async (req, res) => {
  await serve(req, res);
});

async function requireApiToken(req: Request, res: Response, next: NextFunction): Promise<void> {
  const user = await loadTokenUser(req);
  if (!user) {
    res.setHeader("WWW-Authenticate", 'Bearer realm="bugfree", error="invalid_token"');
    res.status(401).json({ error: "Send a bugfree API token (create one on the Team & account page) as Authorization: Bearer bfu_…" });
    return;
  }
  req.user = user;
  // Forwarded by toNodeHandler to the server factory as `authInfo`.
  (req as Request & { auth?: AuthInfo }).auth = {
    token: "",
    clientId: String(user.id),
    scopes: user.readOnly ? ["read"] : ["read", "write"],
  };
  next();
}

export const closeMcp = () => handler.close();
