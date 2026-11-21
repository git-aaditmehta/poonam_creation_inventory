import { Hono } from 'hono';
import type { Env, SessionData } from '../types';
import { authMiddleware, ownerOnly } from '../middleware/auth';
import { itemKey } from '../utils/itemId';
import { IST_DAY_START_SQL, IST_DAY_END_SQL, isYmd } from '../utils/time';

type AppEnv = { Bindings: Env; Variables: { session: SessionData } };

const history = new Hono<AppEnv>();

// Viewing the history: owner and staff (agreed 2026-11-21; it holds no cost prices). Deleting history: owner only.
history.use('*', authMiddleware);

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
  if ((dateFrom && !isYmd(dateFrom)) || (dateTo && !isYmd(dateTo))) {
    return c.json({ error: 'Dates must be in the format YYYY-MM-DD' }, 400);
  }
  // Indian calendar days (00:00–24:00 IST); stored times are UTC
  if (dateFrom) {
    whereClause += ` AND created_at >= ${IST_DAY_START_SQL}`;
    params.push(dateFrom);
  }
  if (dateTo) {
    whereClause += ` AND created_at < ${IST_DAY_END_SQL}`;
    params.push(dateTo);
  }
  if (itemSearch) {
    // Also ignores capitals, spaces and dashes: "ps365" finds "PS-365"
    const key = itemKey(itemSearch);
    whereClause += key
      ? ` AND (item_display_id LIKE ? OR REPLACE(REPLACE(UPPER(TRIM(item_display_id)), ' ', ''), '-', '') LIKE ?)`
      : ' AND item_display_id LIKE ?';
    params.push(`%${itemSearch}%`, ...(key ? [`%${key}%`] : []));
  }

  // Get paginated results
  const countResult = await c.env.DB.prepare(
    `SELECT COUNT(*) as total FROM transactions ${whereClause}`
  ).bind(...params).first<{ total: number }>();

  const txns = await c.env.DB.prepare(
    `SELECT t.*,
       (SELECT r.performer_name FROM transactions r WHERE r.reverses_id = t.id) AS undone_by,
       (SELECT r.created_at FROM transactions r WHERE r.reverses_id = t.id) AS undone_at
     FROM transactions t ${whereClause} ORDER BY t.created_at DESC LIMIT ? OFFSET ?`
  ).bind(...params, limit, offset).all();

  // Totals PER UNIT for the filtered set (pieces, grams and kg must never be added together)
  const unitTotals = await c.env.DB.prepare(
    `SELECT unit,
       COALESCE(SUM(CASE WHEN operation = 'add' THEN quantity_change ELSE 0 END), 0) as added,
       COALESCE(SUM(CASE WHEN operation = 'subtract' THEN quantity_change ELSE 0 END), 0) as removed
     FROM transactions ${whereClause} GROUP BY unit ORDER BY unit`
  ).bind(...params).all<{ unit: string; added: number; removed: number }>();
  const totalsByUnit = (unitTotals.results || []).map((r) => ({
    unit: r.unit,
    added: Math.round(r.added * 1000) / 1000,
    removed: Math.round(r.removed * 1000) / 1000,
  }));
  const totals = {
    total_added: totalsByUnit.reduce((a, r) => a + r.added, 0),
    total_subtracted: totalsByUnit.reduce((a, r) => a + r.removed, 0),
  };

  return c.json({
    transactions: txns.results || [],
    // Kept for older app versions; the app shows totals_by_unit
    totals: {
      total_added: totals.total_added,
      total_subtracted: totals.total_subtracted,
    },
    totals_by_unit: totalsByUnit,
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
history.post('/prepare-delete', ownerOnly, async (c) => {
  const body = await c.req.json<{ date_from?: string; date_to?: string }>();
  if (!isYmd(body.date_from) || !isYmd(body.date_to)) {
    return c.json({ error: 'Choose a start and an end date (YYYY-MM-DD)' }, 400);
  }

  // Find all transactions in this range and capture a stable boundary
  const boundary = await c.env.DB.prepare(
    `SELECT COUNT(*) as count, MAX(rowid) as max_rowid, MIN(created_at) as earliest, MAX(created_at) as latest
     FROM transactions
     WHERE created_at >= ${IST_DAY_START_SQL} AND created_at < ${IST_DAY_END_SQL}`
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
history.post('/confirm-delete', ownerOnly, async (c) => {
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

  // Fetch IDs of transactions to be deleted so CDC can propagate the deletions to offline devices
  const toDelete = await c.env.DB.prepare(
    `SELECT id FROM transactions
     WHERE created_at >= ${IST_DAY_START_SQL} AND created_at < ${IST_DAY_END_SQL}
     AND rowid <= ?`
  ).bind(body.date_from, body.date_to, body.boundary_rowid).all<{ id: string }>();

  // Delete only transactions within the date range AND at or before the boundary rowid
  const result = await c.env.DB.prepare(
    `DELETE FROM transactions
     WHERE created_at >= ${IST_DAY_START_SQL} AND created_at < ${IST_DAY_END_SQL}
     AND rowid <= ?`
  ).bind(body.date_from, body.date_to, body.boundary_rowid).run();

  // Log CDC deletions in batches
  if (toDelete.results && toDelete.results.length > 0) {
    const statements = toDelete.results.map((row) =>
      c.env.DB.prepare(
        `INSERT INTO sync_changes (entity_type, entity_id, operation, payload)
         VALUES ('transactions', ?, 'DELETE', ?)`
      ).bind(row.id, JSON.stringify({ id: row.id }))
    );
    for (let i = 0; i < statements.length; i += 50) {
      await c.env.DB.batch(statements.slice(i, i + 50));
    }
  }

  return c.json({
    success: true,
    deleted_count: result.meta.changed_db ? result.meta.changes : 0,
  });
});

export default history;
