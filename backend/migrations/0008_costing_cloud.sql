-- Costing in the cloud (owner only), agreed 2026-11-19.
-- The device keeps its own copy (works offline) and uploads/downloads changes via /api/costing.
-- Only what the owner TYPES is stored here: multiplier X, categories (incl. ones the owner adds), raw materials with
-- their prices, and each design's material lines. Totals are never stored: every device recomputes them from the
-- current prices, so a price change is 1 row written instead of thousands (D1 free plan: 100,000 rows written/day,
-- shared with stock operations).
-- Every row: updated_at (time of the edit, newest wins), deleted (tombstone, so deletions reach other devices),
-- rev (server change number for "what changed since"). Never written to sync_changes (staff phones read that log).

CREATE TABLE IF NOT EXISTS costing_seq (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS costing_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0,
  rev INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_costing_settings_rev ON costing_settings(rev);

CREATE TABLE IF NOT EXISTS costing_categories (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_system INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0,
  rev INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_costing_categories_rev ON costing_categories(rev);

CREATE TABLE IF NOT EXISTS costing_materials (
  id TEXT PRIMARY KEY,
  category_id TEXT NOT NULL,
  name TEXT NOT NULL,
  weight REAL,
  cost_price REAL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0,
  rev INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_costing_materials_rev ON costing_materials(rev);

CREATE TABLE IF NOT EXISTS costing_jewelry (
  id TEXT PRIMARY KEY,
  plated_jewelry_id TEXT NOT NULL,
  weight REAL NOT NULL DEFAULT 0,
  lines_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0,
  rev INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_costing_jewelry_rev ON costing_jewelry(rev);
