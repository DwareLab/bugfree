CREATE TABLE users (
  id            bigserial PRIMARY KEY,
  email         text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  -- sha256 of the cookie token; the token itself is never stored
  token_hash text PRIMARY KEY,
  user_id    bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_expires_idx ON sessions (expires_at);

CREATE TABLE projects (
  id                   bigserial PRIMARY KEY,
  name                 text NOT NULL,
  platform             text NOT NULL DEFAULT 'nextjs',
  -- public: embedded in the DSN, can only submit events
  public_key           text NOT NULL UNIQUE,
  -- secret: used by the CLI to upload source maps
  secret_key           text NOT NULL UNIQUE,
  alert_webhook_url    text,
  alert_emails         text,
  alert_on_new         boolean NOT NULL DEFAULT true,
  alert_on_regression  boolean NOT NULL DEFAULT true,
  created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE issues (
  id             bigserial PRIMARY KEY,
  project_id     bigint NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  fingerprint    text NOT NULL,
  title          text NOT NULL,
  culprit        text,
  type           text,
  value          text,
  level          text NOT NULL DEFAULT 'error',
  platform       text,
  status         text NOT NULL DEFAULT 'unresolved' CHECK (status IN ('unresolved', 'resolved', 'ignored')),
  times_seen     bigint NOT NULL DEFAULT 0,
  first_seen     timestamptz NOT NULL DEFAULT now(),
  last_seen      timestamptz NOT NULL DEFAULT now(),
  first_release  text,
  last_release   text,
  resolved_at    timestamptz,
  last_alert_at  timestamptz,
  UNIQUE (project_id, fingerprint)
);
CREATE INDEX issues_project_last_seen_idx ON issues (project_id, status, last_seen DESC);
CREATE INDEX issues_project_first_seen_idx ON issues (project_id, first_seen DESC);
CREATE INDEX issues_project_times_seen_idx ON issues (project_id, times_seen DESC);

CREATE TABLE events (
  id           bigserial PRIMARY KEY,
  event_id     text NOT NULL,
  project_id   bigint NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  issue_id     bigint NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  received_at  timestamptz NOT NULL DEFAULT now(),
  occurred_at  timestamptz NOT NULL,
  level        text NOT NULL,
  platform     text,
  environment  text,
  release      text,
  transaction_name text,
  message      text,
  user_key     text,
  data         jsonb NOT NULL
);
CREATE UNIQUE INDEX events_project_event_id_idx ON events (project_id, event_id);
CREATE INDEX events_issue_received_idx ON events (issue_id, received_at DESC);
CREATE INDEX events_project_received_idx ON events (project_id, received_at);
CREATE INDEX events_received_idx ON events (received_at);
CREATE INDEX events_project_release_idx ON events (project_id, release);

-- Per-issue value counts for tags (environment, release, browser, os, url, custom tags …)
CREATE TABLE issue_tags (
  issue_id   bigint NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  key        text NOT NULL,
  value      text NOT NULL,
  times_seen bigint NOT NULL DEFAULT 0,
  first_seen timestamptz NOT NULL DEFAULT now(),
  last_seen  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (issue_id, key, value)
);
CREATE INDEX issue_tags_key_value_idx ON issue_tags (key, value);

-- Distinct users per issue (by user id/email/ip), for the "users affected" count
CREATE TABLE issue_users (
  issue_id bigint NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  user_key text NOT NULL,
  PRIMARY KEY (issue_id, user_key)
);

-- Hourly event counts per issue; survive event retention so charts stay complete
CREATE TABLE issue_hourly (
  issue_id bigint NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  hour     timestamptz NOT NULL,
  count    bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (issue_id, hour)
);

CREATE TABLE releases (
  id         bigserial PRIMARY KEY,
  project_id bigint NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  version    text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, version)
);

CREATE TABLE artifacts (
  id         bigserial PRIMARY KEY,
  release_id bigint NOT NULL REFERENCES releases(id) ON DELETE CASCADE,
  name       text NOT NULL,
  size       integer NOT NULL,
  content    bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (release_id, name)
);
