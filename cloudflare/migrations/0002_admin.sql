ALTER TABLE runtime_settings
  ADD COLUMN lures_enabled INTEGER NOT NULL DEFAULT 1
    CHECK (lures_enabled IN (0, 1));
ALTER TABLE runtime_settings
  ADD COLUMN maze_duration_minutes INTEGER NOT NULL DEFAULT 15
    CHECK (maze_duration_minutes BETWEEN 1 AND 120);
ALTER TABLE runtime_settings
  ADD COLUMN block_duration_hours INTEGER NOT NULL DEFAULT 24
    CHECK (block_duration_hours BETWEEN 1 AND 168);
ALTER TABLE runtime_settings
  ADD COLUMN response_budget INTEGER NOT NULL DEFAULT 100
    CHECK (response_budget BETWEEN 1 AND 10000);
ALTER TABLE runtime_settings
  ADD COLUMN alert_grouping_minutes INTEGER NOT NULL DEFAULT 5
    CHECK (alert_grouping_minutes BETWEEN 1 AND 60);
ALTER TABLE runtime_settings
  ADD COLUMN retention_days INTEGER NOT NULL DEFAULT 30
    CHECK (retention_days BETWEEN 1 AND 30);

CREATE TABLE IF NOT EXISTS allowlisted_sources (
  installation_id TEXT NOT NULL,
  source_ip TEXT NOT NULL,
  actor_email TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (installation_id, source_ip)
);

CREATE TABLE IF NOT EXISTS admin_audit (
  id TEXT PRIMARY KEY NOT NULL,
  installation_id TEXT NOT NULL,
  actor_email TEXT NOT NULL,
  actor_subject TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('manual_unblock')),
  source_ip TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('pending', 'completed', 'failed'))
);

CREATE INDEX IF NOT EXISTS admin_audit_installation_created_idx
  ON admin_audit (installation_id, created_at DESC);
