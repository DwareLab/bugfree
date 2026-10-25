-- Read-only tokens can search and read issues and logs but not change issue status.
ALTER TABLE api_tokens ADD COLUMN read_only boolean NOT NULL DEFAULT false;
