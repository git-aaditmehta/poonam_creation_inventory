import { Hono } from 'hono';
import type { Env, SessionData } from '../types';
import { authMiddleware } from '../middleware/auth';
import { generateId } from '../utils/crypto';
import { validateRequired, validateStrictPositiveNumber, collectErrors, validateWholeNumberFor } from '../utils/validation';

type AppEnv = { Bindings: Env; Variables: { session: SessionData } };

const stock = new Hono<AppEnv>();

const VALID_CATEGORIES = ['plated_jewelry', 'raw_jewelry', 'stones', 'foil'] as const;
type Category = typeof VALID_CATEGORIES[number];

const CATEGORY_TABLE: Record<Category, string> = {
  plated_jewelry: 'plated_jewelry',
  raw_jewelry: 'raw_jewelry',
  stones: 'stones',
  foil: 'foil',
};

type ChangeResult =
  | { txId: string; tx: { quantity_before: number; quantity_change: number; quantity_after: number }; duplicate?: boolean }
  | { error: true; status: 400 | 404 | 409; body: Record<string, unknown> };

/**
 * One stock movement, all-or-nothing (used by Stock Operations and by Undo):
 * 1. The database does the arithmetic ("quantity - 2"), so two people changing the same item at the same moment
 *    are BOTH counted. Subtract only applies while enough stock is left, so stock can never go negative.
 * 2. The history row and both sync rows are written ONLY if step 1 changed the row.
 * 3. All values in history and sync come from the row as actually updated, never from an earlier read.
 */
async function applyChange(
  env: Env,
  o: { table: string; category: Category; itemUuid: string; operation: 'add' | 'subtract'; qty: number; idempotencyKey: string; userId: string; username: string; reversesId: string | null },
): Promise<ChangeResult> {
  const { table, category, operation, qty } = o;
  const txId = generateId();
  const nowIso = new Date().toISOString();
  const updateSQL = operation === 'subtract'
    ? `UPDATE ${table} SET quantity = ROUND(quantity - ?, 3), updated_at = datetime('now')
       WHERE id = ? AND is_deleted = 0 AND ROUND(quantity, 3) >= ?`
    : `UPDATE ${table} SET quantity = ROUND(quantity + ?, 3), updated_at = datetime('now')
       WHERE id = ? AND is_deleted = 0`;
  const updateBindings = operation === 'subtract' ? [qty, o.itemUuid, qty] : [qty, o.itemUuid];
  // quantity_before is reconstructed from the updated row: after - change (add) or after + change (subtract)
  const beforeExpr = operation === 'add' ? 'ROUND(quantity - ?, 3)' : 'ROUND(quantity + ?, 3)';
  const insertTxSQL = `INSERT INTO transactions
    (id, category, item_id, item_display_id, operation, quantity_before,
     quantity_change, quantity_after, unit, performed_by, performer_name, idempotency_key, reverses_id)
    SELECT ?, ?, id, item_id, ?, ${beforeExpr}, ?, quantity, unit, ?, ?, ?, ?
    FROM ${table} WHERE id = ? AND changes() = 1`;
  const itemSyncSQL = `INSERT INTO sync_changes (entity_type, entity_id, operation, payload)
    SELECT ?, id, 'UPDATE', json_object('id', id, 'item_id', item_id, 'quantity', quantity, 'unit', unit, 'updated_at', ?)
    FROM ${table} WHERE id = ? AND EXISTS (SELECT 1 FROM transactions WHERE id = ?)`;
  const txSyncSQL = `INSERT INTO sync_changes (entity_type, entity_id, operation, payload)
    SELECT 'transactions', id, 'CREATE', json_object(
      'id', id, 'category', category, 'item_id', item_id, 'item_display_id', item_display_id,
      'operation', operation, 'quantity_before', quantity_before, 'quantity_change', quantity_change,
      'quantity_after', quantity_after, 'unit', unit, 'performed_by', performed_by,
      'performer_name', performer_name, 'idempotency_key', idempotency_key, 'created_at', created_at,
      'reverses_id', reverses_id)
    FROM transactions WHERE id = ?`;
  try {
    await env.DB.batch([
      env.DB.prepare(updateSQL).bind(...updateBindings),
      env.DB.prepare(insertTxSQL).bind(txId, category, operation, qty, qty, o.userId, o.username, o.idempotencyKey, o.reversesId, o.itemUuid),
      env.DB.prepare(itemSyncSQL).bind(table, nowIso, o.itemUuid, txId),
      env.DB.prepare(txSyncSQL).bind(txId),
    ]);
  } catch (err) {
    // Same idempotency key (or the same undo) submitted twice at the same moment: the UNIQUE key rolls the whole
    // batch back (no double count). Answer like a normal duplicate.
    const dup = await env.DB.prepare(`SELECT id, quantity_before, quantity_change, quantity_after FROM transactions WHERE idempotency_key = ?`)
      .bind(o.idempotencyKey)
      .first<{ id: string; quantity_before: number; quantity_change: number; quantity_after: number }>();
    if (dup) return { txId: dup.id, tx: dup, duplicate: true };
    if (o.reversesId) {
      const undone = await env.DB.prepare(`SELECT performer_name FROM transactions WHERE reverses_id = ?`).bind(o.reversesId).first<{ performer_name: string }>();
      if (undone) return { error: true, status: 409, body: { error: `This operation was already undone by ${undone.performer_name}.` } };
    }
    throw err;
  }
  const tx = await env.DB.prepare(`SELECT quantity_before, quantity_change, quantity_after FROM transactions WHERE id = ?`)
    .bind(txId)
    .first<{ quantity_before: number; quantity_change: number; quantity_after: number }>();
  if (!tx) {
    // Nothing was written. Say why, from the current state.
    const now = await env.DB.prepare(`SELECT quantity FROM ${table} WHERE id = ? AND is_deleted = 0`).bind(o.itemUuid).first<{ quantity: number }>();
    if (!now) return { error: true, status: 404, body: { error: 'Item not found' } };
    return { error: true, status: 400, body: { error: 'Insufficient stock', current_quantity: now.quantity, requested: qty } };
  }
  return { txId, tx };
}

