-- Poonam Creation: Sync Infrastructure Migration
-- ================================================
-- Adds Change Data Capture (CDC) table for incremental sync.
-- Every mutation (create/update/delete) logs a change here.
-- Clients pull changes incrementally via sequence number.

CREATE TABLE IF NOT EXISTS sync_changes (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('CREATE','UPDATE','DELETE')),
  payload TEXT NOT NULL DEFAULT '{}',
  changed_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_sync_changes_seq ON sync_changes(seq);
CREATE INDEX IF NOT EXISTS idx_sync_changes_entity ON sync_changes(entity_type, entity_id);
