/**
 * localDb.ts
 * 
 * Main-thread RPC bridge to the SQLite WASM Web Worker.
 * All database calls go through this singleton — never touch the worker directly.
 * 
 * Usage:
 *   import { localDb } from './localDb';
 *   await localDb.ready;
 *   const rows = await localDb.query('SELECT * FROM stones WHERE item_id LIKE ?', ['%KD%']);
 */

type PendingTask = {
  resolve: (value: any) => void;
  reject: (reason: any) => void;
};

class LocalSqlite {
  private worker: Worker | null = null;
  private pending = new Map<string, PendingTask>();
  private _ready: Promise<void>;
  private _resolveReady!: () => void;
  private _rejectReady!: (err: Error) => void;
  private _persistent = false;
  private _initialized = false;

  constructor() {
    this._ready = new Promise<void>((resolve, reject) => {
      this._resolveReady = resolve;
      this._rejectReady = reject;
    });
  }

  /** Initialize the worker. Call once at app startup. */
  init(): void {
    if (this._initialized) return;
    this._initialized = true;

    try {
      this.worker = new Worker(
        new URL('./local-sqlite-worker.ts', import.meta.url),
        { type: 'module' }
      );

      this.worker.addEventListener('message', (event: MessageEvent) => {
        const data = event.data;

        // Handle ready/error signals from worker init
        if (data.type === 'ready') {
          this._persistent = data.persistent;
          this._resolveReady();
          return;
        }
        if (data.type === 'error') {
          console.error('[LocalDb] Worker init error:', data.error);
          this._rejectReady(new Error(data.error));
          return;
        }

        // Handle RPC responses
        const task = this.pending.get(data.id);
        if (!task) return;
        this.pending.delete(data.id);

        if (data.error) {
          task.reject(new Error(data.error));
        } else {
          task.resolve(data.result);
        }
      });

      this.worker.addEventListener('error', (err) => {
        console.error('[LocalDb] Worker error:', err);
      });
    } catch (err) {
      console.error('[LocalDb] Failed to create worker:', err);
      this._rejectReady(err as Error);
    }
  }

  /** Promise that resolves when the DB is ready. */
  get ready(): Promise<void> {
    return this._ready;
  }

  /** Whether the DB is persisted to disk (OPFS) or in-memory only. */
  get isPersistent(): boolean {
    return this._persistent;
  }

