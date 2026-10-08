-- Poonam Creation Inventory Management System
-- D1 Schema Migration v1
-- ============================================

-- Users table: owner + staff
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  email TEXT,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'staff')),
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Sessions table: stores ONLY hashed tokens, never raw tokens
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  token_hash TEXT UNIQUE NOT NULL,
  expires_at TEXT NOT NULL,
  is_revoked INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_sessions_token_hash ON sessions(token_hash);
CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);

-- Plated Jewelry: has images, cost price, owner-selectable unit
-- quantity, unit, low_stock_threshold, cost_price_cents are all NOT NULL with no defaults
-- the application must explicitly supply every value
CREATE TABLE IF NOT EXISTS plated_jewelry (
  id TEXT PRIMARY KEY,
  item_id TEXT UNIQUE NOT NULL,
  quantity REAL NOT NULL CHECK (quantity >= 0),
  unit TEXT NOT NULL CHECK (unit IN ('PC', 'KGS', 'SET', 'JODI')),
  low_stock_threshold REAL NOT NULL CHECK (low_stock_threshold >= 0),
  cost_price_cents INTEGER NOT NULL CHECK (cost_price_cents >= 0),
  image_key TEXT,
  thumb_key TEXT,
  is_deleted INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_plated_jewelry_item_id ON plated_jewelry(item_id);
CREATE INDEX IF NOT EXISTS idx_plated_jewelry_item_id_search ON plated_jewelry(item_id COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_plated_jewelry_low_stock ON plated_jewelry(quantity, low_stock_threshold) WHERE is_deleted = 0;

-- Raw Jewelry: no images, no cost price, owner-selectable unit
CREATE TABLE IF NOT EXISTS raw_jewelry (
  id TEXT PRIMARY KEY,
  item_id TEXT UNIQUE NOT NULL,
  quantity REAL NOT NULL CHECK (quantity >= 0),
  unit TEXT NOT NULL CHECK (unit IN ('PC', 'KGS', 'SET', 'JODI')),
  low_stock_threshold REAL NOT NULL CHECK (low_stock_threshold >= 0),
  is_deleted INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_raw_jewelry_item_id ON raw_jewelry(item_id);
CREATE INDEX IF NOT EXISTS idx_raw_jewelry_item_id_search ON raw_jewelry(item_id COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_raw_jewelry_low_stock ON raw_jewelry(quantity, low_stock_threshold) WHERE is_deleted = 0;

-- Stones: fixed unit PC, has cost price
CREATE TABLE IF NOT EXISTS stones (
  id TEXT PRIMARY KEY,
  item_id TEXT UNIQUE NOT NULL,
  quantity REAL NOT NULL CHECK (quantity >= 0),
  unit TEXT NOT NULL DEFAULT 'PC' CHECK (unit = 'PC'),
  low_stock_threshold REAL NOT NULL CHECK (low_stock_threshold >= 0),
  cost_price_cents INTEGER NOT NULL CHECK (cost_price_cents >= 0),
  is_deleted INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_stones_item_id ON stones(item_id);
CREATE INDEX IF NOT EXISTS idx_stones_item_id_search ON stones(item_id COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_stones_low_stock ON stones(quantity, low_stock_threshold) WHERE is_deleted = 0;

-- Foil: fixed unit KGS, has cost price
CREATE TABLE IF NOT EXISTS foil (
  id TEXT PRIMARY KEY,
  item_id TEXT UNIQUE NOT NULL,
  quantity REAL NOT NULL CHECK (quantity >= 0),
  unit TEXT NOT NULL DEFAULT 'KGS' CHECK (unit = 'KGS'),
  low_stock_threshold REAL NOT NULL CHECK (low_stock_threshold >= 0),
  cost_price_cents INTEGER NOT NULL CHECK (cost_price_cents >= 0),
  is_deleted INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_foil_item_id ON foil(item_id);
CREATE INDEX IF NOT EXISTS idx_foil_item_id_search ON foil(item_id COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_foil_low_stock ON foil(quantity, low_stock_threshold) WHERE is_deleted = 0;

-- Transaction History: immutable audit trail
-- item_display_id preserves the human-readable ID at time of transaction
-- even if the master record is later deleted/edited
CREATE TABLE IF NOT EXISTS transactions (
  id TEXT PRIMARY KEY,
  category TEXT NOT NULL CHECK (category IN ('plated_jewelry', 'raw_jewelry', 'stones', 'foil')),
  item_id TEXT NOT NULL,
  item_display_id TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('add', 'subtract')),
  quantity_before REAL NOT NULL,
  quantity_change REAL NOT NULL CHECK (quantity_change > 0),
  quantity_after REAL NOT NULL CHECK (quantity_after >= 0),
  unit TEXT NOT NULL,
  performed_by TEXT NOT NULL,
  performer_name TEXT NOT NULL,
  idempotency_key TEXT UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_transactions_category ON transactions(category);
CREATE INDEX IF NOT EXISTS idx_transactions_created_at ON transactions(created_at);
CREATE INDEX IF NOT EXISTS idx_transactions_item_id ON transactions(item_id);
CREATE INDEX IF NOT EXISTS idx_transactions_category_date ON transactions(category, created_at);
