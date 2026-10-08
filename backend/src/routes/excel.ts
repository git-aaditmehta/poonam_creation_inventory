import { Hono } from 'hono';
import type { Env, SessionData } from '../types';
import { authMiddleware, ownerOnly } from '../middleware/auth';
import { generateId } from '../utils/crypto';
import {
  validateString, validatePositiveNumber, validatePositiveInteger,
  validateUnit, rupeesToPaisa, collectErrors,
} from '../utils/validation';

type AppEnv = { Bindings: Env; Variables: { session: SessionData } };

const excel = new Hono<AppEnv>();

// All excel routes are owner-only
excel.use('*', authMiddleware, ownerOnly);

// Default strict column name aliases (case-insensitive matching)
const COLUMN_ALIASES: Record<string, string[]> = {
  item_id: ['id', 'item id', 'product id', 'design id', 'design code', 'item code', 'stone code', 'foil code', 'item name', 'name', 'stone name', 'foil name'],
  quantity: ['quantity', 'qty', 'stock', 'current stock', 'current quantity'],
  unit: ['unit', 'uom'],
  low_stock_threshold: ['min threshold', 'minimum threshold', 'min_threshold', 'min. threshold', 'low stock threshold', 'minimum stock', 'min stock', 'threshold', 'low stock', 'min qty', 'minimum'],
  cost_price: ['cost price', 'cost', 'purchase price', 'price', 'unit price', 'buying price', 'cost price (₹)', 'cost price (rs)', 'cost price (inr)'],
};

/**
 * POST /api/excel/auto-map
 * Given column headers from the client-parsed Excel, return suggested mappings.
 * Strict matching only — no fuzzy guessing.
 */
excel.post('/auto-map', async (c) => {
  const body = await c.req.json<{ columns: string[]; category: string }>();
  if (!body.columns || !Array.isArray(body.columns)) {
    return c.json({ error: 'columns array is required' }, 400);
  }

  const mapping: Record<string, string | null> = {};
  const unmapped: string[] = [];

  for (const col of body.columns) {
    const normalizedCol = col.trim().toLowerCase();
    let matched = false;

    for (const [field, aliases] of Object.entries(COLUMN_ALIASES)) {
      if (aliases.includes(normalizedCol)) {
        mapping[col] = field;
        matched = true;
        break;
      }
    }

    if (!matched) {
      mapping[col] = null;
      unmapped.push(col);
    }
  }

  return c.json({
    mapping,
    unmapped,
    requires_manual_mapping: unmapped.length > 0,
  });
});

/**
 * POST /api/excel/validate-row
 * Server-side validation of a single queue row before commit.
 * The client parses Excel and manages the queue; the Worker
 * independently validates every row before writing to D1.
 */
excel.post('/validate-row', async (c) => {
  const body = await c.req.json<{
    category: string;
    item_id?: string;
    quantity?: number;
    unit?: string;
    low_stock_threshold?: number;
    cost_price?: number;
  }>();

  const validCategories = ['plated_jewelry', 'raw_jewelry', 'stones', 'foil'];
  if (!validCategories.includes(body.category)) {
    return c.json({ errors: [{ field: 'category', message: 'Invalid category' }] }, 400);
  }

  const errors = collectErrors([
    validateString(body.item_id, 'item_id'),
  ]);

  // Quantity is required — no defaults
  if (body.quantity === undefined || body.quantity === null) {
    errors.push({ field: 'quantity', message: 'Please enter quantity' });
  } else {
    const qErr = validatePositiveNumber(body.quantity, 'quantity');
    if (qErr) errors.push(qErr);
  }

  // Low stock threshold is required — no defaults
  if (body.low_stock_threshold === undefined || body.low_stock_threshold === null) {
    errors.push({ field: 'low_stock_threshold', message: 'Low stock threshold is required' });
  } else {
    const tErr = validatePositiveNumber(body.low_stock_threshold, 'low_stock_threshold');
    if (tErr) errors.push(tErr);
  }

  // Unit validation (required for plated/raw jewelry, fixed for stones/foil)
  if (body.category === 'plated_jewelry' || body.category === 'raw_jewelry') {
    if (!body.unit) {
      errors.push({ field: 'unit', message: 'Unit selection is required (PC/KGS/SET/JODI)' });
    } else {
      const uErr = validateUnit(body.unit, 'unit');
      if (uErr) errors.push(uErr);
    }
  }

  // Cost price required for plated_jewelry, stones, foil — no defaults
  if (['plated_jewelry', 'stones', 'foil'].includes(body.category)) {
    if (body.cost_price === undefined || body.cost_price === null) {
      errors.push({ field: 'cost_price', message: 'Cost price is required' });
    } else {
      const cpErr = validatePositiveNumber(body.cost_price, 'cost_price');
      if (cpErr) errors.push(cpErr);
    }
  }

  // Check for existing item_id conflict
  if (body.item_id && errors.length === 0) {
    const table = body.category;
    const existing = await c.env.DB.prepare(
      `SELECT id, item_id FROM ${table} WHERE item_id = ? AND is_deleted = 0`
    ).bind(body.item_id.trim()).first();
    if (existing) {
      errors.push({
        field: 'item_id',
        message: `Item "${body.item_id}" already exists in ${body.category.replace('_', ' ')}`,
      });
    }
  }

  if (errors.length > 0) {
    return c.json({ valid: false, errors }, 400);
  }

  return c.json({ valid: true });
});

