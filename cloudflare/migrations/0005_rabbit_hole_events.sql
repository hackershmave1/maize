-- SQLite cannot alter CHECK constraints, so rebuild events with rabbit-hole hop events.
CREATE TABLE events_v5 (
  id TEXT PRIMARY KEY NOT NULL,
  installation_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN (
    'unconfirmed_lure_view',
    'invalid_key_attempt',
    'confirmed_reuse',
    'rabbit_hole_hop',
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
    'bait-api',
    'hop-2',
    'hop-3',
    'hop-4',
    'hop-5',
    'hop-6',
    'hop-7',
    'hop-8',
    'hop-9',
    'hop-10'
  )),
  source_ip TEXT,
  confirmed INTEGER NOT NULL CHECK (confirmed IN (0, 1)),
  created_at INTEGER NOT NULL
);

INSERT INTO events_v5 (id, installation_id, type, route, source_ip, confirmed, created_at)
  SELECT id, installation_id, type, route, source_ip, confirmed, created_at FROM events;

DROP TABLE events;

ALTER TABLE events_v5 RENAME TO events;

CREATE INDEX IF NOT EXISTS events_installation_created_idx
  ON events (installation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS events_created_idx ON events (created_at);
