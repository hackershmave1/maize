-- SQLite cannot alter a CHECK constraint, so rebuild events with the expanded lure route list.
CREATE TABLE events_v4 (
  id TEXT PRIMARY KEY NOT NULL,
  installation_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN (
    'unconfirmed_lure_view',
    'invalid_key_attempt',
    'confirmed_reuse',
    'block'
  )),
  route TEXT CHECK (route IS NULL OR route IN (
    'env-file',
    'env-production',
    'git-config',
    'aws-credentials',
    'config-json',
    'wp-config-backup',
    'sql-backup',
    'api-keys',
    'swagger',
    'bait-api'
  )),
  source_ip TEXT,
  confirmed INTEGER NOT NULL CHECK (confirmed IN (0, 1)),
  created_at INTEGER NOT NULL
);

INSERT INTO events_v4 (id, installation_id, type, route, source_ip, confirmed, created_at)
  SELECT id, installation_id, type, route, source_ip, confirmed, created_at FROM events;

DROP TABLE events;

ALTER TABLE events_v4 RENAME TO events;

CREATE INDEX IF NOT EXISTS events_installation_created_idx
  ON events (installation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS events_created_idx ON events (created_at);
