-- Personal API tokens, used by MCP clients (and scripts) instead of a session cookie.
CREATE TABLE api_tokens (
  id           bigserial PRIMARY KEY,
  user_id      bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         text NOT NULL,
  -- sha256 of the token; the token itself is shown once and never stored
  token_hash   text NOT NULL UNIQUE,
  -- first characters of the token, so it can be recognised in the list
  prefix       text NOT NULL,
  last_used_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX api_tokens_user_idx ON api_tokens (user_id);
