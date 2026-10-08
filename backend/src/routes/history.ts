import { Hono } from 'hono';
import type { Env, SessionData } from '../types';
import { authMiddleware, ownerOnly } from '../middleware/auth';

type AppEnv = { Bindings: Env; Variables: { session: SessionData } };

const history = new Hono<AppEnv>();

// All history routes are owner-only
history.use('*', authMiddleware, ownerOnly);

/** GET /api/history — paginated, filterable transaction history */
history.get('/', async (c) => {
  const page = Math.max(1, parseInt(c.req.query('page') || '1'));
  const limit = Math.min(200, Math.max(1, parseInt(c.req.query('limit') || '50')));
  const offset = (page - 1) * limit;

  const category = c.req.query('category');
  const dateFrom = c.req.query('date_from');
  const dateTo = c.req.query('date_to');
  const itemSearch = c.req.query('item_search');

  let whereClause = 'WHERE 1=1';
  const params: unknown[] = [];

  if (category) {
    whereClause += ' AND category = ?';
    params.push(category);
  }
  if (dateFrom) {
    whereClause += ' AND created_at >= ?';
    params.push(dateFrom);
  }
  if (dateTo) {
    // Add 1 day to include the full end date
    whereClause += ' AND created_at < datetime(?, "+1 day")';
    params.push(dateTo);
  }
  if (itemSearch) {
    whereClause += ' AND item_display_id LIKE ?';
    params.push(`%${itemSearch}%`);
  }

  // Get paginated results
  const countResult = await c.env.DB.prepare(
    `SELECT COUNT(*) as total FROM transactions ${whereClause}`
  ).bind(...params).first<{ total: number }>();

  const txns = await c.env.DB.prepare(
    `SELECT * FROM transactions ${whereClause} ORDER BY created_at DESC LIMIT ? OFFSET ?`
  ).bind(...params, limit, offset).all();

  // Get aggregate totals for the filtered set
  const totals = await c.env.DB.prepare(
    `SELECT
       COALESCE(SUM(CASE WHEN operation = 'add' THEN quantity_change ELSE 0 END), 0) as total_added,
       COALESCE(SUM(CASE WHEN operation = 'subtract' THEN quantity_change ELSE 0 END), 0) as total_subtracted
     FROM transactions ${whereClause}`
  ).bind(...params).first<{ total_added: number; total_subtracted: number }>();

  return c.json({
    transactions: txns.results || [],
    totals: {
      total_added: totals?.total_added || 0,
      total_subtracted: totals?.total_subtracted || 0,
    },
    total: countResult?.total || 0,
    page,
    limit,
    totalPages: Math.ceil((countResult?.total || 0) / limit),
  });
});

/**
 * POST /api/history/prepare-delete
 *
 * Step 1 of secure deletion: owner selects a date range,
 * system returns the count and boundary snapshot (max transaction ID
 * created before the boundary timestamp). This boundary is stable —
 * new transactions created during the workflow will have IDs outside
 * the boundary and won't be accidentally deleted.
 */
history.post('/prepare-delete', async (c) => {
  const body = await c.req.json<{ date_from?: string; date_to?: string }>();
  if (!body.date_from || !body.date_to) {
    return c.json({ error: 'date_from and date_to are required' }, 400);
  }

  // Find all transactions in this range and capture a stable boundary
  const boundary = await c.env.DB.prepare(
    `SELECT COUNT(*) as count, MAX(rowid) as max_rowid, MIN(created_at) as earliest, MAX(created_at) as latest
     FROM transactions
     WHERE created_at >= ? AND created_at < datetime(?, '+1 day')`
  ).bind(body.date_from, body.date_to).first<{
    count: number; max_rowid: number; earliest: string; latest: string;
  }>();

  if (!boundary || boundary.count === 0) {
    return c.json({ error: 'No transactions found in this date range' }, 404);
  }

  return c.json({
    date_from: body.date_from,
    date_to: body.date_to,
    count: boundary.count,
    boundary_rowid: boundary.max_rowid,
    earliest_transaction: boundary.earliest,
    latest_transaction: boundary.latest,
  });
});

/**
 * POST /api/history/confirm-delete
 *
 * Step 2: Owner confirms deletion after downloading backup.
 * Requires:
 * - confirmation_text === 'DELETE'
 * - boundary_rowid from prepare-delete (stable boundary)
 * - backup_verified flag
 *
 * Deletes ONLY transactions within the date range AND with
 * rowid <= boundary_rowid, ensuring concurrent/new transactions
 * are never touched.
 */
history.post('/confirm-delete', async (c) => {
  const body = await c.req.json<{
    date_from?: string;
    date_to?: string;
    boundary_rowid?: number;
    confirmation_text?: string;
    backup_verified?: boolean;
  }>();

  if (!body.backup_verified) {
    return c.json({ error: 'You must verify that the backup was downloaded' }, 400);
  }
  if (body.confirmation_text !== 'DELETE') {
    return c.json({ error: 'Type DELETE to confirm' }, 400);
  }
  if (!body.date_from || !body.date_to || !body.boundary_rowid) {
    return c.json({ error: 'Missing required parameters' }, 400);
  }

  // Delete only transactions within the date range AND at or before the boundary rowid
  const result = await c.env.DB.prepare(
    `DELETE FROM transactions
     WHERE created_at >= ? AND created_at < datetime(?, '+1 day')
     AND rowid <= ?`
  ).bind(body.date_from, body.date_to, body.boundary_rowid).run();

  return c.json({
    success: true,
    deleted_count: result.meta.changed_db ? result.meta.changes : 0,
  });
});

export default history;
