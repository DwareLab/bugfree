-- Bug reports filed by end users through a project's public portal, triaged on a Kanban board.

-- People who report bugs. They sign in with GitHub and are not team members: their session only
-- reaches the portal API, never the dashboard.
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

-- The portal lives at <APP_URL>/report/<portal_slug> while portal_enabled is on.
ALTER TABLE projects
  ADD COLUMN portal_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN portal_slug    text UNIQUE,
  -- last ticket number handed out, so tickets are #1, #2 … per project
  ADD COLUMN ticket_seq     integer NOT NULL DEFAULT 0;

CREATE TABLE tickets (
  id          bigserial PRIMARY KEY,
  project_id  bigint NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  number      integer NOT NULL,
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
  closed_at   timestamptz,
  UNIQUE (project_id, number)
);
CREATE INDEX tickets_project_status_idx ON tickets (project_id, status, position);
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
