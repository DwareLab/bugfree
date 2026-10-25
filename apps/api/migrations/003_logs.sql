-- Log lines shipped by the Docker log agent (or anything that posts to /api/logs/:project).
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE logs (
  id           bigserial PRIMARY KEY,
  project_id   bigint NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  ts           timestamptz NOT NULL,
  received_at  timestamptz NOT NULL DEFAULT now(),
  level        text NOT NULL DEFAULT 'info',
  -- stdout / stderr
  stream       text,
  host         text,
  -- container name, compose service, image, short container id
  container    text,
  service      text,
  image        text,
  container_id text,
  message      text NOT NULL,
  -- fields of structured (JSON) log lines, minus the message/level/time
  attributes   jsonb
);
CREATE INDEX logs_project_ts_idx ON logs (project_id, ts DESC, id DESC);
CREATE INDEX logs_project_container_ts_idx ON logs (project_id, container, ts DESC);
-- Substring search (ILIKE '%…%') without a sequential scan.
CREATE INDEX logs_message_trgm_idx ON logs USING gin (message gin_trgm_ops);
-- Makes ingest idempotent: a collector that re-sends lines after a crash or restart doesn't duplicate them.
-- Docker timestamps each line in nanoseconds, so container + time + text identifies it.
CREATE UNIQUE INDEX logs_line_idx ON logs (project_id, container_id, ts, md5(message));
-- Rows arrive in received_at order, so a BRIN index makes retention deletes cheap.
CREATE INDEX logs_received_brin_idx ON logs USING brin (received_at);