/**
 * POST /api/excel/commit-row
 * Commit a single validated queue row to D1.
 * Every field is re-validated server-side — the queue is a staging area only.
 */
excel.post('/commit-row', async (c) => {
  const body = await c.req.json<{
    category: string;
    item_id: string;
    quantity: number;
    unit?: string;
    low_stock_threshold: number;
    cost_price?: number;
  }>();

  // Full server-side re-validation
  const validCategories = ['plated_jewelry', 'raw_jewelry', 'stones', 'foil'];
  if (!validCategories.includes(body.category)) {
    return c.json({ error: 'Invalid category' }, 400);
  }

  const errors = collectErrors([
    validateString(body.item_id, 'item_id'),
  ]);

  if (body.quantity === undefined || body.quantity === null) {
    errors.push({ field: 'quantity', message: 'Please enter quantity' });
  } else {
    const qErr = validatePositiveNumber(body.quantity, 'quantity');
    if (qErr) errors.push(qErr);
  }

  if (body.low_stock_threshold === undefined || body.low_stock_threshold === null) {
    errors.push({ field: 'low_stock_threshold', message: 'Low stock threshold is required' });
  } else {
    const tErr = validatePositiveNumber(body.low_stock_threshold, 'low_stock_threshold');
    if (tErr) errors.push(tErr);
  }

  const table = body.category;
  let unit: string;
  let costCents: number | null = null;

  if (table === 'stones') {
    unit = 'PC';
  } else if (table === 'foil') {
    unit = 'KGS';
  } else {
    if (!body.unit) {
      errors.push({ field: 'unit', message: 'Unit is required' });
    } else {
      const uErr = validateUnit(body.unit, 'unit');
      if (uErr) errors.push(uErr);
    }
    unit = body.unit || '';
  }

  if (['plated_jewelry', 'stones', 'foil'].includes(table)) {
    if (body.cost_price === undefined || body.cost_price === null) {
      errors.push({ field: 'cost_price', message: 'Cost price is required' });
    } else {
      const cpErr = validatePositiveNumber(body.cost_price, 'cost_price');
      if (cpErr) errors.push(cpErr);
      costCents = rupeesToPaisa(body.cost_price);
    }
  }

  if (errors.length > 0) return c.json({ errors }, 400);

  // Check uniqueness
  const existing = await c.env.DB.prepare(
    `SELECT id FROM ${table} WHERE item_id = ? AND is_deleted = 0`
  ).bind(body.item_id.trim()).first();
  if (existing) {
    return c.json({ error: `Item "${body.item_id}" already exists` }, 409);
  }

  const id = generateId();

  if (costCents !== null) {
    await c.env.DB.prepare(
      `INSERT INTO ${table} (id, item_id, quantity, unit, low_stock_threshold, cost_price_cents)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(id, body.item_id.trim(), body.quantity, unit, body.low_stock_threshold, costCents).run();
  } else {
    await c.env.DB.prepare(
      `INSERT INTO ${table} (id, item_id, quantity, unit, low_stock_threshold)
       VALUES (?, ?, ?, ?, ?)`
    ).bind(id, body.item_id.trim(), body.quantity, unit, body.low_stock_threshold).run();
  }

  return c.json({ success: true, id, item_id: body.item_id.trim() }, 201);
});

export default excel;
