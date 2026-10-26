/**
 * local-sqlite-worker.ts
 * 
 * Dedicated Web Worker that runs SQLite WASM inside OPFS.
 * All database operations happen here — never on the main UI thread.
 * 
 * Initialization fallback chain:
 *   1. OPFS SAH Pool VFS (best performance, Chrome/Edge)
 *   2. Standard OpfsDb (broader support)
 *   3. In-Memory fallback (private browsing / restricted environments)
 */

import sqlite3InitModule from '@sqlite.org/sqlite-wasm';

let db: any = null;
let persistent = false;
let ready: Promise<void>;

// ── Schema Definition ──────────────────────────────────────────
const SCHEMA_SQL = `
-- Inventory tables: store API-format data (cost_price in rupees, is_low_stock computed)
CREATE TABLE IF NOT EXISTS plated_jewelry (
  id TEXT PRIMARY KEY,
  item_id TEXT UNIQUE NOT NULL,
  quantity REAL NOT NULL DEFAULT 0,
  unit TEXT NOT NULL DEFAULT 'PC',
  low_stock_threshold REAL NOT NULL DEFAULT 0,
  cost_price_cents INTEGER NOT NULL DEFAULT 0,
  cost_price REAL DEFAULT 0,
  is_low_stock INTEGER DEFAULT 0,
  image_key TEXT,
  thumb_key TEXT,
  is_deleted INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_local_plated_item_id ON plated_jewelry(item_id COLLATE NOCASE);

CREATE TABLE IF NOT EXISTS raw_jewelry (
  id TEXT PRIMARY KEY,
  item_id TEXT UNIQUE NOT NULL,
  quantity REAL NOT NULL DEFAULT 0,
  unit TEXT NOT NULL DEFAULT 'PC',
  low_stock_threshold REAL NOT NULL DEFAULT 0,
  is_low_stock INTEGER DEFAULT 0,
  is_deleted INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_local_raw_item_id ON raw_jewelry(item_id COLLATE NOCASE);

CREATE TABLE IF NOT EXISTS stones (
  id TEXT PRIMARY KEY,
  item_id TEXT UNIQUE NOT NULL,
  quantity REAL NOT NULL DEFAULT 0,
  unit TEXT NOT NULL DEFAULT 'PC',
  low_stock_threshold REAL NOT NULL DEFAULT 0,
  cost_price_cents INTEGER NOT NULL DEFAULT 0,
  cost_price REAL DEFAULT 0,
  is_low_stock INTEGER DEFAULT 0,
  is_deleted INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_local_stones_item_id ON stones(item_id COLLATE NOCASE);

CREATE TABLE IF NOT EXISTS foil (
  id TEXT PRIMARY KEY,
  item_id TEXT UNIQUE NOT NULL,
  quantity REAL NOT NULL DEFAULT 0,
  unit TEXT NOT NULL DEFAULT 'KGS',
  low_stock_threshold REAL NOT NULL DEFAULT 0,
  cost_price_cents INTEGER NOT NULL DEFAULT 0,
  cost_price REAL DEFAULT 0,
  is_low_stock INTEGER DEFAULT 0,
  is_deleted INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_local_foil_item_id ON foil(item_id COLLATE NOCASE);

CREATE TABLE IF NOT EXISTS transactions (
  id TEXT PRIMARY KEY,
  category TEXT NOT NULL,
  item_id TEXT NOT NULL,
  item_display_id TEXT NOT NULL DEFAULT '',
  operation TEXT NOT NULL,
  quantity_before REAL NOT NULL DEFAULT 0,
  quantity_change REAL NOT NULL DEFAULT 0,
  quantity_after REAL NOT NULL DEFAULT 0,
  unit TEXT NOT NULL DEFAULT '',
  performed_by TEXT NOT NULL DEFAULT '',
  performer_name TEXT NOT NULL DEFAULT '',
  idempotency_key TEXT,
  created_at TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_local_tx_category ON transactions(category);
CREATE INDEX IF NOT EXISTS idx_local_tx_created_at ON transactions(created_at);
CREATE INDEX IF NOT EXISTS idx_local_tx_item_id ON transactions(item_id);

-- Pending operations queue (offline mutations waiting to sync)
CREATE TABLE IF NOT EXISTS pending_ops (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT UNIQUE NOT NULL,
  entity_type TEXT NOT NULL,
  operation TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  method TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING',
  error_message TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT '',
  synced_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_local_pending_status ON pending_ops(status, created_at);

-- Sync state tracking
CREATE TABLE IF NOT EXISTS sync_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Costing System Tables (Strictly Private & Local-Only, Never Cloud-Synced)
CREATE TABLE IF NOT EXISTS costing_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS costing_categories (
  id TEXT PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_system INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_costing_categories_order ON costing_categories(sort_order, name);

CREATE TABLE IF NOT EXISTS costing_materials (
  id TEXT PRIMARY KEY,
  category_id TEXT NOT NULL,
  name TEXT NOT NULL,
  weight REAL DEFAULT NULL,
  cost_price REAL DEFAULT NULL,
  is_deleted INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_costing_materials_cat ON costing_materials(category_id, is_deleted);
CREATE INDEX IF NOT EXISTS idx_costing_materials_name ON costing_materials(name COLLATE NOCASE);

CREATE TABLE IF NOT EXISTS jewelry_costing (
  id TEXT PRIMARY KEY,
  plated_jewelry_id TEXT UNIQUE NOT NULL,
  weight REAL NOT NULL DEFAULT 0,
  cached_total_cost REAL NOT NULL DEFAULT 0,
  is_complete INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_jewelry_costing_item ON jewelry_costing(plated_jewelry_id);

CREATE TABLE IF NOT EXISTS jewelry_costing_materials (
  id TEXT PRIMARY KEY,
  jewelry_costing_id TEXT NOT NULL,
  category_id TEXT NOT NULL,
  material_id TEXT NOT NULL,
  material_name TEXT NOT NULL,
  quantity INTEGER NOT NULL DEFAULT 1,
  unit_cost REAL DEFAULT NULL,
  extended_cost REAL DEFAULT NULL,
  weight REAL DEFAULT NULL,
  created_at TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_jcm_costing_id ON jewelry_costing_materials(jewelry_costing_id);
CREATE INDEX IF NOT EXISTS idx_jcm_material_id ON jewelry_costing_materials(material_id);
`;

