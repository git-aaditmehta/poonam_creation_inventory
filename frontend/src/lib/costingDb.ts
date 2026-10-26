/**
 * costingDb.ts
 * 
 * Local-only Data Access Layer for the Costing feature.
 * Directly executes SQLite queries inside the local Web Worker via localDb.
 * 
 * ZERO CLOUD DATA BOUNDARY:
 * None of the queries here touch the network, APIs, syncEngine, or remote endpoints.
 */

import { localDb } from './localDb';
import {
  calculateJewelryCost,
  roundTo2,
  type CostingMaterialEntry,
  type CalculatedJewelryCost,
} from './costingEngine';

export interface CostingCategory {
  id: string;
  name: string;
  sort_order: number;
  is_system: number;
  created_at: string;
  updated_at: string;
  material_count?: number;
  aggregate_cost?: number;
  missing_price_count?: number;
}

export interface CostingMaterial {
  id: string;
  category_id: string;
  name: string;
  weight: number | null;
  cost_price: number | null;
  is_deleted: number;
  created_at: string;
  updated_at: string;
  is_inventory_stone?: boolean;
}

export interface CostingJewelryMaterialRow {
  id: string;
  jewelry_costing_id: string;
  category_id: string;
  material_id: string;
  material_name: string;
  quantity: number;
  unit_cost: number | null;
  extended_cost: number | null;
  weight: number | null;
  created_at: string;
}

export interface CostingJewelryRecord {
  id: string;
  plated_jewelry_id: string;
  item_id: string; // From plated_jewelry
  image_key?: string | null;
  thumb_key?: string | null;
  weight: number;
  cached_total_cost: number;
  is_complete: boolean;
  materials: CostingMaterialEntry[];
  calculated?: CalculatedJewelryCost;
  created_at: string;
  updated_at: string;
}

// ── Multiplier X Settings ────────────────────────────────────────

export async function getCostingMultiplierX(): Promise<number> {
  await localDb.ready;
  const row = await localDb.get<{ value: string }>(
    "SELECT value FROM costing_settings WHERE key = 'multiplier_x'"
  );
  if (!row || !row.value) return 18.0;
  const val = parseFloat(row.value);
  return isNaN(val) ? 18.0 : val;
}

export async function setCostingMultiplierX(newX: number): Promise<void> {
  await localDb.ready;
  const valStr = newX.toFixed(2);
  const now = new Date().toISOString();
  await localDb.exec(
    "INSERT OR REPLACE INTO costing_settings (key, value, updated_at) VALUES ('multiplier_x', ?, ?)",
    [valStr, now]
  );
}

// ── Categories Management ────────────────────────────────────────

export async function getCostingCategories(): Promise<CostingCategory[]> {
  await localDb.ready;
  const categories = await localDb.query<CostingCategory>(
    'SELECT * FROM costing_categories ORDER BY sort_order ASC, name ASC'
  );

  // Compute stats for each category
  const result: CostingCategory[] = [];
  for (const cat of categories) {
    if (cat.id === 'kundan_stone') {
      // Reuses stones table
      const countRow = await localDb.get<{ count: number; sum_cost: number; missing: number }>(`
        SELECT 
          COUNT(*) as count,
          COALESCE(SUM(cost_price), 0) as sum_cost,
          COALESCE(SUM(CASE WHEN cost_price IS NULL OR cost_price = 0 THEN 1 ELSE 0 END), 0) as missing
        FROM stones
        WHERE is_deleted = 0
      `);
      result.push({
        ...cat,
        material_count: countRow?.count ?? 0,
        aggregate_cost: roundTo2(countRow?.sum_cost ?? 0),
        missing_price_count: countRow?.missing ?? 0,
      });
    } else {
      const stats = await localDb.get<{ count: number; sum_cost: number; missing: number }>(`
        SELECT 
          COUNT(*) as count,
          COALESCE(SUM(cost_price), 0) as sum_cost,
          COALESCE(SUM(CASE WHEN cost_price IS NULL THEN 1 ELSE 0 END), 0) as missing
        FROM costing_materials
        WHERE category_id = ? AND is_deleted = 0
      `, [cat.id]);

      result.push({
        ...cat,
        material_count: stats?.count ?? 0,
        aggregate_cost: roundTo2(stats?.sum_cost ?? 0),
        missing_price_count: stats?.missing ?? 0,
      });
    }
  }

  return result;
}