/**
 * POST /api/stock/operate
 *
 * Atomic stock operation: validates, updates quantity, and inserts
 * transaction history in a single D1 batch (all-or-nothing).
 *
 * Uses conditional UPDATE (WHERE quantity >= change for subtract)
 * to prevent negative inventory and race conditions.
 *
 * Idempotency key prevents duplicate submissions.
 */
stock.post('/operate', authMiddleware, async (c) => {
  const session = c.get('session');
  const body = await c.req.json<{
    category?: string;
    item_id?: string;
    operation?: string;
    quantity?: number;
    idempotency_key?: string;
  }>();

  // --- Validate input ---
  const errors = collectErrors([
    validateRequired(body.category, 'category'),
    validateRequired(body.item_id, 'item_id'),
    validateRequired(body.operation, 'operation'),
    validateRequired(body.quantity, 'quantity'),
    validateStrictPositiveNumber(body.quantity, 'quantity'),
    validateRequired(body.idempotency_key, 'idempotency_key'),
  ]);

  if (!VALID_CATEGORIES.includes(body.category as Category)) {
    errors.push({ field: 'category', message: 'Invalid category' });
  }
  if (body.operation && !['add', 'subtract'].includes(body.operation)) {
    errors.push({ field: 'operation', message: 'Operation must be "add" or "subtract"' });
  }
  if (errors.length > 0) return c.json({ errors }, 400);

  const category = body.category as Category;
  const table = CATEGORY_TABLE[category];
  const operation = body.operation as 'add' | 'subtract';
  const idempotencyKey = body.idempotency_key!;

  // --- Check idempotency: reject duplicate submissions ---
  const existingTx = await c.env.DB.prepare(
    `SELECT id, quantity_after FROM transactions WHERE idempotency_key = ?`
  ).bind(idempotencyKey).first<{ id: string; quantity_after: number }>();

  if (existingTx) {
    return c.json({
      success: true,
      duplicate: true,
      message: 'This operation was already processed',
      transaction_id: existingTx.id,
      new_balance: existingTx.quantity_after,
    });
  }

  // --- Fetch current item (from authoritative D1 state) ---
  const item = await c.env.DB.prepare(
    `SELECT id, item_id, quantity, unit FROM ${table} WHERE id = ? AND is_deleted = 0`
  ).bind(body.item_id).first<{
    id: string; item_id: string; quantity: number; unit: string;
  }>();

  if (!item) {
    return c.json({ error: 'Item not found' }, 404);
  }

  // Only Foil (weighed) may have decimals; everything else is counted in whole numbers.
  // A decimal is refused with a clear message — never silently rounded (0.25 must not become 0).
  const wholeErr = validateWholeNumberFor(category, body.quantity, 'quantity');
  if (wholeErr) return c.json({ errors: [wholeErr], error: wholeErr.message }, 400);
  // 3-decimal rounding only removes floating-point noise (0.1 + 0.2); whole numbers pass through unchanged
  const changeQty = Math.round(body.quantity! * 1000) / 1000;

  // Early, friendly answer for an obvious shortfall (the atomic UPDATE below is the real guard)
  if (operation === 'subtract' && Math.round(item.quantity * 1000) / 1000 < changeQty) {
    return c.json({ error: 'Insufficient stock', current_quantity: item.quantity, requested: changeQty }, 400);
  }

  const done = await applyChange(c.env, {
    table, category, itemUuid: item.id, operation, qty: changeQty, idempotencyKey,
    userId: session.userId, username: session.username, reversesId: null,
  });
  if ('error' in done) return c.json(done.body, done.status);
  const { txId, tx } = done;
  if (done.duplicate) {
    return c.json({ success: true, duplicate: true, message: 'This operation was already processed', transaction_id: txId, new_balance: tx.quantity_after });
  }

  return c.json({
    success: true,
    transaction_id: txId,
    item_id: item.item_id,
    operation,
    quantity_before: tx.quantity_before,
    quantity_change: tx.quantity_change,
    new_balance: tx.quantity_after,
    unit: item.unit,
  });
});

