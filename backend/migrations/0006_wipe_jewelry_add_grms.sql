-- Poonam Creation: wipe test data in Plated + Raw Jewelry and allow the GRMS unit
-- ============================================================================
-- Agreed 2026-11-18: all Plated/Raw Jewelry data so far was scanner-test data and is wiped.
-- SQLite cannot change a CHECK constraint in place, so both tables are dropped and recreated
-- with unit IN ('PC','KGS','SET','JODI','GRMS'). Stones, Foil, Costing, users and sessions are untouched.
--
-- Phones keep an offline copy of the inventory. Before anything is removed, a DELETE change is logged
-- for every wiped row, so every phone removes its copy on its next normal sync (old app versions too).
--
-- Run ONCE (wrangler d1 execute ... --file). Photos in R2 and scan fingerprints in Vectorize are
-- removed separately (see the deploy notes); this file only touches D1.
-- Safe on a brand-new database too (tables are empty there).

-- 1. Tell every phone to drop its offline copies
INSERT INTO sync_changes (entity_type, entity_id, operation, payload)
  SELECT 'plated_jewelry', id, 'DELETE', '{}' FROM plated_jewelry;
INSERT INTO sync_changes (entity_type, entity_id, operation, payload)
  SELECT 'raw_jewelry', id, 'DELETE', '{}' FROM raw_jewelry;
INSERT INTO sync_changes (entity_type, entity_id, operation, payload)
  SELECT 'transactions', id, 'DELETE', '{}' FROM transactions WHERE category IN ('plated_jewelry', 'raw_jewelry');

-- 2. Stock history and DINO learn-state of the wiped items
DELETE FROM transactions WHERE category IN ('plated_jewelry', 'raw_jewelry');
DELETE FROM dino_embeddings;

-- 3. Recreate both tables with the GRMS unit (same columns, defaults and indexes as before)
DROP TABLE IF EXISTS plated_jewelry;
DROP TABLE IF EXISTS raw_jewelry;

CREATE TABLE plated_jewelry (
  id TEXT PRIMARY KEY,
  item_id TEXT UNIQUE NOT NULL,
  quantity REAL NOT NULL CHECK (quantity >= 0),
  unit TEXT NOT NULL CHECK (unit IN ('PC', 'KGS', 'SET', 'JODI', 'GRMS')),
  low_stock_threshold REAL NOT NULL CHECK (low_stock_threshold >= 0),
  cost_price_cents INTEGER NOT NULL CHECK (cost_price_cents >= 0),
  image_key TEXT,
  thumb_key TEXT,
  is_deleted INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  embedding_generated_at TEXT DEFAULT NULL
);

CREATE INDEX IF NOT EXISTS idx_plated_jewelry_item_id ON plated_jewelry(item_id);
CREATE INDEX IF NOT EXISTS idx_plated_jewelry_item_id_search ON plated_jewelry(item_id COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_plated_jewelry_low_stock ON plated_jewelry(quantity, low_stock_threshold) WHERE is_deleted = 0;
CREATE INDEX IF NOT EXISTS idx_plated_jewelry_embedding
  ON plated_jewelry(embedding_generated_at)
  WHERE is_deleted = 0 AND image_key IS NOT NULL;

CREATE TABLE raw_jewelry (
  id TEXT PRIMARY KEY,
  item_id TEXT UNIQUE NOT NULL,
  quantity REAL NOT NULL CHECK (quantity >= 0),
  unit TEXT NOT NULL CHECK (unit IN ('PC', 'KGS', 'SET', 'JODI', 'GRMS')),
  low_stock_threshold REAL NOT NULL CHECK (low_stock_threshold >= 0),
  is_deleted INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_raw_jewelry_item_id ON raw_jewelry(item_id);
CREATE INDEX IF NOT EXISTS idx_raw_jewelry_item_id_search ON raw_jewelry(item_id COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_raw_jewelry_low_stock ON raw_jewelry(quantity, low_stock_threshold) WHERE is_deleted = 0;