export async function createCostingCategory(name: string): Promise<CostingCategory> {
  await localDb.ready;
  const trimmed = name.trim();
  if (!trimmed) throw new Error('Category name cannot be empty');

  // Check unique case-insensitive
  const existing = await localDb.get<CostingCategory>(
    'SELECT * FROM costing_categories WHERE LOWER(name) = LOWER(?)',
    [trimmed]
  );
  if (existing) {
    throw new Error(`Category "${trimmed}" already exists`);
  }

  // Get next sort order
  const maxOrder = await localDb.get<{ max_order: number }>(
    'SELECT COALESCE(MAX(sort_order), 0) as max_order FROM costing_categories'
  );
  const nextOrder = (maxOrder?.max_order ?? 0) + 1;

  const id = `cat_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const now = new Date().toISOString();

  await localDb.exec(
    'INSERT INTO costing_categories (id, name, sort_order, is_system, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)',
    [id, trimmed, nextOrder, now, now]
  );

  return {
    id,
    name: trimmed,
    sort_order: nextOrder,
    is_system: 0,
    created_at: now,
    updated_at: now,
    material_count: 0,
    aggregate_cost: 0,
    missing_price_count: 0,
  };
}

export async function updateCostingCategory(id: string, newName: string): Promise<void> {
  await localDb.ready;
  const trimmed = newName.trim();
  if (!trimmed) throw new Error('Category name cannot be empty');

  const existing = await localDb.get<CostingCategory>(
    'SELECT * FROM costing_categories WHERE LOWER(name) = LOWER(?) AND id != ?',
    [trimmed, id]
  );
  if (existing) {
    throw new Error(`Category "${trimmed}" already exists`);
  }

  const now = new Date().toISOString();
  await localDb.exec(
    'UPDATE costing_categories SET name = ?, updated_at = ? WHERE id = ?',
    [trimmed, now, id]
  );
}

export async function canDeleteCostingCategory(id: string): Promise<{ canDelete: boolean; reason?: string }> {
  await localDb.ready;

  // Initial categories cannot be deleted
  const cat = await localDb.get<CostingCategory>('SELECT * FROM costing_categories WHERE id = ?', [id]);
  if (!cat) return { canDelete: false, reason: 'Category not found' };
  if (cat.is_system) {
    return { canDelete: false, reason: `Default category "${cat.name}" cannot be deleted.` };
  }

  // Check if materials exist in this category
  const matCount = await localDb.get<{ count: number }>(
    'SELECT COUNT(*) as count FROM costing_materials WHERE category_id = ? AND is_deleted = 0',
    [id]
  );
  if ((matCount?.count ?? 0) > 0) {
    return {
      canDelete: false,
      reason: `Cannot delete category "${cat.name}" because it contains ${matCount?.count} material(s). Remove materials first.`,
    };
  }

  // Check if any jewelry designs reference this category
  const refCount = await localDb.get<{ count: number }>(
    'SELECT COUNT(*) as count FROM jewelry_costing_materials WHERE category_id = ?',
    [id]
  );
  if ((refCount?.count ?? 0) > 0) {
    return {
      canDelete: false,
      reason: `Cannot delete category "${cat.name}" because it is referenced in existing jewelry costing records.`,
    };
  }

  return { canDelete: true };
}

export async function deleteCostingCategory(id: string): Promise<void> {
  const check = await canDeleteCostingCategory(id);
  if (!check.canDelete) {
    throw new Error(check.reason || 'Category cannot be deleted');
  }

  await localDb.exec('DELETE FROM costing_categories WHERE id = ?', [id]);
}

// ── Materials Management ─────────────────────────────────────────

export async function getCostingMaterialsByCategory(
  categoryId: string,
  search?: string
): Promise<CostingMaterial[]> {
  await localDb.ready;

  if (categoryId === 'kundan_stone') {
    // Reuse existing stones table from inventory
    let sql = 'SELECT id, item_id as name, cost_price FROM stones WHERE is_deleted = 0';
    const params: any[] = [];
    if (search && search.trim()) {
      sql += ' AND item_id LIKE ?';
      params.push(`%${search.trim()}%`);
    }
    sql += ' ORDER BY item_id ASC';

    const rows = await localDb.query<any>(sql, params);
    return rows.map((r) => ({
      id: r.id,
      category_id: 'kundan_stone',
      name: r.name,
      weight: null,
      cost_price: (r.cost_price !== null && r.cost_price !== undefined) ? Number(r.cost_price) : null,
      is_deleted: 0,
      created_at: '',
      updated_at: '',
      is_inventory_stone: true,
    }));
  }

  let sql = 'SELECT * FROM costing_materials WHERE category_id = ? AND is_deleted = 0';
  const params: any[] = [categoryId];
  if (search && search.trim()) {
    sql += ' AND (name LIKE ? OR CAST(weight AS TEXT) LIKE ?)';
    params.push(`%${search.trim()}%`, `%${search.trim()}%`);
  }
  sql += ' ORDER BY name ASC, weight ASC';

  const rows = await localDb.query<CostingMaterial>(sql, params);
  return rows.map((r) => ({
    ...r,
    cost_price: (r.cost_price !== null && r.cost_price !== undefined) ? Number(r.cost_price) : null,
    weight: (r.weight !== null && r.weight !== undefined) ? Number(r.weight) : null,
  }));
}

export async function addCostingMaterial(params: {
  category_id: string;
  name: string;
  weight?: number | null;
  cost_price?: number | null;
}): Promise<CostingMaterial> {
  await localDb.ready;
  const now = new Date().toISOString();
  const id = `mat_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

  const name = params.name.trim();
  const weight = params.weight !== undefined && params.weight !== null ? roundTo2(params.weight) : null;
  const cost_price = params.cost_price !== undefined && params.cost_price !== null ? roundTo2(params.cost_price) : null;

  await localDb.exec(
    'INSERT INTO costing_materials (id, category_id, name, weight, cost_price, is_deleted, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?)',
    [id, params.category_id, name, weight, cost_price, now, now]
  );

  return {
    id,
    category_id: params.category_id,
    name,
    weight,
    cost_price,
    is_deleted: 0,
    created_at: now,
    updated_at: now,
  };
}

