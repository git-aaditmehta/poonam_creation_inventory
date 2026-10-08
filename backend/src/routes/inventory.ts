import { Hono } from 'hono';
import type { Env, SessionData } from '../types';
import { authMiddleware, ownerOnly } from '../middleware/auth';
import { generateId } from '../utils/crypto';
import {
  collectErrors, validateRequired, validateString,
  validatePositiveNumber, validateUnit,
  rupeesToPaisa, paisaToRupees,
} from '../utils/validation';

type AppEnv = { Bindings: Env; Variables: { session: SessionData } };

const inventory = new Hono<AppEnv>();

// Helper: map DB row to API response, stripping cost data for staff
function mapItem(row: Record<string, unknown>, role: string, hasCost: boolean) {
  const item: Record<string, unknown> = {
    id: row.id,
    item_id: row.item_id,
    quantity: row.quantity,
    unit: row.unit,
    low_stock_threshold: row.low_stock_threshold,
    is_low_stock: (row.quantity as number) < (row.low_stock_threshold as number),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
  if (row.image_key !== undefined) {
    item.image_key = row.image_key;
    item.thumb_key = row.thumb_key;
  }
  if (hasCost && role === 'owner') {
    item.cost_price = paisaToRupees(row.cost_price_cents as number);
  }
  return item;
}

// ============================================================
// GENERIC CRUD FACTORY for all 4 categories
// ============================================================

interface CategoryConfig {
  table: string;
  category: string;
  hasImage: boolean;
  hasCost: boolean;
  fixedUnit: string | null; // null = owner must select
  extraFields: string[];
}

function createCategoryRoutes(config: CategoryConfig) {
  const cat = new Hono<AppEnv>();

  // GET /list — paginated, searchable
  cat.get('/', authMiddleware, async (c) => {
    const session = c.get('session');
    const page = Math.max(1, parseInt(c.req.query('page') || '1'));
    const limit = Math.min(100, Math.max(1, parseInt(c.req.query('limit') || '50')));
    const search = c.req.query('search')?.trim();
    const offset = (page - 1) * limit;

    let whereClause = 'WHERE is_deleted = 0';
    const params: unknown[] = [];

    if (search) {
      whereClause += ' AND item_id LIKE ?';
      params.push(`%${search}%`);
    }

    const countResult = await c.env.DB.prepare(
      `SELECT COUNT(*) as total FROM ${config.table} ${whereClause}`
    ).bind(...params).first<{ total: number }>();

    const items = await c.env.DB.prepare(
      `SELECT * FROM ${config.table} ${whereClause} ORDER BY item_id ASC LIMIT ? OFFSET ?`
    ).bind(...params, limit, offset).all();

    return c.json({
      items: items.results?.map((r) => mapItem(r, session.role, config.hasCost)) || [],
      total: countResult?.total || 0,
      page,
      limit,
      totalPages: Math.ceil((countResult?.total || 0) / limit),
    });
  });

  // GET /valuation — owner-only aggregate
  if (config.hasCost) {
    cat.get('/valuation', authMiddleware, ownerOnly, async (c) => {
      const result = await c.env.DB.prepare(
        `SELECT COALESCE(SUM(cost_price_cents * quantity), 0) as total_paisa
         FROM ${config.table} WHERE is_deleted = 0`
      ).first<{ total_paisa: number }>();
      return c.json({ total_value: paisaToRupees(result?.total_paisa || 0) });
    });
  }

  // GET /:id — single item
  cat.get('/:id', authMiddleware, async (c) => {
    const session = c.get('session');
    const itemId = c.req.param('id');
    const row = await c.env.DB.prepare(
      `SELECT * FROM ${config.table} WHERE id = ? AND is_deleted = 0`
    ).bind(itemId).first();

    if (!row) return c.json({ error: 'Item not found' }, 404);
    return c.json({ item: mapItem(row, session.role, config.hasCost) });
  });

  // POST / — create item (owner only)
  cat.post('/', authMiddleware, ownerOnly, async (c) => {
    const body = await c.req.json();
    const errors = collectErrors([
      validateString(body.item_id, 'item_id'),
      validateRequired(body.quantity, 'quantity'),
      validatePositiveNumber(body.quantity, 'quantity'),
      validateRequired(body.low_stock_threshold, 'low_stock_threshold'),
      validatePositiveNumber(body.low_stock_threshold, 'low_stock_threshold'),
      ...(config.fixedUnit === null ? [validateUnit(body.unit, 'unit')] : []),
      ...(config.hasCost ? [
        validateRequired(body.cost_price, 'cost_price'),
        validatePositiveNumber(body.cost_price, 'cost_price'),
      ] : []),
    ]);

    if (body.quantity === undefined || body.quantity === null || body.quantity === '') {
      if (!errors.find(e => e.field === 'quantity')) {
        errors.push({ field: 'quantity', message: 'Please enter quantity' });
      }
    }

    if (errors.length > 0) return c.json({ errors }, 400);

    // Check for duplicate item_id
    const existing = await c.env.DB.prepare(
      `SELECT id FROM ${config.table} WHERE item_id = ?`
    ).bind(body.item_id.trim()).first();
    if (existing) {
      return c.json({ error: `Item with ID "${body.item_id}" already exists` }, 409);
    }

    const id = generateId();
    const unit = config.fixedUnit || body.unit;
    const costCents = config.hasCost ? rupeesToPaisa(body.cost_price) : 0;

    if (config.hasCost) {
      await c.env.DB.prepare(
        `INSERT INTO ${config.table} (id, item_id, quantity, unit, low_stock_threshold, cost_price_cents)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).bind(id, body.item_id.trim(), body.quantity, unit, body.low_stock_threshold, costCents).run();
    } else {
      await c.env.DB.prepare(
        `INSERT INTO ${config.table} (id, item_id, quantity, unit, low_stock_threshold)
         VALUES (?, ?, ?, ?, ?)`
      ).bind(id, body.item_id.trim(), body.quantity, unit, body.low_stock_threshold).run();
    }

    return c.json({ success: true, id, item_id: body.item_id.trim() }, 201);
  });

  // PUT /:id — update master data (owner only). Does NOT change quantity (use stock ops).
  cat.put('/:id', authMiddleware, ownerOnly, async (c) => {
    const itemId = c.req.param('id');
    const body = await c.req.json();

    const existing = await c.env.DB.prepare(
      `SELECT * FROM ${config.table} WHERE id = ? AND is_deleted = 0`
    ).bind(itemId).first();
    if (!existing) return c.json({ error: 'Item not found' }, 404);

    const updates: string[] = [];
    const params: unknown[] = [];

    if (body.item_id !== undefined) {
      const err = validateString(body.item_id, 'item_id');
      if (err) return c.json({ errors: [err] }, 400);
      // Check uniqueness if changing item_id
      if (body.item_id.trim() !== existing.item_id) {
        const dup = await c.env.DB.prepare(
          `SELECT id FROM ${config.table} WHERE item_id = ? AND id != ?`
        ).bind(body.item_id.trim(), itemId).first();
        if (dup) return c.json({ error: `Item ID "${body.item_id}" already exists` }, 409);
      }
      updates.push('item_id = ?');
      params.push(body.item_id.trim());
    }

    if (body.unit !== undefined && config.fixedUnit === null) {
      const err = validateUnit(body.unit, 'unit');
      if (err) return c.json({ errors: [err] }, 400);
      updates.push('unit = ?');
      params.push(body.unit);
    }

    if (body.low_stock_threshold !== undefined) {
      const err = validatePositiveNumber(body.low_stock_threshold, 'low_stock_threshold');
      if (err) return c.json({ errors: [err] }, 400);
      updates.push('low_stock_threshold = ?');
      params.push(body.low_stock_threshold);
    }

    if (body.cost_price !== undefined && config.hasCost) {
      const err = validatePositiveNumber(body.cost_price, 'cost_price');
      if (err) return c.json({ errors: [err] }, 400);
      updates.push('cost_price_cents = ?');
      params.push(rupeesToPaisa(body.cost_price));
    }

    if (updates.length === 0) {
      return c.json({ error: 'No valid fields to update' }, 400);
    }

    updates.push("updated_at = datetime('now')");
    params.push(itemId);

    await c.env.DB.prepare(
      `UPDATE ${config.table} SET ${updates.join(', ')} WHERE id = ?`
    ).bind(...params).run();

    return c.json({ success: true });
  });

  // DELETE /:id — hard delete (owner only)
  cat.delete('/:id', authMiddleware, ownerOnly, async (c) => {
    const itemId = c.req.param('id');

    // If category has images (e.g. plated_jewelry), clean up R2 images first
    if (config.hasImage) {
      const item = await c.env.DB.prepare(
        `SELECT image_key, thumb_key FROM ${config.table} WHERE id = ?`
      ).bind(itemId).first<{ image_key: string | null; thumb_key: string | null }>();

      if (item?.image_key) {
        try { await c.env.IMAGES.delete(item.image_key); } catch { /* ignore */ }
      }
      if (item?.thumb_key) {
        try { await c.env.IMAGES.delete(item.thumb_key); } catch { /* ignore */ }
      }
    }

    const result = await c.env.DB.prepare(
      `DELETE FROM ${config.table} WHERE id = ?`
    ).bind(itemId).run();

    if (!result.meta.changed_db) {
      return c.json({ error: 'Item not found' }, 404);
    }
    return c.json({ success: true });
  });

  return cat;
}

// ============================================================
// Create routes for all 4 categories
// ============================================================

const platedJewelry = createCategoryRoutes({
  table: 'plated_jewelry', category: 'plated_jewelry',
  hasImage: true, hasCost: true, fixedUnit: null, extraFields: ['image_key', 'thumb_key'],
});

const rawJewelry = createCategoryRoutes({
  table: 'raw_jewelry', category: 'raw_jewelry',
  hasImage: false, hasCost: false, fixedUnit: null, extraFields: [],
});

const stones = createCategoryRoutes({
  table: 'stones', category: 'stones',
  hasImage: false, hasCost: true, fixedUnit: 'PC', extraFields: [],
});

const foil = createCategoryRoutes({
  table: 'foil', category: 'foil',
  hasImage: false, hasCost: true, fixedUnit: 'KGS', extraFields: [],
});

// Mount all under /api/inventory
inventory.route('/plated-jewelry', platedJewelry);
inventory.route('/raw-jewelry', rawJewelry);
inventory.route('/stones', stones);
inventory.route('/foil', foil);

// ============================================================
// Low Stock — Owner only, across all categories
// ============================================================
inventory.get('/low-stock', authMiddleware, ownerOnly, async (c) => {
  const categories = [
    { table: 'plated_jewelry', name: 'Plated Jewelry', hasCost: true },
    { table: 'raw_jewelry', name: 'Raw Jewelry', hasCost: false },
    { table: 'stones', name: 'Stones', hasCost: true },
    { table: 'foil', name: 'Foil', hasCost: true },
  ];

  const lowStockItems: Record<string, unknown>[] = [];

  for (const cat of categories) {
    const results = await c.env.DB.prepare(
      `SELECT *, '${cat.name}' as category_name FROM ${cat.table}
       WHERE is_deleted = 0 AND quantity < low_stock_threshold
       ORDER BY (low_stock_threshold - quantity) DESC`
    ).all();

    for (const row of results.results || []) {
      lowStockItems.push({
        ...mapItem(row, 'owner', cat.hasCost),
        category: cat.table,
        category_name: cat.name,
      });
    }
  }

  return c.json({ items: lowStockItems, total: lowStockItems.length });
});

export default inventory;
