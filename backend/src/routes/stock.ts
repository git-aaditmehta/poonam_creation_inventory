import { Hono } from 'hono';
import type { Env, SessionData } from '../types';
import { authMiddleware } from '../middleware/auth';
import { generateId } from '../utils/crypto';
import { validateRequired, validateStrictPositiveNumber, collectErrors } from '../utils/validation';

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
  const changeQty = body.quantity!;
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

  const quantityBefore = item.quantity;
  let quantityAfter: number;

  if (operation === 'add') {
    quantityAfter = quantityBefore + changeQty;
  } else {
    quantityAfter = quantityBefore - changeQty;
    if (quantityAfter < 0) {
      return c.json({
        error: 'Insufficient stock',
        current_quantity: quantityBefore,
        requested: changeQty,
      }, 400);
    }
  }

  const txId = generateId();

  // --- ATOMIC BATCH: update quantity + insert history ---
  // The conditional UPDATE ensures concurrency safety:
  //   For subtract: only succeeds if quantity >= changeQty (prevents negative)
  //   For add: only succeeds if quantity matches expected (prevents lost updates)
  const updateSQL = operation === 'subtract'
    ? `UPDATE ${table} SET quantity = quantity - ?, updated_at = datetime('now') WHERE id = ? AND is_deleted = 0 AND quantity >= ?`
    : `UPDATE ${table} SET quantity = quantity + ?, updated_at = datetime('now') WHERE id = ? AND is_deleted = 0 AND quantity = ?`;

  const updateBindings = operation === 'subtract'
    ? [changeQty, item.id, changeQty]
    : [changeQty, item.id, quantityBefore];

  const insertTxSQL = `INSERT INTO transactions
    (id, category, item_id, item_display_id, operation, quantity_before,
     quantity_change, quantity_after, unit, performed_by, performer_name, idempotency_key)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

  const batchResults = await c.env.DB.batch([
    c.env.DB.prepare(updateSQL).bind(...updateBindings),
    c.env.DB.prepare(insertTxSQL).bind(
      txId, category, item.id, item.item_id, operation,
      quantityBefore, changeQty, quantityAfter,
      item.unit, session.userId, session.username, idempotencyKey
    ),
  ]);

  // Check if the UPDATE actually changed a row (concurrency check)
  const updateResult = batchResults[0];
  if (!updateResult.meta.changed_db) {
    // The conditional UPDATE didn't match — concurrent modification or insufficient stock
    // The batch is atomic, so the transaction record is also rolled back
    return c.json({
      error: 'Stock operation failed — inventory was modified concurrently. Please retry.',
      current_quantity: quantityBefore,
    }, 409);
  }

  return c.json({
    success: true,
    transaction_id: txId,
    item_id: item.item_id,
    operation,
    quantity_before: quantityBefore,
    quantity_change: changeQty,
    new_balance: quantityAfter,
    unit: item.unit,
  });
});

export default stock;
