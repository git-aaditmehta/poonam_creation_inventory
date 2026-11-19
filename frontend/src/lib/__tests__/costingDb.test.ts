import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { localDb } from '../localDb';
import {
  getCostingMultiplierX,
  setCostingMultiplierX,
  getCostingCategories,
  createCostingCategory,
  updateCostingCategory,
  canDeleteCostingCategory,
  deleteCostingCategory,
  getCostingMaterialsByCategory,
  addCostingMaterial,
  upsertCostingMaterial,
  updateCostingMaterial,
  canDeleteCostingMaterial,
  deleteCostingMaterial,
  propagateMaterialCostPrice,
  saveJewelryCosting,
  getAllJewelryCostings,
  getJewelryCostingById,
  deleteJewelryCosting,
  recalculateAllJewelryWithX,
} from '../costingDb';

describe('costingDb - Local Database Access Layer', () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = new DatabaseSync(':memory:');

    // Create full schema
    db.exec(`
      CREATE TABLE plated_jewelry (
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

      CREATE TABLE stones (
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

      CREATE TABLE costing_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT ''
      );

      CREATE TABLE costing_categories (
        id TEXT PRIMARY KEY,
        name TEXT UNIQUE NOT NULL,
        sort_order INTEGER NOT NULL DEFAULT 0,
        is_system INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL DEFAULT ''
      );

      CREATE TABLE costing_materials (
        id TEXT PRIMARY KEY,
        category_id TEXT NOT NULL,
        name TEXT NOT NULL,
        weight REAL DEFAULT NULL,
        cost_price REAL DEFAULT NULL,
        is_deleted INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL DEFAULT ''
      );

      CREATE TABLE jewelry_costing (
        id TEXT PRIMARY KEY,
        plated_jewelry_id TEXT UNIQUE NOT NULL,
        weight REAL NOT NULL DEFAULT 0,
        cached_total_cost REAL NOT NULL DEFAULT 0,
        is_complete INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL DEFAULT ''
      );

      CREATE TABLE jewelry_costing_materials (
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

      -- Cloud upload queue (same as lib/local-sqlite-worker.ts)
      CREATE TABLE costing_dirty (
        entity TEXT NOT NULL,
        id TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (entity, id)
      );

      -- Default seeds
      INSERT INTO costing_settings (key, value, updated_at) VALUES ('multiplier_x', '18.00', '2026-10-25T00:00:00Z');
      INSERT INTO costing_categories (id, name, sort_order, is_system, created_at, updated_at) VALUES
        ('ad_stone', 'AD Stone', 1, 1, '2026-10-25T00:00:00Z', '2026-10-25T00:00:00Z'),
        ('kundan_stone', 'Kundan Stone', 2, 1, '2026-10-25T00:00:00Z', '2026-10-25T00:00:00Z'),
        ('mop', 'MOP', 3, 1, '2026-10-25T00:00:00Z', '2026-10-25T00:00:00Z'),
        ('hepoxy', 'Hepoxy', 4, 1, '2026-10-25T00:00:00Z', '2026-10-25T00:00:00Z');

      -- Seed sample inventory items
      INSERT INTO plated_jewelry (id, item_id) VALUES ('pj_1', 'RING-001'), ('pj_2', 'NECK-002');
      INSERT INTO stones (id, item_id, cost_price, cost_price_cents) VALUES ('stone_1', 'KUNDAN-A', 4.00, 400);
    `);

    // Mock localDb methods
    vi.spyOn(localDb, 'ready', 'get').mockReturnValue(Promise.resolve());
    vi.spyOn(localDb, 'query').mockImplementation(async (sql: string, params: any[] = []) => {
      const stmt = db.prepare(sql);
      return stmt.all(...params) as any[];
    });
    vi.spyOn(localDb, 'get').mockImplementation(async (sql: string, params: any[] = []) => {
      const stmt = db.prepare(sql);
      const row = stmt.get(...params);
      return (row || null) as any;
    });
    vi.spyOn(localDb, 'exec').mockImplementation(async (sql: string, params: any[] = []) => {
      const stmt = db.prepare(sql);
      const res = stmt.run(...params);
      return { changes: Number(res.changes), ok: true };
    });
  });

  describe('Multiplier X', () => {
    it('retrieves default X (18.00) and updates it', async () => {
      const initialX = await getCostingMultiplierX();
      expect(initialX).toBe(18.00);

      await setCostingMultiplierX(19.50);
      const updatedX = await getCostingMultiplierX();
      expect(updatedX).toBe(19.50);
    });
  });

  describe('Category Management', () => {
    it('retrieves default 4 categories with stats', async () => {
      const cats = await getCostingCategories();
      expect(cats.length).toBe(4);
      expect(cats.map(c => c.name)).toEqual(['AD Stone', 'Kundan Stone', 'MOP', 'Hepoxy']);
      // Kundan Stone should count inventory stones
      const kundan = cats.find(c => c.id === 'kundan_stone');
      expect(kundan?.material_count).toBe(1);
    });

    it('creates a custom category and prevents duplicate names case-insensitively', async () => {
      const cat = await createCostingCategory('Beads');
      expect(cat.name).toBe('Beads');

      await expect(createCostingCategory('beads')).rejects.toThrow('already exists');
    });

    it('prevents deletion of system categories', async () => {
      const check = await canDeleteCostingCategory('ad_stone');
      expect(check.canDelete).toBe(false);
      await expect(deleteCostingCategory('ad_stone')).rejects.toThrow('Default category');
    });

    it('prevents deletion of category containing materials', async () => {
      const custom = await createCostingCategory('Enamel');
      await addCostingMaterial({ category_id: custom.id, name: 'Red Enamel', cost_price: 15.0 });

      const check = await canDeleteCostingCategory(custom.id);
      expect(check.canDelete).toBe(false);
      expect(check.reason).toContain('contains 1 material');
      await expect(deleteCostingCategory(custom.id)).rejects.toThrow('contains 1 material');
    });

    it('allows deleting empty custom category', async () => {
      const custom = await createCostingCategory('Temporary');
      const check = await canDeleteCostingCategory(custom.id);
      expect(check.canDelete).toBe(true);

      await deleteCostingCategory(custom.id);
      const all = await getCostingCategories();
      expect(all.find(c => c.id === custom.id)).toBeUndefined();
    });
  });

  describe('Material Management', () => {
    it('adds and lists materials including Hepoxy with weight', async () => {
      const mat = await addCostingMaterial({
        category_id: 'ad_stone',
        name: 'AD Stone 2mm',
        cost_price: 2.50,
      });
      expect(mat.name).toBe('AD Stone 2mm');
      expect(mat.cost_price).toBe(2.50);

      // Add Hepoxy with weight as identifier
      const hepoxy = await addCostingMaterial({
        category_id: 'hepoxy',
        name: '0.45',
        weight: 0.45,
        cost_price: 30.00,
      });
      expect(hepoxy.weight).toBe(0.45);

      const adList = await getCostingMaterialsByCategory('ad_stone');
      expect(adList.length).toBe(1);

      const hepoxyList = await getCostingMaterialsByCategory('hepoxy');
      expect(hepoxyList.length).toBe(1);
      expect(hepoxyList[0].weight).toBe(0.45);
    });

    it('allows materials without cost price', async () => {
      const mat = await addCostingMaterial({
        category_id: 'mop',
        name: 'MOP Oval',
        cost_price: null,
      });
      expect(mat.cost_price).toBeNull();

      const mopList = await getCostingMaterialsByCategory('mop');
      expect(mopList[0].cost_price).toBeNull();
    });

    it('queries Kundan Stone directly from stones inventory table without duplicates', async () => {
      const list = await getCostingMaterialsByCategory('kundan_stone');
      expect(list.length).toBe(1);
      expect(list[0].name).toBe('KUNDAN-A');
      expect(list[0].cost_price).toBe(4.00);
      expect(list[0].is_inventory_stone).toBe(true);
    });
  });

  describe('Jewelry Costing CRUD & Price Propagation', () => {
    it('saves a jewelry costing record with calculated total', async () => {
      const ad = await addCostingMaterial({ category_id: 'ad_stone', name: 'AD 1', cost_price: 2.50 });
      const mop = await addCostingMaterial({ category_id: 'mop', name: 'MOP 1', cost_price: 6.00 });

      // Ring 001: weight = 3.50, X = 18.00 (weightCost = 63.00)
      // AD 1: qty = 2, price = 2.50 (cost = 5.00)
      // MOP 1: qty = 1, price = 6.00 (cost = 6.00)
      // Total = 74.00
      const saved = await saveJewelryCosting({
        plated_jewelry_id: 'RING-001',
        weight: 3.50,
        materials: [
          { categoryId: 'ad_stone', materialId: ad.id, materialName: ad.name, quantity: 2, unitCost: 2.50 },
          { categoryId: 'mop', materialId: mop.id, materialName: mop.name, quantity: 1, unitCost: 6.00 },
        ],
      });

      expect(saved.cached_total_cost).toBe(74.00);
      expect(saved.is_complete).toBe(true);
      expect(saved.item_id).toBe('RING-001');

      const fetched = await getJewelryCostingById(saved.id);
      expect(fetched?.cached_total_cost).toBe(74.00);
      expect(fetched?.materials.length).toBe(2);
    });

    it('blocks deleting material if used in existing jewelry design', async () => {
      const ad = await addCostingMaterial({ category_id: 'ad_stone', name: 'AD 1', cost_price: 2.50 });

      await saveJewelryCosting({
        plated_jewelry_id: 'RING-001',
        weight: 2.0,
        materials: [
          { categoryId: 'ad_stone', materialId: ad.id, materialName: ad.name, quantity: 1, unitCost: 2.50 },
        ],
      });

      const check = await canDeleteCostingMaterial(ad.id);
      expect(check.canDelete).toBe(false);
      expect(check.jewelryCount).toBe(1);
      await expect(deleteCostingMaterial(ad.id)).rejects.toThrow('used in 1 jewelry costing');
    });

    it('atomically propagates material price change across all jewelry designs', async () => {
      const ad = await addCostingMaterial({ category_id: 'ad_stone', name: 'AD Shared', cost_price: 2.00 });

      // Ring 1: weight 1.0 (X=18 -> 18), 2 of AD Shared @ 2.00 -> total = 22.00
      const j1 = await saveJewelryCosting({
        plated_jewelry_id: 'RING-001',
        weight: 1.0,
        materials: [
          { categoryId: 'ad_stone', materialId: ad.id, materialName: ad.name, quantity: 2, unitCost: 2.00 },
        ],
      });

      // Neck 2: weight 2.0 (X=18 -> 36), 3 of AD Shared @ 2.00 -> total = 42.00
      const j2 = await saveJewelryCosting({
        plated_jewelry_id: 'NECK-002',
        weight: 2.0,
        materials: [
          { categoryId: 'ad_stone', materialId: ad.id, materialName: ad.name, quantity: 3, unitCost: 2.00 },
        ],
      });

      expect(j1.cached_total_cost).toBe(22.00);
      expect(j2.cached_total_cost).toBe(42.00);

      // Now price of AD Shared changes from 2.00 to 5.00
      // Ring 1 new total = 18 + (2 * 5.00) = 28.00
      // Neck 2 new total = 36 + (3 * 5.00) = 51.00
      const propResult = await propagateMaterialCostPrice(ad.id, 5.00);
      expect(propResult.affectedJewelryCount).toBe(2);

      const j1Updated = await getJewelryCostingById(j1.id);
      const j2Updated = await getJewelryCostingById(j2.id);

      expect(j1Updated?.cached_total_cost).toBe(28.00);
      expect(j2Updated?.cached_total_cost).toBe(51.00);
    });

    it('recalculates all jewelry records when multiplier X changes', async () => {
      const ad = await addCostingMaterial({ category_id: 'ad_stone', name: 'AD Stone', cost_price: 10.00 });

      // Ring 1: weight 2.0, X=18 -> weight cost = 36, material cost = 10 -> total = 46.00
      const j1 = await saveJewelryCosting({
        plated_jewelry_id: 'RING-001',
        weight: 2.0,
        materials: [
          { categoryId: 'ad_stone', materialId: ad.id, materialName: ad.name, quantity: 1, unitCost: 10.00 },
        ],
      });
      expect(j1.cached_total_cost).toBe(46.00);

      // Change X from 18.00 to 20.00
      // New weight cost = 2.0 * 20.00 = 40.00, total = 50.00
      await recalculateAllJewelryWithX(20.00);

      const j1Updated = await getJewelryCostingById(j1.id);
      expect(j1Updated?.cached_total_cost).toBe(50.00);
    });
  });

  describe('Cloud upload queue (only what the owner types) and live prices', () => {
    const dirty = () => db.prepare('SELECT entity, id, updated_at FROM costing_dirty ORDER BY entity, id').all() as any[];
    const clearDirty = () => db.exec('DELETE FROM costing_dirty');

    it('marks X, categories, materials and designs as "needs uploading"', async () => {
      await setCostingMultiplierX(20);
      const cat = await createCostingCategory('Beads');
      const mat = await addCostingMaterial({ category_id: cat.id, name: 'Pearl', cost_price: 3 });
      await saveJewelryCosting({ plated_jewelry_id: 'pj_1', weight: 2, materials: [{ categoryId: cat.id, materialId: mat.id, materialName: 'Pearl', quantity: 2, unitCost: 3 }] });
      const keys = dirty().map((d) => `${d.entity}:${d.id.split('_')[0]}`);
      expect(keys).toEqual(expect.arrayContaining(['setting:multiplier', 'category:cat', 'material:mat', 'jewelry:jc']));
    });

    it('deleting queues a deletion (row gone or flagged deleted)', async () => {
      const cat = await createCostingCategory('Temp');
      const mat = await addCostingMaterial({ category_id: 'ad_stone', name: 'Temp stone', cost_price: 1 });
      clearDirty();
      await deleteCostingCategory(cat.id);
      await deleteCostingMaterial(mat.id);
      const d = dirty();
      expect(d.map((x) => x.id)).toEqual(expect.arrayContaining([cat.id, mat.id]));
      const m = db.prepare('SELECT is_deleted, updated_at FROM costing_materials WHERE id = ?').get(mat.id) as any;
      expect(m.is_deleted).toBe(1);
      expect(m.updated_at).not.toBe('');
    });

    it('recalculations are derived: changing X or a price never queues the designs again', async () => {
      const mat = await addCostingMaterial({ category_id: 'ad_stone', name: 'AD 2mm', cost_price: 2 });
      const j = await saveJewelryCosting({ plated_jewelry_id: 'pj_1', weight: 1, materials: [{ categoryId: 'ad_stone', materialId: mat.id, materialName: 'AD 2mm', quantity: 3, unitCost: 2 }] });
      const before = (db.prepare('SELECT updated_at FROM jewelry_costing WHERE id = ?').get(j.id) as any).updated_at;
      clearDirty();
      await recalculateAllJewelryWithX(25);
      await propagateMaterialCostPrice(mat.id, 4);
      const d = dirty();
      expect(d.map((x) => x.entity).sort()).toEqual(['material', 'setting']); // only what was typed
      const after = (db.prepare('SELECT updated_at FROM jewelry_costing WHERE id = ?').get(j.id) as any).updated_at;
      expect(after).toBe(before); // "newest edit wins" is not fooled by a recalculation
      const rec = await getJewelryCostingById(j.id);
      expect(rec?.cached_total_cost).toBe(25 * 1 + 3 * 4);
    });

    it('Kundan stones are read-only in Costing (edited only in the Kundan Stone section)', async () => {
      await expect(updateCostingMaterial('stone_1', { cost_price: 9 })).rejects.toThrow(/Kundan Stone section/);
      await expect(propagateMaterialCostPrice('stone_1', 9)).rejects.toThrow(/Kundan Stone section/);
      const st = db.prepare('SELECT cost_price FROM stones WHERE id = ?').get('stone_1') as any;
      expect(st.cost_price).toBe(4);
      await expect(addCostingMaterial({ category_id: 'kundan_stone', name: 'KUNDAN-Z', cost_price: 1 })).rejects.toThrow(/Kundan Stone section/);
      await expect(upsertCostingMaterial({ category_id: 'kundan_stone', name: 'KUNDAN-A', cost_price: 1 })).rejects.toThrow(/Kundan Stone section/);
      expect(dirty().length).toBe(0);
    });

    it('designs follow the CURRENT inventory stone price', async () => {
      const j = await saveJewelryCosting({ plated_jewelry_id: 'pj_2', weight: 1, materials: [{ categoryId: 'kundan_stone', materialId: 'stone_1', materialName: 'KUNDAN-A', quantity: 2, unitCost: 4 }] });
      expect((await getJewelryCostingById(j.id))?.cached_total_cost).toBe(18 + 8);
      db.exec("UPDATE stones SET cost_price = 5, cost_price_cents = 500 WHERE id = 'stone_1'"); // changed in the inventory
      expect((await getJewelryCostingById(j.id))?.cached_total_cost).toBe(18 + 10);
      const all = await getAllJewelryCostings();
      expect(all.find((x) => x.id === j.id)?.cached_total_cost).toBe(18 + 10);
    });

    it('a deleted material shows as "price missing", not an old price', async () => {
      const mat = await addCostingMaterial({ category_id: 'mop', name: 'MOP 4', cost_price: 7 });
      const j = await saveJewelryCosting({ plated_jewelry_id: 'pj_1', weight: 1, materials: [{ categoryId: 'mop', materialId: mat.id, materialName: 'MOP 4', quantity: 1, unitCost: 7 }] });
      db.prepare('UPDATE costing_materials SET is_deleted = 1 WHERE id = ?').run(mat.id); // e.g. deleted on another device
      const rec = await getJewelryCostingById(j.id);
      expect(rec?.calculated?.missingPriceMaterials).toContain('MOP 4');
      expect(rec?.is_complete).toBe(false);
    });
  });
});
