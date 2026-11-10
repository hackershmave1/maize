CREATE TABLE IF NOT EXISTS containment_sources (
  installation_id TEXT NOT NULL,
  source_ip TEXT NOT NULL,
  confirmed_at INTEGER NOT NULL,
  retain_until INTEGER NOT NULL,
  PRIMARY KEY (installation_id, source_ip)
);

CREATE INDEX IF NOT EXISTS containment_sources_expiry_idx
  ON containment_sources (installation_id, retain_until, source_ip);
