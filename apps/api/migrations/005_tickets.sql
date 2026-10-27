-- Bug reports filed by end users through public report pages, triaged on Kanban boards.

-- People who report bugs. They sign in with GitHub and are not team members: their session only
-- reaches the report page API, never the dashboard.
CREATE TABLE reporters (
  id           bigserial PRIMARY KEY,
  github_id    bigint NOT NULL UNIQUE,
  login        text NOT NULL,
  name         text,
  avatar_url   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE reporter_sessions (
  -- sha256 of the cookie token; the token itself is never stored
  token_hash  text PRIMARY KEY,
  reporter_id bigint NOT NULL REFERENCES reporters(id) ON DELETE CASCADE,
  expires_at  timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX reporter_sessions_expires_idx ON reporter_sessions (expires_at);

-- A public report page at <APP_URL>/report/<slug>. It can cover one project or several (a product made of
-- a web app and an API, say); reports from it are routed to one of its projects.
CREATE TABLE portals (
  id                bigserial PRIMARY KEY,
  -- shown to reporters as the page title
  name              text NOT NULL,
  slug              text NOT NULL UNIQUE,
  enabled           boolean NOT NULL DEFAULT true,
  -- shown above the report form
  intro             text,
  -- with several projects: reporters pick one (or "not sure"); otherwise reports wait in the inbox for the team
  ask_project       boolean NOT NULL DEFAULT true,
  -- notified of every report from this page; when empty, the project a report is routed to is notified
  alert_webhook_url text,
  alert_emails      text,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE portal_projects (
  portal_id  bigint NOT NULL REFERENCES portals(id) ON DELETE CASCADE,
  project_id bigint NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  -- what reporters see instead of the internal project name, e.g. "Mobile app"
  label      text,
  position   integer NOT NULL DEFAULT 0,
  PRIMARY KEY (portal_id, project_id)
);
CREATE INDEX portal_projects_project_idx ON portal_projects (project_id);

-- Shown to reporters as #id: ids stay the same when a report is routed to another project.
CREATE TABLE tickets (
  id          bigserial PRIMARY KEY,
  -- the page it was filed on (kept for the conversation even if the page is deleted later)
  portal_id   bigint REFERENCES portals(id) ON DELETE SET NULL,
  -- NULL until the team (or the reporter) routes it to a project
  project_id  bigint REFERENCES projects(id) ON DELETE SET NULL,
  reporter_id bigint REFERENCES reporters(id) ON DELETE SET NULL,
  title       text NOT NULL,
  description text NOT NULL,
  page_url    text,
  user_agent  text,
  severity    text NOT NULL DEFAULT 'normal' CHECK (severity IN ('low', 'normal', 'high', 'critical')),
  status      text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'todo', 'in_progress', 'done', 'wont_fix')),
  -- order within the status column (lower first); moves pick a value between the neighbours
  position    double precision NOT NULL,
  assignee_id bigint REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  closed_at   timestamptz
);
CREATE INDEX tickets_project_status_idx ON tickets (project_id, status, position);
CREATE INDEX tickets_portal_status_idx ON tickets (portal_id, status, position);
CREATE INDEX tickets_reporter_idx ON tickets (reporter_id, created_at DESC);

-- A conversation on a ticket, written by a team member (user_id) or the reporter (reporter_id).
-- Internal notes are only shown in the dashboard.
CREATE TABLE ticket_comments (
  id          bigserial PRIMARY KEY,
  ticket_id   bigint NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  user_id     bigint REFERENCES users(id) ON DELETE SET NULL,
  reporter_id bigint REFERENCES reporters(id) ON DELETE SET NULL,
  body        text NOT NULL,
  internal    boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (user_id IS NULL OR reporter_id IS NULL)
);
CREATE INDEX ticket_comments_ticket_idx ON ticket_comments (ticket_id, created_at);