  /** Send a message to the worker and get a promise-based response. */
  private send(type: string, sql?: string, params?: any[]): Promise<any> {
    if (!this.worker) throw new Error('LocalDb worker not initialized. Call init() first.');
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker!.postMessage({ id, type, sql, params });
    });
  }

  // ── High-Level API ───────────────────────────────────────────

  /** Execute SQL that modifies data (INSERT, UPDATE, DELETE). Returns change count. */
  async exec(sql: string, params: any[] = []): Promise<{ changes: number; ok: boolean }> {
    await this._ready;
    return this.send('exec', sql, params);
  }

  /** Query rows. Returns array of objects. */
  async query<T = Record<string, any>>(sql: string, params: any[] = []): Promise<T[]> {
    await this._ready;
    const result = await this.send('query', sql, params);
    return result.rows as T[];
  }

  /** Get single row. Returns object or null. */
  async get<T = Record<string, any>>(sql: string, params: any[] = []): Promise<T | null> {
    await this._ready;
    const result = await this.send('get', sql, params);
    return (result.row as T) || null;
  }

  /** Get DB info (persistence status). */
  async getInfo(): Promise<{ persistent: boolean; ok: boolean }> {
    await this._ready;
    return this.send('info');
  }

  // ── Convenience Methods ──────────────────────────────────────

  private normalizeItem<T>(item: any): T {
    if (!item || typeof item !== 'object') return item;
    return {
      ...item,
      is_low_stock: Boolean(item.is_low_stock || (item.low_stock_threshold !== undefined && item.quantity <= item.low_stock_threshold)),
      is_deleted: Boolean(item.is_deleted),
    } as T;
  }

  /** Get all active items from an inventory table. */
  async getAllItems<T>(table: string, search?: string): Promise<T[]> {
    const validTables = ['plated_jewelry', 'raw_jewelry', 'stones', 'foil'];
    if (!validTables.includes(table)) throw new Error(`Invalid table: ${table}`);

    let rows: any[];
    if (search && search.trim()) {
      rows = await this.query<T>(
        `SELECT * FROM ${table} WHERE is_deleted = 0 AND item_id LIKE ? ORDER BY item_id ASC`,
        [`%${search.trim()}%`]
      );
    } else {
      rows = await this.query<T>(
        `SELECT * FROM ${table} WHERE is_deleted = 0 ORDER BY item_id ASC`
      );
    }
    return rows.map((r) => this.normalizeItem<T>(r));
  }

  /** Get paginated items from an inventory table. */
  async getItemsPaginated<T>(
    table: string,
    page: number,
    limit: number,
    search?: string
  ): Promise<{ items: T[]; total: number; page: number; limit: number; totalPages: number }> {
    const validTables = ['plated_jewelry', 'raw_jewelry', 'stones', 'foil'];
    if (!validTables.includes(table)) throw new Error(`Invalid table: ${table}`);

    const offset = (page - 1) * limit;

    let countRow: any;
    let rows: any[];

    if (search && search.trim()) {
      countRow = await this.get(
        `SELECT COUNT(*) as total FROM ${table} WHERE is_deleted = 0 AND item_id LIKE ?`,
        [`%${search.trim()}%`]
      );
      rows = await this.query<T>(
        `SELECT * FROM ${table} WHERE is_deleted = 0 AND item_id LIKE ? ORDER BY item_id ASC LIMIT ? OFFSET ?`,
        [`%${search.trim()}%`, limit, offset]
      );
    } else {
      countRow = await this.get(
        `SELECT COUNT(*) as total FROM ${table} WHERE is_deleted = 0`
      );
      rows = await this.query<T>(
        `SELECT * FROM ${table} WHERE is_deleted = 0 ORDER BY item_id ASC LIMIT ? OFFSET ?`,
        [limit, offset]
      );
    }

    const items = rows.map((r) => this.normalizeItem<T>(r));
    const total = countRow?.total ?? 0;
    return {
      items,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit) || 1,
    };
  }

  /** Upsert a single item (INSERT OR REPLACE). */
  async upsertItem(table: string, item: Record<string, any>): Promise<void> {
    const validTables = ['plated_jewelry', 'raw_jewelry', 'stones', 'foil', 'transactions', 'pending_ops', 'sync_state'];
    if (!validTables.includes(table)) throw new Error(`Invalid table: ${table}`);

    const keys = Object.keys(item);
    const placeholders = keys.map(() => '?').join(', ');
    const values = keys.map((k) => item[k]);
    const sql = `INSERT OR REPLACE INTO ${table} (${keys.join(', ')}) VALUES (${placeholders})`;
    await this.exec(sql, values);
  }

  /** Bulk upsert items (for bootstrap sync). */
  async bulkUpsert(table: string, items: Record<string, any>[]): Promise<void> {
    if (items.length === 0) return;
    const validTables = ['plated_jewelry', 'raw_jewelry', 'stones', 'foil', 'transactions'];
    if (!validTables.includes(table)) throw new Error(`Invalid table: ${table}`);

    // Use a transaction for performance
    await this.exec('BEGIN TRANSACTION');
    try {
      for (const item of items) {
        const keys = Object.keys(item);
        const placeholders = keys.map(() => '?').join(', ');
        const values = keys.map((k) => item[k]);
        await this.exec(
          `INSERT OR REPLACE INTO ${table} (${keys.join(', ')}) VALUES (${placeholders})`,
          values
        );
      }
      await this.exec('COMMIT');
    } catch (err) {
      await this.exec('ROLLBACK');
      throw err;
    }
  }

  /** Delete an item by ID. */
  async deleteItem(table: string, id: string): Promise<void> {
    const validTables = ['plated_jewelry', 'raw_jewelry', 'stones', 'foil', 'transactions', 'pending_ops'];
    if (!validTables.includes(table)) throw new Error(`Invalid table: ${table}`);
    await this.exec(`DELETE FROM ${table} WHERE id = ?`, [id]);
  }

  /** Clear all data from a table. */
  async clearTable(table: string): Promise<void> {
    const validTables = ['plated_jewelry', 'raw_jewelry', 'stones', 'foil', 'transactions', 'pending_ops', 'sync_state'];
    if (!validTables.includes(table)) throw new Error(`Invalid table: ${table}`);
    await this.exec(`DELETE FROM ${table}`);
  }

  /** Get count of items in a table. */
  async count(table: string, where?: string, params?: any[]): Promise<number> {
    const sql = where
      ? `SELECT COUNT(*) as total FROM ${table} WHERE ${where}`
      : `SELECT COUNT(*) as total FROM ${table}`;
    const row = await this.get<{ total: number }>(sql, params);
    return row?.total ?? 0;
  }

  /** Get valuation sum for a table that has cost_price_cents. */
  async getValuation(table: string): Promise<number> {
    const validTables = ['plated_jewelry', 'stones', 'foil'];
    if (!validTables.includes(table)) throw new Error(`Invalid table for valuation: ${table}`);
    const row = await this.get<{ total_paisa: number }>(
      `SELECT COALESCE(SUM(cost_price_cents * quantity), 0) as total_paisa FROM ${table} WHERE is_deleted = 0`
    );
    return (row?.total_paisa ?? 0) / 100;
  }

  /** Get low stock items across all categories. */
  async getLowStockItems(): Promise<any[]> {
    const categories = [
      { table: 'plated_jewelry', name: 'Plated Jewelry', hasCost: true },
      { table: 'raw_jewelry', name: 'Raw Jewelry', hasCost: false },
      { table: 'stones', name: 'Stones', hasCost: true },
      { table: 'foil', name: 'Foil', hasCost: true },
    ];

    const allLowStock: any[] = [];
    for (const cat of categories) {
      const items = await this.query(
        `SELECT * FROM ${cat.table} WHERE is_deleted = 0 AND quantity < low_stock_threshold ORDER BY (low_stock_threshold - quantity) DESC`
      );
      for (const item of items) {
        allLowStock.push({
          ...item,
          category: cat.table,
          category_name: cat.name,
          is_low_stock: true,
          ...(cat.hasCost ? { cost_price: (item as any).cost_price_cents / 100 } : {}),
        });
      }
    }
    return allLowStock;
  }

  /** Get/set sync state values. */
  async getSyncState(key: string): Promise<string | null> {
    const row = await this.get<{ value: string }>('SELECT value FROM sync_state WHERE key = ?', [key]);
    return row?.value ?? null;
  }

  async setSyncState(key: string, value: string): Promise<void> {
    await this.exec('INSERT OR REPLACE INTO sync_state (key, value) VALUES (?, ?)', [key, value]);
  }

  /** Clear all local data (for logout or force re-sync). */
  async clearAll(): Promise<void> {
    for (const table of ['plated_jewelry', 'raw_jewelry', 'stones', 'foil', 'transactions', 'pending_ops', 'sync_state']) {
      await this.exec(`DELETE FROM ${table}`);
    }
  }
}

// Singleton export
export const localDb = new LocalSqlite();
