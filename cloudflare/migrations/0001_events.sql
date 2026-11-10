CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY NOT NULL,
  installation_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN (
    'unconfirmed_lure_view',
    'invalid_key_attempt',
    'confirmed_reuse',
    'block'
  )),
  route TEXT CHECK (route IS NULL OR route IN ('env-file', 'bait-api')),
  source_ip TEXT,
  confirmed INTEGER NOT NULL CHECK (confirmed IN (0, 1)),
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS events_installation_created_idx
  ON events (installation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS events_created_idx ON events (created_at);

CREATE TABLE IF NOT EXISTS runtime_settings (
  installation_id TEXT PRIMARY KEY NOT NULL,
  last_alert_at INTEGER,
  pending_outbox_id TEXT
);

CREATE TABLE IF NOT EXISTS webhook_outbox (
  id TEXT PRIMARY KEY NOT NULL,
  installation_id TEXT NOT NULL,
  event_ids_json TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('pending', 'sending', 'delivered', 'dead')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_error TEXT
);

CREATE INDEX IF NOT EXISTS webhook_outbox_due_idx
  ON webhook_outbox (status, next_attempt_at);
CREATE INDEX IF NOT EXISTS webhook_outbox_installation_idx
  ON webhook_outbox (installation_id, status);