const UNDO_DAYS = 7;
const CATEGORY_NAME: Record<Category, string> = { plated_jewelry: 'Plated Jewelry', raw_jewelry: 'Raw Jewelry', stones: 'Kundan Stone', foil: 'Foil' };
const fmt = (n: number) => String(Math.round(n * 1000) / 1000);

/**
 * POST /api/stock/undo  { transaction_id }
 * Undo a stock movement (agreed 2026-11-21): records the opposite movement in the cloud, linked to the original
 * (reverses_id); the original stays in history. Staff may undo their own movements, the owner anyone's; within
 * 7 days; at most once (the database enforces it); never below zero; an undo itself cannot be undone.
 */
stock.post('/undo', authMiddleware, async (c) => {
  const session = c.get('session');
  const body = await c.req.json<{ transaction_id?: unknown; idempotency_key?: unknown }>().catch(() => null);
  // The phone knows a just-made operation by its idempotency key (it was sent in the background)
  const ref = typeof body?.transaction_id === 'string' ? body.transaction_id : typeof body?.idempotency_key === 'string' ? body.idempotency_key : '';
  if (!ref) return c.json({ error: 'Choose the stock operation to undo.' }, 400);

  const orig = await c.env.DB.prepare(
    `SELECT id, category, item_id, item_display_id, operation, quantity_change, unit, performed_by, performer_name, reverses_id,
            datetime(created_at) >= datetime('now', '-${UNDO_DAYS} days') AS recent
     FROM transactions WHERE id = ? OR idempotency_key = ? LIMIT 1`
  ).bind(ref, ref).first<{ id: string; category: Category; item_id: string; item_display_id: string; operation: 'add' | 'subtract'; quantity_change: number; unit: string; performed_by: string; performer_name: string; reverses_id: string | null; recent: number }>();
  if (!orig) return c.json({ error: 'This stock operation has not reached the cloud yet, or its history was cleared. If it is still in Sync Queue, wait a moment and try again.', code: 'not_in_cloud' }, 404);
  const id = orig.id;
  if (orig.reverses_id) return c.json({ error: 'This entry is itself an undo and cannot be undone. If needed, make a new stock operation.' }, 400);
  if (session.role !== 'owner' && orig.performed_by !== session.userId) {
    return c.json({ error: `Only ${orig.performer_name} or the owner can undo this operation. Staff can undo only their own operations.` }, 403);
  }
  if (!orig.recent) return c.json({ error: `Only operations from the last ${UNDO_DAYS} days can be undone. Make a new stock operation instead.` }, 400);
  const already = await c.env.DB.prepare(`SELECT performer_name, created_at FROM transactions WHERE reverses_id = ?`).bind(id).first<{ performer_name: string; created_at: string }>();
  if (already) return c.json({ error: `This operation was already undone by ${already.performer_name}.` }, 409);
  if (!VALID_CATEGORIES.includes(orig.category)) return c.json({ error: 'Invalid category' }, 400);

  const reverse: 'add' | 'subtract' = orig.operation === 'add' ? 'subtract' : 'add';
  const done = await applyChange(c.env, {
    table: CATEGORY_TABLE[orig.category],
    category: orig.category,
    itemUuid: orig.item_id,
    operation: reverse,
    qty: orig.quantity_change,
    idempotencyKey: `undo:${orig.id}`,
    userId: session.userId,
    username: session.username,
    reversesId: orig.id,
  });
  if ('error' in done) {
    if (done.status === 404) {
      return c.json({ error: `${orig.item_display_id} no longer exists in ${CATEGORY_NAME[orig.category]} (it was deleted), so this operation can't be undone.` }, 404);
    }
    if (done.status === 400 && 'current_quantity' in done.body) {
      const now = Number(done.body.current_quantity);
      return c.json({
        error: `Can't undo: ${orig.item_display_id} has only ${fmt(now)} ${orig.unit} now. Undoing the stock in of ${fmt(orig.quantity_change)} ${orig.unit} would take it to ${fmt(now - orig.quantity_change)}. Stock can't go below zero.`,
        current_quantity: now,
      }, 400);
    }
    return c.json(done.body, done.status);
  }
  return c.json({
    success: true,
    transaction_id: done.txId,
    reverses_id: orig.id,
    category: orig.category,
    item_uuid: orig.item_id,
    item_display_id: orig.item_display_id,
    operation: reverse,
    quantity_change: done.tx.quantity_change,
    new_balance: done.tx.quantity_after,
    unit: orig.unit,
    message: `Undone: ${orig.operation === 'add' ? 'stock in' : 'stock out'} of ${fmt(orig.quantity_change)} ${orig.unit} on ${orig.item_display_id}. Stock is now ${fmt(done.tx.quantity_after)} ${orig.unit}.`,
  });
});

export default stock;