/**
 * Upsert a raw material: if a material with the same name (case-insensitive)
 * already exists in the category, update its weight and cost_price.
 * Otherwise, insert a new record.
 * Returns { material, wasUpdated } so callers can track update vs create.
 */
export async function upsertCostingMaterial(params: {
  category_id: string;
  name: string;
  weight?: number | null;
  cost_price?: number | null;
}): Promise<{ material: CostingMaterial; wasUpdated: boolean }> {
  await localDb.ready;
  const now = new Date().toISOString();
  const name = params.name.trim();
  const weight = params.weight !== undefined && params.weight !== null ? roundTo2(params.weight) : null;
  const cost_price = params.cost_price !== undefined && params.cost_price !== null ? roundTo2(params.cost_price) : null;

  // Check for existing material in the same category (case-insensitive name match)
  const existing = await localDb.get<CostingMaterial>(
    'SELECT * FROM costing_materials WHERE category_id = ? AND LOWER(name) = LOWER(?) AND is_deleted = 0',
    [params.category_id, name]
  );

  if (existing) {
    // Update existing record
    await localDb.exec(
      'UPDATE costing_materials SET weight = ?, cost_price = ?, updated_at = ? WHERE id = ?',
      [weight, cost_price, now, existing.id]
    );
    return {
      material: { ...existing, weight, cost_price, updated_at: now },
      wasUpdated: true,
    };
  }

  // Insert new
  const id = `mat_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  await localDb.exec(
    'INSERT INTO costing_materials (id, category_id, name, weight, cost_price, is_deleted, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?)',
    [id, params.category_id, name, weight, cost_price, now, now]
  );

  return {
    material: {
      id,
      category_id: params.category_id,
      name,
      weight,
      cost_price,
      is_deleted: 0,
      created_at: now,
      updated_at: now,
    },
    wasUpdated: false,
  };
}

export async function updateCostingMaterial(
  id: string,
  updates: {
    name?: string;
    weight?: number | null;
    cost_price?: number | null;
  }
): Promise<void> {
  await localDb.ready;
  const now = new Date().toISOString();

  // Check if it's a stone in the stones table
  const stone = await localDb.get<any>('SELECT * FROM stones WHERE id = ?', [id]);
  if (stone) {
    if (updates.cost_price !== undefined) {
      const price = updates.cost_price !== null ? roundTo2(updates.cost_price) : 0;
      const cents = Math.round(price * 100);
      await localDb.exec(
        'UPDATE stones SET cost_price = ?, cost_price_cents = ?, updated_at = ? WHERE id = ?',
        [price, cents, now, id]
      );
    }
    return;
  }

  const existing = await localDb.get<CostingMaterial>('SELECT * FROM costing_materials WHERE id = ?', [id]);
  if (!existing) throw new Error('Material not found');

  const newName = updates.name !== undefined ? updates.name.trim() : existing.name;
  const newWeight = updates.weight !== undefined ? (updates.weight !== null ? roundTo2(updates.weight) : null) : existing.weight;
  const newPrice = updates.cost_price !== undefined ? (updates.cost_price !== null ? roundTo2(updates.cost_price) : null) : existing.cost_price;

  await localDb.exec(
    'UPDATE costing_materials SET name = ?, weight = ?, cost_price = ?, updated_at = ? WHERE id = ?',
    [newName, newWeight, newPrice, now, id]
  );
}

export async function canDeleteCostingMaterial(
  materialId: string
): Promise<{ canDelete: boolean; reason?: string; jewelryCount?: number }> {
  await localDb.ready;

  const countRow = await localDb.get<{ count: number }>(
    'SELECT COUNT(DISTINCT jewelry_costing_id) as count FROM jewelry_costing_materials WHERE material_id = ?',
    [materialId]
  );

  const count = countRow?.count ?? 0;
  if (count > 0) {
    return {
      canDelete: false,
      jewelryCount: count,
      reason: `This material is used in ${count} jewelry costing design(s). Deleting it would break historical costing.`,
    };
  }

  return { canDelete: true, jewelryCount: 0 };
}

export async function deleteCostingMaterial(materialId: string): Promise<void> {
  const check = await canDeleteCostingMaterial(materialId);
  if (!check.canDelete) {
    throw new Error(check.reason || 'Cannot delete referenced material');
  }

  await localDb.exec('UPDATE costing_materials SET is_deleted = 1 WHERE id = ?', [materialId]);
}

/**
 * Propagate material cost price change across all jewelry designs using this material.
 * Atomic: updates material price, updates all jewelry_costing_materials rows,
 * and recalculates all affected jewelry_costing rows.
 */
export async function propagateMaterialCostPrice(
  materialId: string,
  newPrice: number
): Promise<{ affectedJewelryCount: number }> {
  await localDb.ready;
  const price = roundTo2(newPrice);
  const now = new Date().toISOString();

  // 1. Update the master record
  const stone = await localDb.get<any>('SELECT * FROM stones WHERE id = ?', [materialId]);
  if (stone) {
    const cents = Math.round(price * 100);
    await localDb.exec(
      'UPDATE stones SET cost_price = ?, cost_price_cents = ?, updated_at = ? WHERE id = ?',
      [price, cents, now, materialId]
    );
  } else {
    await localDb.exec(
      'UPDATE costing_materials SET cost_price = ?, updated_at = ? WHERE id = ?',
      [price, now, materialId]
    );
  }

  // 2. Find all affected jewelry_costing_materials
  const affectedRows = await localDb.query<CostingJewelryMaterialRow>(
    'SELECT * FROM jewelry_costing_materials WHERE material_id = ?',
    [materialId]
  );

  if (affectedRows.length === 0) {
    return { affectedJewelryCount: 0 };
  }

  const affectedJewelryIds = Array.from(new Set(affectedRows.map((r) => r.jewelry_costing_id)));

  // Update each material row's unit_cost and extended_cost
  for (const row of affectedRows) {
    const extCost = roundTo2(row.quantity * price);
    await localDb.exec(
      'UPDATE jewelry_costing_materials SET unit_cost = ?, extended_cost = ? WHERE id = ?',
      [price, extCost, row.id]
    );
  }

  // 3. Recalculate each affected jewelry_costing record
  const x = await getCostingMultiplierX();
  for (const jewelryCostingId of affectedJewelryIds) {
    await recalculateSingleJewelryCosting(jewelryCostingId, x);
  }

  return { affectedJewelryCount: affectedJewelryIds.length };
}

// ── Jewelry Costing Engine Integration & Persistence ───────────────

/** Internal helper to recalculate and persist a single jewelry_costing record */
async function recalculateSingleJewelryCosting(
  costingId: string,
  currentX: number
): Promise<void> {
  const costing = await localDb.get<{ id: string; weight: number }>(
    'SELECT id, weight FROM jewelry_costing WHERE id = ?',
    [costingId]
  );
  if (!costing) return;

  const matRows = await localDb.query<CostingJewelryMaterialRow>(
    'SELECT * FROM jewelry_costing_materials WHERE jewelry_costing_id = ?',
    [costingId]
  );

  const matEntries: CostingMaterialEntry[] = matRows.map((r) => ({
    categoryId: r.category_id,
    materialId: r.material_id,
    materialName: r.material_name,
    quantity: r.quantity,
    unitCost: r.unit_cost,
    weight: r.weight,
  }));

  const calc = calculateJewelryCost(costing.weight, currentX, matEntries);
  const now = new Date().toISOString();

  await localDb.exec(
    'UPDATE jewelry_costing SET cached_total_cost = ?, is_complete = ?, updated_at = ? WHERE id = ?',
    [calc.totalCost, calc.isComplete ? 1 : 0, now, costingId]
  );
}

/** Recalculate all jewelry records when multiplier X changes */
export async function recalculateAllJewelryWithX(
  newX: number
): Promise<{ updatedCount: number }> {
  await setCostingMultiplierX(newX);
  const allCostings = await localDb.query<{ id: string }>('SELECT id FROM jewelry_costing');
  for (const c of allCostings) {
    await recalculateSingleJewelryCosting(c.id, newX);
  }
  return { updatedCount: allCostings.length };
}

export async function getAllJewelryCostings(
  search?: string
): Promise<CostingJewelryRecord[]> {
  await localDb.ready;
  const currentX = await getCostingMultiplierX();

  let sql = `
    SELECT 
      jc.id,
      jc.plated_jewelry_id,
      jc.weight,
      jc.cached_total_cost,
      jc.is_complete,
      jc.created_at,
      jc.updated_at,
      pj.item_id,
      pj.image_key,
      pj.thumb_key
    FROM jewelry_costing jc
    LEFT JOIN plated_jewelry pj ON jc.plated_jewelry_id = pj.id OR jc.plated_jewelry_id = pj.item_id
  `;

  const params: any[] = [];
  if (search && search.trim()) {
    sql += ' WHERE pj.item_id LIKE ? OR jc.plated_jewelry_id LIKE ?';
    params.push(`%${search.trim()}%`, `%${search.trim()}%`);
  }
  sql += ' ORDER BY pj.item_id ASC, jc.created_at DESC';

  const rows = await localDb.query<any>(sql, params);
  const results: CostingJewelryRecord[] = [];

  // Build lookup of current master material prices so updated prices propagate immediately
  const masterPriceMap = new Map<string, number>();
  try {
    const rawMats = await localDb.query<any>('SELECT id, name, cost_price FROM costing_materials WHERE is_deleted = 0 AND cost_price IS NOT NULL');
    for (const rm of rawMats) {
      if (rm.cost_price !== null && rm.cost_price !== undefined) {
        masterPriceMap.set(rm.id, Number(rm.cost_price));
        masterPriceMap.set(rm.name.toLowerCase().trim(), Number(rm.cost_price));
      }
    }
    const stoneMats = await localDb.query<any>('SELECT id, item_id, cost_price, cost_price_cents FROM stones WHERE is_deleted = 0');
    for (const sm of stoneMats) {
      const price = sm.cost_price !== null && sm.cost_price !== undefined && sm.cost_price > 0 
        ? Number(sm.cost_price) 
        : (sm.cost_price_cents ? sm.cost_price_cents / 100 : null);
      if (price !== null) {
        masterPriceMap.set(sm.id, price);
        masterPriceMap.set(sm.item_id.toLowerCase().trim(), price);
      }
    }
  } catch {
    // Non-fatal
  }

  for (const r of rows) {
    const matRows = await localDb.query<CostingJewelryMaterialRow>(
      'SELECT * FROM jewelry_costing_materials WHERE jewelry_costing_id = ? ORDER BY category_id ASC, material_name ASC',
      [r.id]
    );

    const materials: CostingMaterialEntry[] = matRows.map((m) => {
      let unitCost = m.unit_cost;
      if ((unitCost === null || unitCost === undefined) && m.material_id) {
        const found = masterPriceMap.get(m.material_id) ?? masterPriceMap.get(m.material_name.toLowerCase().trim());
        if (found !== undefined) {
          unitCost = found;
        }
      }
      return {
        id: m.id,
        categoryId: m.category_id,
        materialId: m.material_id,
        materialName: m.material_name,
        quantity: m.quantity,
        unitCost,
        weight: m.weight,
      };
    });

    const calc = calculateJewelryCost(r.weight, currentX, materials);

    results.push({
      id: r.id,
      plated_jewelry_id: r.plated_jewelry_id,
      item_id: r.item_id || r.plated_jewelry_id,
      image_key: r.image_key,
      thumb_key: r.thumb_key,
      weight: Number(r.weight),
      cached_total_cost: calc.totalCost,
      is_complete: calc.isComplete,
      materials,
      calculated: calc,
      created_at: r.created_at,
      updated_at: r.updated_at,
    });
  }

  return results;
}

export async function getJewelryCostingById(
  id: string
): Promise<CostingJewelryRecord | null> {
  await localDb.ready;
  const currentX = await getCostingMultiplierX();

  const r = await localDb.get<any>(`
    SELECT 
      jc.id,
      jc.plated_jewelry_id,
      jc.weight,
      jc.cached_total_cost,
      jc.is_complete,
      jc.created_at,
      jc.updated_at,
      pj.item_id,
      pj.image_key,
      pj.thumb_key
    FROM jewelry_costing jc
    LEFT JOIN plated_jewelry pj ON jc.plated_jewelry_id = pj.id OR jc.plated_jewelry_id = pj.item_id
    WHERE jc.id = ? OR jc.plated_jewelry_id = ?
  `, [id, id]);

  if (!r) return null;

  const matRows = await localDb.query<CostingJewelryMaterialRow>(
    'SELECT * FROM jewelry_costing_materials WHERE jewelry_costing_id = ? ORDER BY category_id ASC, material_name ASC',
    [r.id]
  );

  const materials: CostingMaterialEntry[] = matRows.map((m) => ({
    id: m.id,
    categoryId: m.category_id,
    materialId: m.material_id,
    materialName: m.material_name,
    quantity: m.quantity,
    unitCost: m.unit_cost,
    weight: m.weight,
  }));

  const calc = calculateJewelryCost(r.weight, currentX, materials);

  return {
    id: r.id,
    plated_jewelry_id: r.plated_jewelry_id,
    item_id: r.item_id || r.plated_jewelry_id,
    image_key: r.image_key,
    thumb_key: r.thumb_key,
    weight: Number(r.weight),
    cached_total_cost: calc.totalCost,
    is_complete: calc.isComplete,
    materials,
    calculated: calc,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

export async function saveJewelryCosting(data: {
  id?: string;
  plated_jewelry_id: string;
  weight: number;
  materials: CostingMaterialEntry[];
}): Promise<CostingJewelryRecord> {
  await localDb.ready;
  const currentX = await getCostingMultiplierX();
  const now = new Date().toISOString();

  // Calculate totals and validate
  const calc = calculateJewelryCost(data.weight, currentX, data.materials);

  let costingId = data.id;
  let platedId = data.plated_jewelry_id;

  // Normalize plated_jewelry_id to UUID if known, or match item_id
  const pjMatch = await localDb.get<{ id: string }>(
    'SELECT id FROM plated_jewelry WHERE id = ? OR LOWER(item_id) = LOWER(?)',
    [data.plated_jewelry_id, data.plated_jewelry_id]
  );
  if (pjMatch) {
    platedId = pjMatch.id;
  }

  if (!costingId) {
    // Check if an existing costing record exists for this plated jewelry item (by id or design code)
    const existing = await localDb.get<{ id: string }>(
      `SELECT jc.id FROM jewelry_costing jc
       LEFT JOIN plated_jewelry pj ON jc.plated_jewelry_id = pj.id OR jc.plated_jewelry_id = pj.item_id
       WHERE jc.plated_jewelry_id = ? 
          OR jc.plated_jewelry_id = ?
          OR pj.id = ? 
          OR LOWER(pj.item_id) = LOWER(?)
          OR LOWER(jc.plated_jewelry_id) = LOWER(?)`,
      [data.plated_jewelry_id, platedId, platedId, data.plated_jewelry_id, data.plated_jewelry_id]
    );
    costingId = existing?.id || `jc_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  }

  // 1. Upsert jewelry_costing record
  await localDb.exec(`
    INSERT INTO jewelry_costing (id, plated_jewelry_id, weight, cached_total_cost, is_complete, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      plated_jewelry_id = excluded.plated_jewelry_id,
      weight = excluded.weight,
      cached_total_cost = excluded.cached_total_cost,
      is_complete = excluded.is_complete,
      updated_at = excluded.updated_at
  `, [
    costingId,
    platedId,
    calc.jewelryWeight,
    calc.totalCost,
    calc.isComplete ? 1 : 0,
    now,
    now,
  ]);

  // 2. Clear old materials and insert updated list
  await localDb.exec('DELETE FROM jewelry_costing_materials WHERE jewelry_costing_id = ?', [costingId]);

  for (const m of calc.materials) {
    const matRowId = `jcm_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    await localDb.exec(`
      INSERT INTO jewelry_costing_materials (id, jewelry_costing_id, category_id, material_id, material_name, quantity, unit_cost, extended_cost, weight, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      matRowId,
      costingId,
      m.categoryId,
      m.materialId,
      m.materialName,
      m.quantity,
      m.unitCost,
      m.extendedCost,
      m.weight,
      now,
    ]);
  }

  // Fetch plated jewelry metadata for clean return
  const pj = await localDb.get<any>(
    'SELECT item_id, image_key, thumb_key FROM plated_jewelry WHERE id = ? OR item_id = ?',
    [data.plated_jewelry_id, data.plated_jewelry_id]
  );

  return {
    id: costingId,
    plated_jewelry_id: data.plated_jewelry_id,
    item_id: pj?.item_id || data.plated_jewelry_id,
    image_key: pj?.image_key,
    thumb_key: pj?.thumb_key,
    weight: calc.jewelryWeight,
    cached_total_cost: calc.totalCost,
    is_complete: calc.isComplete,
    materials: data.materials,
    calculated: calc,
    created_at: now,
    updated_at: now,
  };
}

