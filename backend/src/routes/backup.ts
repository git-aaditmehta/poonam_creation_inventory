import { Hono } from 'hono';
import type { Env, SessionData } from '../types';
import { authMiddleware, ownerOnly } from '../middleware/auth';
import { paisaToRupees } from '../utils/validation';
import { IST_DAY_START_SQL, IST_DAY_END_SQL, isYmd } from '../utils/time';

type AppEnv = { Bindings: Env; Variables: { session: SessionData } };

const backup = new Hono<AppEnv>();

// All backup routes are owner-only
backup.use('*', authMiddleware, ownerOnly);

/**
 * GET /api/backup/master-data
 * Returns JSON data for Excel workbook generation on the client.
 * Sheets: Plated Jewelry, Raw Jewelry, Stones, Foil
 */
backup.get('/master-data', async (c) => {
  const platedJewelry = await c.env.DB.prepare(
    `SELECT item_id, quantity, unit, low_stock_threshold, cost_price_cents FROM plated_jewelry WHERE is_deleted = 0 ORDER BY item_id`
  ).all();

  const rawJewelry = await c.env.DB.prepare(
    `SELECT item_id, quantity, unit, low_stock_threshold FROM raw_jewelry WHERE is_deleted = 0 ORDER BY item_id`
  ).all();

  const stones = await c.env.DB.prepare(
    `SELECT item_id, quantity, unit, low_stock_threshold, cost_price_cents FROM stones WHERE is_deleted = 0 ORDER BY item_id`
  ).all();

  const foil = await c.env.DB.prepare(
    `SELECT item_id, quantity, unit, low_stock_threshold, cost_price_cents FROM foil WHERE is_deleted = 0 ORDER BY item_id`
  ).all();

  return c.json({
    plated_jewelry: (platedJewelry.results || []).map(r => ({
      item_id: r.item_id,
      quantity: r.quantity,
      unit: r.unit,
      low_stock_threshold: r.low_stock_threshold,
      cost_price: paisaToRupees(r.cost_price_cents as number),
    })),
    raw_jewelry: (rawJewelry.results || []).map(r => ({
      item_id: r.item_id,
      quantity: r.quantity,
      unit: r.unit,
      low_stock_threshold: r.low_stock_threshold,
    })),
    stones: (stones.results || []).map(r => ({
      item_id: r.item_id,
      quantity: r.quantity,
      unit: r.unit,
      low_stock_threshold: r.low_stock_threshold,
      cost_price: paisaToRupees(r.cost_price_cents as number),
    })),
    foil: (foil.results || []).map(r => ({
      item_id: r.item_id,
      quantity: r.quantity,
      unit: r.unit,
      low_stock_threshold: r.low_stock_threshold,
      cost_price: paisaToRupees(r.cost_price_cents as number),
    })),
  });
});

/**
 * GET /api/backup/transactions
 * Returns transaction data for a date range for Excel generation.
 */
backup.get('/transactions', async (c) => {
  const dateFrom = c.req.query('date_from');
  const dateTo = c.req.query('date_to');

  let whereClause = 'WHERE 1=1';
  const params: unknown[] = [];

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

  const txns = await c.env.DB.prepare(
    `SELECT * FROM transactions ${whereClause} ORDER BY created_at ASC`
  ).bind(...params).all();

  return c.json({
    transactions: txns.results || [],
    count: txns.results?.length || 0,
  });
});

/**
 * GET /api/backup/storage-usage
 * Returns D1 row counts and R2 object count for the system settings page.
 */
backup.get('/storage-usage', async (c) => {
  const tables = ['plated_jewelry', 'raw_jewelry', 'stones', 'foil', 'transactions', 'users', 'sessions'];
  const counts: Record<string, number> = {};

  for (const table of tables) {
    const result = await c.env.DB.prepare(
      `SELECT COUNT(*) as count FROM ${table}`
    ).first<{ count: number }>();
    counts[table] = result?.count || 0;
  }

  // Get D1 database size estimate & exact page size if available
  const totalRows = Object.values(counts).reduce((a, b) => a + b, 0);
  let d1SizeBytes = 0;
  try {
    const pageCountRes = await c.env.DB.prepare('PRAGMA page_count').first();
    const pageSizeRes = await c.env.DB.prepare('PRAGMA page_size').first();
    const pageCount = (pageCountRes ? Object.values(pageCountRes)[0] : 0) as number;
    const pageSize = (pageSizeRes ? Object.values(pageSizeRes)[0] : 4096) as number;
    if (pageCount && pageSize) {
      d1SizeBytes = pageCount * pageSize;
    }
  } catch {
    // Fallback if PRAGMA is restricted in certain environments
    d1SizeBytes = Math.max(65536, (totalRows * 280) + (tables.length * 4096));
  }
  if (!d1SizeBytes) {
    d1SizeBytes = Math.max(65536, (totalRows * 280) + (tables.length * 4096));
  }

  const d1TotalKb = Math.round((d1SizeBytes / 1024) * 100) / 100;
  const d1TotalMb = Math.round((d1SizeBytes / (1024 * 1024)) * 100) / 100;

  // R2: jewelry photos (plated/...) counted separately from the scanner model (models/...), all pages
  // (the old count stopped at 1,000 files and called every file an "image", the model included)
  let photoCount = 0;
  let photoBytes = 0;
  let modelBytes = 0;
  let otherCount = 0;
  let otherBytes = 0;
  try {
    let cursor: string | undefined;
    for (let page = 0; page < 50; page++) {
      const listed = await c.env.IMAGES.list({ limit: 1000, cursor });
      for (const obj of listed.objects) {
        if (obj.key.startsWith('plated/')) {
          photoCount++;
          photoBytes += obj.size;
        } else if (obj.key.startsWith('models/')) {
          modelBytes += obj.size;
        } else {
          otherCount++;
          otherBytes += obj.size;
        }
      }
      if (!listed.truncated) break;
      cursor = listed.cursor;
    }
  } catch {
    // R2 may not be enabled yet
  }
  const mbOf = (b: number) => Math.round((b / (1024 * 1024)) * 100) / 100;
  const r2TotalSize = photoBytes + modelBytes + otherBytes;

  return c.json({
    d1: {
      table_counts: counts,
      total_rows: totalRows,
      total_size_bytes: d1SizeBytes,
      total_size_kb: d1TotalKb,
      total_size_mb: d1TotalMb,
    },
    r2: {
      // Jewelry photos only (full + grid size: 2 files per item)
      photo_file_count: photoCount,
      photo_size_mb: mbOf(photoBytes),
      // The on-device scanner model, served to phones from R2 (not a photo)
      scanner_model_size_mb: mbOf(modelBytes),
      other_file_count: otherCount,
      // Everything in the bucket (kept for compatibility)
      object_count: photoCount + otherCount,
      total_size_bytes: r2TotalSize,
      total_size_mb: mbOf(r2TotalSize),
    },
  });
});

export default backup;
