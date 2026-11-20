import { Hono } from 'hono';
import type { Env, SessionData } from '../types';
import { authMiddleware, ownerOnly } from '../middleware/auth';
import { generateId } from '../utils/crypto';
import {
  validateString, validatePositiveNumber, validateWholeNumberFor,
  validateUnit, rupeesToPaisa, collectErrors,
} from '../utils/validation';
import { logSyncChange } from '../utils/syncLog';
import { ITEM_KEY_SQL, itemKey, isDuplicateIdError, duplicateIdMessage } from '../utils/itemId';

const CATEGORY_NAME: Record<string, string> = {
  plated_jewelry: 'Plated Jewelry',
  raw_jewelry: 'Raw Jewelry',
  stones: 'Kundan Stone',
  foil: 'Foil',
};

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
    const qErr = validatePositiveNumber(body.quantity, 'quantity') || validateWholeNumberFor(body.category, body.quantity, 'quantity');
    if (qErr) errors.push(qErr);
  }

  // Low stock threshold is required — no defaults
  if (body.low_stock_threshold === undefined || body.low_stock_threshold === null) {
    errors.push({ field: 'low_stock_threshold', message: 'Low stock threshold is required' });
  } else {
    const tErr = validatePositiveNumber(body.low_stock_threshold, 'low_stock_threshold') || validateWholeNumberFor(body.category, body.low_stock_threshold, 'low_stock_threshold');
    if (tErr) errors.push(tErr);
  }

  // Unit validation (required for plated/raw jewelry, fixed for stones/foil)
  if (body.category === 'plated_jewelry' || body.category === 'raw_jewelry') {
    if (!body.unit) {
      errors.push({ field: 'unit', message: 'Unit selection is required (PC/KGS/SET/JODI/GRMS)' });
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
      `SELECT id, item_id FROM ${table} WHERE ${ITEM_KEY_SQL} = ?`
    ).bind(itemKey(body.item_id)).first<{ id: string; item_id: string }>();
    if (existing) {
      errors.push({
        field: 'item_id',
        message: duplicateIdMessage(body.item_id, existing.item_id, CATEGORY_NAME[table] || table),
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
    const qErr = validatePositiveNumber(body.quantity, 'quantity') || validateWholeNumberFor(body.category, body.quantity, 'quantity');
    if (qErr) errors.push(qErr);
  }

  if (body.low_stock_threshold === undefined || body.low_stock_threshold === null) {
    errors.push({ field: 'low_stock_threshold', message: 'Low stock threshold is required' });
  } else {
    const tErr = validatePositiveNumber(body.low_stock_threshold, 'low_stock_threshold') || validateWholeNumberFor(body.category, body.low_stock_threshold, 'low_stock_threshold');
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
    `SELECT id, item_id FROM ${table} WHERE ${ITEM_KEY_SQL} = ?`
  ).bind(itemKey(body.item_id)).first<{ id: string; item_id: string }>();
  if (existing) {
    return c.json({ error: duplicateIdMessage(body.item_id, existing.item_id, CATEGORY_NAME[table] || table) }, 409);
  }

  const id = generateId();

  try {
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
  } catch (err) {
    if (isDuplicateIdError(err)) return c.json({ error: duplicateIdMessage(body.item_id, null, CATEGORY_NAME[table] || table) }, 409);
    throw err;
  }

  // Fetch the created item and log CDC change for sync
  const createdRow = await c.env.DB.prepare(
    `SELECT * FROM ${table} WHERE id = ?`
  ).bind(id).first<Record<string, unknown>>();
  if (createdRow) {
    await logSyncChange(c.env.DB, table, id, 'CREATE', createdRow);
  }

  return c.json({ success: true, id, item_id: body.item_id.trim(), item: createdRow }, 201);
});

// ═══ Batch import (agreed 2026-11-21) ══════════════════════════════════════════════════════════════════════════
// The app checks every row itself first (same rules, same wording); the server checks them all again here and is the
// only judge. Rows are saved 50 at a time with their sync record in ONE transaction per row group, and every row gets
// its own answer, so a single bad row never blocks the others and nothing is half-saved.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BATCH_MAX = 50;
const CHECK_MAX = 500;

type ImportRow = {
  id: string;
  item_id: string;
  quantity: number;
  unit?: string;
  low_stock_threshold: number;
  cost_price?: number;
};

const VALID_CATEGORIES = ['plated_jewelry', 'raw_jewelry', 'stones', 'foil'] as const;
const HAS_COST = new Set(['plated_jewelry', 'stones', 'foil']);

/** The same problems, in the same words, as the app shows (frontend/src/utils/excelImport.ts rowProblems). */
function rowProblems(category: string, r: ImportRow): string[] {
  const out: string[] = [];
  const name = CATEGORY_NAME[category];
  const id = typeof r.item_id === 'string' ? r.item_id.trim() : '';
  if (!id) out.push('Design code is empty.');
  else if (id.length > 255) out.push('Design code is too long (more than 255 characters).');
  const num = (v: unknown, label: string, decimalsOk: boolean, required = true) => {
    if (v === undefined || v === null || (v as unknown) === '') {
      if (required) out.push(`${label} is empty.`);
      return;
    }
    if (typeof v !== 'number' || !Number.isFinite(v)) return void out.push(`${label} is not a number.`);
    if (v < 0) return void out.push(`${label} can't be negative (${v}).`);
    if (!decimalsOk && !Number.isInteger(v)) out.push(`${label} has decimals (${v}). ${name} is counted in whole numbers; enter a whole number.`);
  };
  num(r.quantity, 'Quantity', category === 'foil');
  num(r.low_stock_threshold, 'Low stock level', category === 'foil');
  if (HAS_COST.has(category)) num(r.cost_price, 'Cost price', true);
  if (category === 'plated_jewelry' || category === 'raw_jewelry') {
    if (!r.unit) out.push('Unit is empty. Choose PC, KGS, SET, JODI or GRMS.');
    else if (validateUnit(r.unit, 'unit')) out.push(`Unit "${r.unit}" is not one the app knows. Choose PC, KGS, SET, JODI or GRMS.`);
  }
  return out;
}

/** Existing items (deleted ones too: their IDs cannot be reused) by ID key, for up to CHECK_MAX keys. */
async function existingByKey(db: D1Database, table: string, keys: string[]) {
  const map = new Map<string, { item_id: string; is_deleted: number }>();
  if (keys.length === 0) return map;
  const res = await db
    .prepare(`SELECT item_id, is_deleted, ${ITEM_KEY_SQL} AS k FROM ${table} WHERE ${ITEM_KEY_SQL} IN (SELECT value FROM json_each(?))`)
    .bind(JSON.stringify(keys))
    .all<{ item_id: string; is_deleted: number; k: string }>();
  for (const r of res.results || []) map.set(r.k, { item_id: r.item_id, is_deleted: r.is_deleted });
  return map;
}

function existsMessage(typed: string, found: { item_id: string; is_deleted: number }, category: string): string {
  const as = found.item_id !== typed.trim() ? ` as "${found.item_id}"` : '';
  return found.is_deleted
    ? `"${typed.trim()}" was used before${as} for an item that was later deleted in ${CATEGORY_NAME[category]}. A design code can't be reused; use a different code.`
    : `"${typed.trim()}" already exists${as} in ${CATEGORY_NAME[category]}. Import only adds new designs; to change its stock use Stock Operations. (Codes that differ only in capitals, spaces or dashes are the same design.)`;
}

/**
 * POST /api/excel/check-rows  { category, item_ids: string[] (<= 500) }
 * Which of these design codes already exist (one query instead of one request per row).
 */
excel.post('/check-rows', async (c) => {
  const body = await c.req.json<{ category: string; item_ids: unknown }>().catch(() => null);
  if (!body || !VALID_CATEGORIES.includes(body.category as (typeof VALID_CATEGORIES)[number])) return c.json({ error: 'Invalid category' }, 400);
  if (!Array.isArray(body.item_ids) || body.item_ids.length > CHECK_MAX) return c.json({ error: `Send between 0 and ${CHECK_MAX} design codes at a time.` }, 400);
  const ids = body.item_ids.filter((x): x is string => typeof x === 'string' && x.trim().length > 0);
  const found = await existingByKey(c.env.DB, body.category, [...new Set(ids.map(itemKey))]);
  const existing: Record<string, string> = {};
  for (const id of ids) {
    const f = found.get(itemKey(id));
    if (f) existing[id] = existsMessage(id, f, body.category);
  }
  return c.json({ existing });
});

/**
 * POST /api/excel/save-rows  { category, rows: ImportRow[] (<= 50) }
 * Each row carries an id made by the app, so sending the same rows again (e.g. the answer was lost on a bad
 * connection) never creates a second copy: a row whose id is already saved is reported as saved.
 * Answer: { results: [{ id, status: 'saved' | 'not_saved', message?, item? }] } in the order sent.
 */
excel.post('/save-rows', async (c) => {
  const body = await c.req.json<{ category: string; rows: unknown }>().catch(() => null);
  if (!body || !VALID_CATEGORIES.includes(body.category as (typeof VALID_CATEGORIES)[number])) return c.json({ error: 'Invalid category' }, 400);
  if (!Array.isArray(body.rows) || body.rows.length === 0 || body.rows.length > BATCH_MAX) {
    return c.json({ error: `Send between 1 and ${BATCH_MAX} rows at a time.` }, 400);
  }
  const category = body.category;
  const table = category;
  const rows = body.rows as ImportRow[];
  const results: { id: string; status: 'saved' | 'not_saved'; message?: string; item?: Record<string, unknown> }[] = rows.map((r) => ({
    id: typeof r?.id === 'string' ? r.id : '',
    status: 'not_saved',
  }));

  // 1. Rules for every row
  const candidates: number[] = [];
  rows.forEach((r, i) => {
    if (!r || typeof r !== 'object' || !UUID_RE.test(String(r.id))) {
      results[i].message = 'This row could not be read. Reload the Excel page and try again.';
      return;
    }
    const problems = rowProblems(category, r);
    if (problems.length) results[i].message = problems.join(' ');
    else candidates.push(i);
  });

  // 2. Already saved by an earlier attempt of this same import (same row id): report as saved
  const ids = candidates.map((i) => rows[i].id);
  const savedBefore = new Map<string, Record<string, unknown>>();
  if (ids.length) {
    const res = await c.env.DB.prepare(`SELECT * FROM ${table} WHERE id IN (SELECT value FROM json_each(?))`).bind(JSON.stringify(ids)).all<Record<string, unknown>>();
    for (const r of res.results || []) savedBefore.set(String(r.id), r);
  }
  const toInsert: number[] = [];
  for (const i of candidates) {
    const before = savedBefore.get(rows[i].id);
    if (before) Object.assign(results[i], { status: 'saved', item: before });
    else toInsert.push(i);
  }

  // 3. Design code already used (in the database, or twice in this group)
  const existing = await existingByKey(c.env.DB, table, [...new Set(toInsert.map((i) => itemKey(rows[i].item_id)))]);
  const firstInGroup = new Map<string, number>();
  const ready: number[] = [];
  for (const i of toInsert) {
    const k = itemKey(rows[i].item_id);
    const f = existing.get(k);
    if (f) {
      results[i].message = existsMessage(rows[i].item_id, f, category);
      continue;
    }
    if (firstInGroup.has(k)) {
      results[i].message = `Same design code as "${rows[firstInGroup.get(k)!].item_id.trim()}" in this file. Codes that differ only in capitals, spaces or dashes are the same design.`;
      continue;
    }
    firstInGroup.set(k, i);
    ready.push(i);
  }

  // 4. Save: each item and its sync record together (all or nothing per item)
  const cols = ((await c.env.DB.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>()).results || []).map((r) => r.name);
  const payloadSql = `json_object(${cols.map((n) => `'${n}', ${n}`).join(', ')})`;
  const statementsFor = (i: number) => {
    const r = rows[i];
    const unit = table === 'stones' ? 'PC' : table === 'foil' ? 'KGS' : String(r.unit);
    const insert = HAS_COST.has(table)
      ? c.env.DB.prepare(`INSERT INTO ${table} (id, item_id, quantity, unit, low_stock_threshold, cost_price_cents) VALUES (?, ?, ?, ?, ?, ?)`).bind(
          r.id, r.item_id.trim(), r.quantity, unit, r.low_stock_threshold, rupeesToPaisa(Number(r.cost_price)),
        )
      : c.env.DB.prepare(`INSERT INTO ${table} (id, item_id, quantity, unit, low_stock_threshold) VALUES (?, ?, ?, ?, ?)`).bind(
          r.id, r.item_id.trim(), r.quantity, unit, r.low_stock_threshold,
        );
    const log = c.env.DB.prepare(
      `INSERT INTO sync_changes (entity_type, entity_id, operation, payload) SELECT ?, id, 'CREATE', ${payloadSql} FROM ${table} WHERE id = ?`,
    ).bind(table, r.id);
    return [insert, log];
  };
  const saved: number[] = [];
  if (ready.length) {
    try {
      await c.env.DB.batch(ready.flatMap(statementsFor)); // one transaction for the whole group
      saved.push(...ready);
    } catch {
      // Something in the group failed (e.g. the same code saved from another device a moment ago): save one by one
      for (const i of ready) {
        try {
          await c.env.DB.batch(statementsFor(i));
          saved.push(i);
        } catch (err) {
          results[i].message = isDuplicateIdError(err)
            ? duplicateIdMessage(rows[i].item_id, null, CATEGORY_NAME[category])
            : 'Could not be saved because of a server problem. Try saving again.';
        }
      }
    }
  }
  if (saved.length) {
    const res = await c.env.DB.prepare(`SELECT * FROM ${table} WHERE id IN (SELECT value FROM json_each(?))`)
      .bind(JSON.stringify(saved.map((i) => rows[i].id)))
      .all<Record<string, unknown>>();
    const byId = new Map((res.results || []).map((r) => [String(r.id), r]));
    for (const i of saved) Object.assign(results[i], { status: 'saved', item: byId.get(rows[i].id) });
  }
  return c.json({ results });
});

export default excel;