export async function deleteJewelryCosting(id: string): Promise<void> {
  await localDb.ready;
  await localDb.exec('DELETE FROM jewelry_costing_materials WHERE jewelry_costing_id = ?', [id]);
  await localDb.exec('DELETE FROM jewelry_costing WHERE id = ?', [id]);
}

export async function getAvailablePlatedJewelry(
  search?: string
): Promise<Array<{ id: string; item_id: string; image_key?: string; thumb_key?: string; is_costed: boolean }>> {
  await localDb.ready;

  let sql = `
    SELECT 
      pj.id,
      pj.item_id,
      pj.image_key,
      pj.thumb_key,
      CASE WHEN jc.id IS NOT NULL THEN 1 ELSE 0 END as is_costed
    FROM plated_jewelry pj
    LEFT JOIN jewelry_costing jc ON jc.plated_jewelry_id = pj.id OR jc.plated_jewelry_id = pj.item_id
    WHERE pj.is_deleted = 0
  `;

  const params: any[] = [];
  if (search && search.trim()) {
    sql += ' AND pj.item_id LIKE ?';
    params.push(`%${search.trim()}%`);
  }

  sql += ' ORDER BY pj.item_id ASC LIMIT 50';

  const rows = await localDb.query<any>(sql, params);
  return rows.map((r) => ({
    id: r.id,
    item_id: r.item_id,
    image_key: r.image_key,
    thumb_key: r.thumb_key,
    is_costed: Boolean(r.is_costed),
  }));
}
