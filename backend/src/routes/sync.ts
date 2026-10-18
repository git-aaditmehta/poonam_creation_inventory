import { Hono } from 'hono';
import type { Env, SessionData } from '../types';
import { authMiddleware } from '../middleware/auth';
import { paisaToRupees } from '../utils/validation';

type AppEnv = { Bindings: Env; Variables: { session: SessionData } };

const sync = new Hono<AppEnv>();

/**
 * Helper: map a DB row to the format clients expect.
 * Converts cost_price_cents → cost_price (rupees) for owner role.
 */
function mapItemForSync(row: Record<string, unknown>, hasCost: boolean, role: string): Record<string, unknown> {
  const item: Record<string, unknown> = { ...row };
  if (hasCost && role === 'owner') {
    item.cost_price = paisaToRupees(row.cost_price_cents as number);
  }
  item.is_low_stock = (row.quantity as number) < (row.low_stock_threshold as number);
  return item;
}

/**
 * GET /api/sync/bootstrap
 * 
 * Returns ALL current inventory data + recent transactions + latest seq number.
 * Called once on first load or force re-sync.
 */
sync.get('/bootstrap', authMiddleware, async (c) => {
  const session = c.get('session');
  const role = session.role;

  // Fetch all inventory data
  const [platedRes, rawRes, stonesRes, foilRes, txRes, seqRes] = await Promise.all([
    c.env.DB.prepare('SELECT * FROM plated_jewelry WHERE is_deleted = 0 ORDER BY item_id ASC').all(),
    c.env.DB.prepare('SELECT * FROM raw_jewelry WHERE is_deleted = 0 ORDER BY item_id ASC').all(),
    c.env.DB.prepare('SELECT * FROM stones WHERE is_deleted = 0 ORDER BY item_id ASC').all(),
    c.env.DB.prepare('SELECT * FROM foil WHERE is_deleted = 0 ORDER BY item_id ASC').all(),
    // Recent transactions (last 500)
    c.env.DB.prepare('SELECT * FROM transactions ORDER BY created_at DESC LIMIT 500').all(),
    // Latest sequence number
    c.env.DB.prepare('SELECT COALESCE(MAX(seq), 0) as latest_seq FROM sync_changes').first<{ latest_seq: number }>(),
  ]);

  const plated = (platedRes.results || []).map(r => mapItemForSync(r, true, role));
  const raw = (rawRes.results || []).map(r => mapItemForSync(r, false, role));
  const stones = (stonesRes.results || []).map(r => mapItemForSync(r, true, role));
  const foil = (foilRes.results || []).map(r => mapItemForSync(r, true, role));
  const transactions = txRes.results || [];

  return c.json({
    plated_jewelry: plated,
    raw_jewelry: raw,
    stones,
    foil,
    transactions,
    latest_seq: seqRes?.latest_seq ?? 0,
  });
});

/**
 * GET /api/sync/changes?after={seq}&limit={limit}
 * 
 * Returns incremental CDC changes after the given sequence number.
 * Clients call this repeatedly until they get fewer than `limit` results.
 */
sync.get('/changes', authMiddleware, async (c) => {
  const session = c.get('session');
  const role = session.role;
  const after = parseInt(c.req.query('after') || '0', 10);
  const limit = Math.min(500, Math.max(1, parseInt(c.req.query('limit') || '500', 10)));

  const result = await c.env.DB.prepare(
    'SELECT * FROM sync_changes WHERE seq > ? ORDER BY seq ASC LIMIT ?'
  ).bind(after, limit).all();

  const changes = (result.results || []).map((row: any) => {
    // For CREATE/UPDATE operations, re-map the payload to include computed fields
    if (row.operation !== 'DELETE' && row.payload) {
      try {
        const payload = JSON.parse(row.payload);
        const hasCost = ['plated_jewelry', 'stones', 'foil'].includes(row.entity_type);
        
        if (hasCost && role === 'owner' && payload.cost_price_cents !== undefined) {
          payload.cost_price = paisaToRupees(payload.cost_price_cents);
        }
        if (payload.quantity !== undefined && payload.low_stock_threshold !== undefined) {
          payload.is_low_stock = payload.quantity < payload.low_stock_threshold;
        }
        
        return { ...row, payload: JSON.stringify(payload) };
      } catch {
        return row;
      }
    }
    return row;
  });

  return c.json({ changes });
});

export default sync;
