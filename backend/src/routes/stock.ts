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

  const txId = generateId();
  const nowIso = new Date().toISOString();

  // --- ATOMIC BATCH (one D1 transaction, all-or-nothing) ---
  // 1. The database does the arithmetic ("quantity - 2"), so two people selling the same item at the same
  //    moment are BOTH counted (the old code wrote a value computed from a stale read: 10-2 twice = 8).
  //    Subtract only applies while enough stock is left, so stock can never go negative.
  // 2. The history row and both sync rows are written ONLY if step 1 changed the row (changes() = 1 /
  //    the transaction row exists). Before, a refused update still wrote a phantom history entry and sent
  //    phones a wrong quantity.
  // 3. All values in history and sync come from the row as actually updated, never from the earlier read.
  const updateSQL = operation === 'subtract'
    ? `UPDATE ${table} SET quantity = ROUND(quantity - ?, 3), updated_at = datetime('now')
       WHERE id = ? AND is_deleted = 0 AND ROUND(quantity, 3) >= ?`
    : `UPDATE ${table} SET quantity = ROUND(quantity + ?, 3), updated_at = datetime('now')
       WHERE id = ? AND is_deleted = 0`;
  const updateBindings = operation === 'subtract' ? [changeQty, item.id, changeQty] : [changeQty, item.id];

  // quantity_before is reconstructed from the updated row: after - change (add) or after + change (subtract)
  const beforeExpr = operation === 'add' ? 'ROUND(quantity - ?, 3)' : 'ROUND(quantity + ?, 3)';
  const insertTxSQL = `INSERT INTO transactions
    (id, category, item_id, item_display_id, operation, quantity_before,
     quantity_change, quantity_after, unit, performed_by, performer_name, idempotency_key)
    SELECT ?, ?, id, item_id, ?, ${beforeExpr}, ?, quantity, unit, ?, ?, ?
    FROM ${table} WHERE id = ? AND changes() = 1`;

  const itemSyncSQL = `INSERT INTO sync_changes (entity_type, entity_id, operation, payload)
    SELECT ?, id, 'UPDATE', json_object('id', id, 'item_id', item_id, 'quantity', quantity, 'unit', unit, 'updated_at', ?)
    FROM ${table} WHERE id = ? AND EXISTS (SELECT 1 FROM transactions WHERE id = ?)`;

  const txSyncSQL = `INSERT INTO sync_changes (entity_type, entity_id, operation, payload)
    SELECT 'transactions', id, 'CREATE', json_object(
      'id', id, 'category', category, 'item_id', item_id, 'item_display_id', item_display_id,
      'operation', operation, 'quantity_before', quantity_before, 'quantity_change', quantity_change,
      'quantity_after', quantity_after, 'unit', unit, 'performed_by', performed_by,
      'performer_name', performer_name, 'idempotency_key', idempotency_key, 'created_at', created_at)
    FROM transactions WHERE id = ?`;

  try {
    await c.env.DB.batch([
      c.env.DB.prepare(updateSQL).bind(...updateBindings),
      c.env.DB.prepare(insertTxSQL).bind(
        txId, category, operation, changeQty, changeQty,
        session.userId, session.username, idempotencyKey, item.id
      ),
      c.env.DB.prepare(itemSyncSQL).bind(table, nowIso, item.id, txId),
      c.env.DB.prepare(txSyncSQL).bind(txId),
    ]);
  } catch (err) {
    // Same idempotency key submitted twice at the same moment: the second one hits the UNIQUE key and the
    // whole batch rolls back (no double count). Answer like a normal duplicate.
    const dup = await c.env.DB.prepare(
      `SELECT id, quantity_after FROM transactions WHERE idempotency_key = ?`
    ).bind(idempotencyKey).first<{ id: string; quantity_after: number }>();
    if (dup) {
      return c.json({ success: true, duplicate: true, message: 'This operation was already processed', transaction_id: dup.id, new_balance: dup.quantity_after });
    }
    throw err;
  }

  const tx = await c.env.DB.prepare(
    `SELECT quantity_before, quantity_change, quantity_after FROM transactions WHERE id = ?`
  ).bind(txId).first<{ quantity_before: number; quantity_change: number; quantity_after: number }>();

  if (!tx) {
    // Nothing was written. Tell the caller why, from the current state.
    const now = await c.env.DB.prepare(
      `SELECT quantity FROM ${table} WHERE id = ? AND is_deleted = 0`
    ).bind(item.id).first<{ quantity: number }>();
    if (!now) return c.json({ error: 'Item not found' }, 404);
    return c.json({ error: 'Insufficient stock', current_quantity: now.quantity, requested: changeQty }, 400);
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

export default stock;