// ── Initialization ─────────────────────────────────────────────
ready = (async () => {
  try {
    const sqlite3 = await (sqlite3InitModule as any)({
      print: (...args: any[]) => console.log('[SQLite]', ...args),
      printErr: (...args: any[]) => console.error('[SQLite]', ...args),
    });

    // Attempt 1: OPFS SAH Pool VFS (best performance)
    if (typeof sqlite3.installOpfsSAHPoolVfs === 'function' && 'storage' in navigator) {
      try {
        const poolUtil = await sqlite3.installOpfsSAHPoolVfs({
          name: 'poonam-pool',
          initialCapacity: 6,
        });
        db = new poolUtil.OpfsSAHPoolDb('/poonam-creation.sqlite3');
        persistent = true;
        console.log('[SQLite Worker] Initialized with OPFS SAH Pool VFS');
      } catch (e) {
        console.warn('[SQLite Worker] SAH Pool failed, trying OpfsDb:', e);
      }
    }

    // Attempt 2: Standard OpfsDb
    if (!db && sqlite3.oo1?.OpfsDb && 'storage' in navigator) {
      try {
        db = new sqlite3.oo1.OpfsDb('/poonam-creation-data.sqlite3');
        persistent = true;
        console.log('[SQLite Worker] Initialized with standard OpfsDb');
      } catch (e) {
        console.warn('[SQLite Worker] OpfsDb failed, falling back to memory:', e);
      }
    }

    // Attempt 3: In-Memory fallback
    if (!db) {
      db = new sqlite3.oo1.DB(':memory:', 'ct');
      persistent = false;
      console.log('[SQLite Worker] Initialized with in-memory DB (non-persistent)');
    }

    // Run schema creation
    db.exec(SCHEMA_SQL);

    // Run safe migrations for existing databases created before new columns were introduced
    const columnMigrations = [
      'ALTER TABLE plated_jewelry ADD COLUMN cost_price REAL DEFAULT 0',
      'ALTER TABLE plated_jewelry ADD COLUMN is_low_stock INTEGER DEFAULT 0',
      'ALTER TABLE raw_jewelry ADD COLUMN is_low_stock INTEGER DEFAULT 0',
      'ALTER TABLE stones ADD COLUMN cost_price REAL DEFAULT 0',
      'ALTER TABLE stones ADD COLUMN is_low_stock INTEGER DEFAULT 0',
      'ALTER TABLE foil ADD COLUMN cost_price REAL DEFAULT 0',
      'ALTER TABLE foil ADD COLUMN is_low_stock INTEGER DEFAULT 0',
    ];
    for (const sql of columnMigrations) {
      try {
        db.exec(sql);
      } catch {
        // Column already exists, safe to ignore
      }
    }

    // Seed default settings and initial categories if not present
    try {
      db.exec(`
        INSERT OR IGNORE INTO costing_settings (key, value, updated_at)
        VALUES ('multiplier_x', '18.00', datetime('now'));

        INSERT OR IGNORE INTO costing_categories (id, name, sort_order, is_system, created_at, updated_at)
        VALUES 
          ('ad_stone', 'AD Stone', 1, 1, datetime('now'), datetime('now')),
          ('kundan_stone', 'Kundan Stone', 2, 1, datetime('now'), datetime('now')),
          ('mop', 'MOP', 3, 1, datetime('now'), datetime('now')),
          ('hepoxy', 'Hepoxy', 4, 1, datetime('now'), datetime('now'));
      `);
    } catch (seedErr) {
      console.warn('[SQLite Worker] Costing seed warning:', seedErr);
    }

    // Deduplicate existing duplicate costing_materials (retaining the most recently updated record)
    try {
      db.exec(`
        DELETE FROM costing_materials
        WHERE id NOT IN (
          SELECT id FROM (
            SELECT id, ROW_NUMBER() OVER (
              PARTITION BY category_id, LOWER(name) 
              ORDER BY updated_at DESC, created_at DESC
            ) as rn
            FROM costing_materials
            WHERE is_deleted = 0
          ) WHERE rn = 1
        ) AND is_deleted = 0;
      `);
      db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_costing_materials_unique 
        ON costing_materials(category_id, name COLLATE NOCASE) 
        WHERE is_deleted = 0;
      `);
    } catch (uniqueMigErr) {
      console.warn('[SQLite Worker] Costing unique migration warning:', uniqueMigErr);
    }

    console.log('[SQLite Worker] Schema & migrations initialized');
  } catch (err) {
    console.error('[SQLite Worker] Fatal init error:', err);
    throw err;
  }
})();

// ── Message Handler ────────────────────────────────────────────

interface WorkerMessage {
  id: string;
  type: 'exec' | 'query' | 'run' | 'get' | 'getAll' | 'info';
  sql?: string;
  params?: any[];
}

self.addEventListener('message', async (event: MessageEvent<WorkerMessage>) => {
  const { id, type, sql, params } = event.data;

  try {
    await ready;

    let result: any = null;

    switch (type) {
      case 'exec': {
        // Execute SQL that doesn't return rows (CREATE, INSERT, UPDATE, DELETE)
        db.exec({
          sql: sql!,
          bind: params || [],
        });
        result = { changes: db.changes(), ok: true };
        break;
      }

      case 'run': {
        // Execute SQL and return changes count
        db.exec({
          sql: sql!,
          bind: params || [],
        });
        result = { changes: db.changes(), ok: true };
        break;
      }

      case 'query': {
        // Execute SQL and return all matching rows as objects
        const rows: any[] = [];
        db.exec({
          sql: sql!,
          bind: params || [],
          rowMode: 'object',
          callback: (row: any) => {
            rows.push({ ...row });
          },
        });
        result = { rows };
        break;
      }

      case 'get': {
        // Execute SQL and return first row or null
        let firstRow: any = null;
        db.exec({
          sql: sql!,
          bind: params || [],
          rowMode: 'object',
          callback: (row: any) => {
            if (!firstRow) firstRow = { ...row };
          },
        });
        result = { row: firstRow };
        break;
      }

      case 'getAll': {
        // Get all rows from a table with optional search
        const rows: any[] = [];
        db.exec({
          sql: sql!,
          bind: params || [],
          rowMode: 'object',
          callback: (row: any) => {
            rows.push({ ...row });
          },
        });
        result = { rows };
        break;
      }

      case 'info': {
        result = { persistent, ok: true };
        break;
      }

      default:
        throw new Error(`Unknown message type: ${type}`);
    }

    self.postMessage({ id, result });
  } catch (error: any) {
    self.postMessage({ id, error: error.message || String(error) });
  }
});

// Signal ready
ready.then(() => {
  self.postMessage({ type: 'ready', persistent });
}).catch((err) => {
  self.postMessage({ type: 'error', error: err.message || String(err) });
});
