/**
 * Costing in the cloud — /api/costing (owner only).
 *
 * The owner's devices keep a full local copy (works offline) and exchange changes here:
 *   POST /push    upload changed rows (newest edit wins per row)
 *   GET  /pull    download rows changed since a change number (rev)
 *   GET  /status  counts + latest change number
 *
 * Stores only what the owner types (X, categories incl. new ones, materials with prices, each design's lines).
 * Totals are recomputed on the devices from the current prices, so cloud writes stay tiny (D1 free plan:
 * 100,000 rows written per day, shared with stock operations). See migrations/0008_costing_cloud.sql.
 */
import { Hono } from 'hono';
import type { Env, SessionData } from '../types';
import { authMiddleware, ownerOnly } from '../middleware/auth';

type AppEnv = { Bindings: Env; Variables: { session: SessionData } };
const costing = new Hono<AppEnv>();
costing.use('*', authMiddleware, ownerOnly);

export type Entity = 'setting' | 'category' | 'material' | 'jewelry';
const TABLE: Record<Entity, { table: string; key: string }> = {
  setting: { table: 'costing_settings', key: 'key' },
  category: { table: 'costing_categories', key: 'id' },
  material: { table: 'costing_materials', key: 'id' },
  jewelry: { table: 'costing_jewelry', key: 'id' },
};
const SYSTEM_CATEGORY_IDS = new Set(['ad_stone', 'kundan_stone', 'mop', 'hepoxy']);
const SETTING_KEYS = new Set(['multiplier_x']);
const MAX_PUSH = 200;
const PULL_LIMIT = 2000;
const MAX_LINES = 300;
const MAX_LINES_JSON = 64 * 1024;
const ID_RE = /^[A-Za-z0-9_.:-]{1,100}$/;

export interface CloudChange {
  entity: Entity;
  id: string;
  updated_at: string;
  deleted: boolean;
  rev?: number;
  data?: Record<string, unknown>;
}

// ── Validation ───────────────────────────────────────────────────

const isNum = (v: unknown, min: number, max: number) => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
const numOrNull = (v: unknown, min: number, max: number) => v === null || v === undefined || isNum(v, min, max);
const str = (v: unknown, min: number, max: number) => typeof v === 'string' && v.trim().length >= min && v.length <= max;
const isoTime = (v: unknown) => typeof v === 'string' && v.length <= 40 && !isNaN(Date.parse(v));

/** A device clock running ahead must not make its edits win forever: never store a time later than now. */
function clampTime(t: string, nowIso: string): string {
  return Date.parse(t) > Date.parse(nowIso) ? nowIso : new Date(Date.parse(t)).toISOString();
}

interface Clean { entity: Entity; id: string; updated_at: string; deleted: boolean; row: Record<string, unknown> }

function validate(c: any, nowIso: string): Clean | string {
  if (!c || typeof c !== 'object') return 'not an object';
  const entity = c.entity as Entity;
  if (!TABLE[entity]) return 'unknown entity';
  if (typeof c.id !== 'string' || !ID_RE.test(c.id)) return 'invalid id';
  if (!isoTime(c.updated_at)) return 'invalid updated_at';
  const updated_at = clampTime(c.updated_at, nowIso);
  const deleted = c.deleted === true;
  if (deleted && entity === 'setting') return 'settings cannot be deleted';
  if (deleted && entity === 'category' && SYSTEM_CATEGORY_IDS.has(c.id)) return 'built-in categories cannot be deleted';
  if (deleted) return { entity, id: c.id, updated_at, deleted, row: {} };
  const d = c.data;
  if (!d || typeof d !== 'object') return 'missing data';
  const created_at = isoTime(d.created_at) ? clampTime(d.created_at, nowIso) : updated_at;
  switch (entity) {
    case 'setting': {
      if (!SETTING_KEYS.has(c.id)) return 'unknown setting';
      const v = typeof d.value === 'string' ? Number(d.value) : d.value;
      if (!isNum(v, 0, 10000)) return 'multiplier X must be a number between 0 and 10000';
      return { entity, id: c.id, updated_at, deleted, row: { value: (v as number).toFixed(2) } };
    }
    case 'category': {
      if (!str(d.name, 1, 120)) return 'category name must be 1-120 characters';
      const sort = d.sort_order ?? 0;
      if (!Number.isInteger(sort) || (sort as number) < 0 || (sort as number) > 100000) return 'invalid sort order';
      return {
        entity, id: c.id, updated_at, deleted,
        row: { name: (d.name as string).trim(), sort_order: sort, is_system: SYSTEM_CATEGORY_IDS.has(c.id) ? 1 : 0, created_at },
      };
    }
    case 'material': {
      if (typeof d.category_id !== 'string' || !ID_RE.test(d.category_id)) return 'invalid category';
      // Kundan stones (2026-11-22): "stone:<id>" = the costing price of a Kundan Stone section stone; other ids in
      // kundan_stone = stones added in Costing only. A stone price entry always belongs to kundan_stone.
      if (c.id.startsWith('stone:') && d.category_id !== 'kundan_stone') return 'a Kundan stone price must be in the Kundan Stone category';
      if (!str(d.name, 1, 120)) return 'material name must be 1-120 characters';
      if (!numOrNull(d.weight, 0, 1e6)) return 'invalid weight';
      if (!numOrNull(d.cost_price, 0, 1e9)) return 'invalid cost price';
      return {
        entity, id: c.id, updated_at, deleted,
        row: { category_id: d.category_id, name: (d.name as string).trim(), weight: d.weight ?? null, cost_price: d.cost_price ?? null, created_at },
      };
    }
    case 'jewelry': {
      if (!str(d.plated_jewelry_id, 1, 120)) return 'invalid jewelry item';
      if (!isNum(d.weight, 0, 1e6)) return 'invalid weight';
      if (!Array.isArray(d.lines) || d.lines.length > MAX_LINES) return `lines must be a list of at most ${MAX_LINES}`;
      const lines = [];
      for (const l of d.lines as any[]) {
        if (!l || typeof l !== 'object') return 'invalid line';
        if (!str(l.category_id, 1, 100) || !str(l.material_id, 1, 120) || !str(l.material_name, 0, 200)) return 'invalid line';
        if (!Number.isInteger(l.quantity) || l.quantity < 1 || l.quantity > 100000) return 'line quantity must be a whole number ≥ 1';
        if (!numOrNull(l.weight, 0, 1e6)) return 'invalid line weight';
        lines.push({ category_id: l.category_id, material_id: l.material_id, material_name: l.material_name, quantity: l.quantity, weight: l.weight ?? null });
      }
      const lines_json = JSON.stringify(lines);
      if (lines_json.length > MAX_LINES_JSON) return 'too many material lines';
      return { entity, id: c.id, updated_at, deleted, row: { plated_jewelry_id: d.plated_jewelry_id, weight: d.weight, lines_json, created_at } };
    }
  }
}

// ── Row <-> change ───────────────────────────────────────────────

export function toChange(entity: Entity, r: any): CloudChange {
  const base = { entity, updated_at: r.updated_at, deleted: r.deleted === 1, rev: r.rev };
  switch (entity) {
    case 'setting':
      return { ...base, id: r.key, data: { value: r.value } };
    case 'category':
      return { ...base, id: r.id, data: { name: r.name, sort_order: r.sort_order, is_system: r.is_system, created_at: r.created_at } };
    case 'material':
      return { ...base, id: r.id, data: { category_id: r.category_id, name: r.name, weight: r.weight, cost_price: r.cost_price, created_at: r.created_at } };
    case 'jewelry': {
      let lines: unknown[] = [];
      try {
        lines = JSON.parse(r.lines_json || '[]');
      } catch {
        lines = [];
      }
      return { ...base, id: r.id, data: { plated_jewelry_id: r.plated_jewelry_id, weight: r.weight, lines, created_at: r.created_at } };
    }
  }
}

function upsertStmt(db: D1Database, c: Clean, rev: number): D1PreparedStatement {
  const r = c.row;
  // The WHERE clause re-checks "newest wins" inside the database (defence in depth)
  switch (c.entity) {
    case 'setting':
      return db.prepare(
        `INSERT INTO costing_settings (key, value, updated_at, deleted, rev) VALUES (?, ?, ?, 0, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, deleted = 0, rev = excluded.rev
         WHERE excluded.updated_at >= costing_settings.updated_at`
      ).bind(c.id, r.value, c.updated_at, rev);
    case 'category':
      return db.prepare(
        `INSERT INTO costing_categories (id, name, sort_order, is_system, created_at, updated_at, deleted, rev) VALUES (?, ?, ?, ?, ?, ?, 0, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, sort_order = excluded.sort_order, is_system = excluded.is_system,
           updated_at = excluded.updated_at, deleted = 0, rev = excluded.rev
         WHERE excluded.updated_at >= costing_categories.updated_at`
      ).bind(c.id, r.name, r.sort_order, r.is_system, r.created_at, c.updated_at, rev);
    case 'material':
      return db.prepare(
        `INSERT INTO costing_materials (id, category_id, name, weight, cost_price, created_at, updated_at, deleted, rev) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)
         ON CONFLICT(id) DO UPDATE SET category_id = excluded.category_id, name = excluded.name, weight = excluded.weight,
           cost_price = excluded.cost_price, updated_at = excluded.updated_at, deleted = 0, rev = excluded.rev
         WHERE excluded.updated_at >= costing_materials.updated_at`
      ).bind(c.id, r.category_id, r.name, r.weight, r.cost_price, r.created_at, c.updated_at, rev);
    case 'jewelry':
      return db.prepare(
        `INSERT INTO costing_jewelry (id, plated_jewelry_id, weight, lines_json, created_at, updated_at, deleted, rev) VALUES (?, ?, ?, ?, ?, ?, 0, ?)
         ON CONFLICT(id) DO UPDATE SET plated_jewelry_id = excluded.plated_jewelry_id, weight = excluded.weight,
           lines_json = excluded.lines_json, updated_at = excluded.updated_at, deleted = 0, rev = excluded.rev
         WHERE excluded.updated_at >= costing_jewelry.updated_at`
      ).bind(c.id, r.plated_jewelry_id, r.weight, r.lines_json, r.created_at, c.updated_at, rev);
  }
}

function tombstoneStmt(db: D1Database, c: Clean, rev: number): D1PreparedStatement {
  const { table, key } = TABLE[c.entity];
  return db.prepare(`UPDATE ${table} SET deleted = 1, updated_at = ?, rev = ? WHERE ${key} = ? AND updated_at <= ?`)
    .bind(c.updated_at, rev, c.id, c.updated_at);
}

async function readRows(db: D1Database, entity: Entity, ids: string[]): Promise<Map<string, any>> {
  const out = new Map<string, any>();
  if (!ids.length) return out;
  const { table, key } = TABLE[entity];
  for (let i = 0; i < ids.length; i += 90) {
    const chunk = ids.slice(i, i + 90);
    const { results } = await db.prepare(`SELECT * FROM ${table} WHERE ${key} IN (${chunk.map(() => '?').join(',')})`).bind(...chunk).all();
    for (const r of results || []) out.set((r as any)[key], r);
  }
  return out;
}

// ── POST /push ───────────────────────────────────────────────────

costing.post('/push', async (c) => {
  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }
  const changes = Array.isArray(body?.changes) ? body.changes : null;
  if (!changes) return c.json({ error: 'changes[] is required' }, 400);
  if (changes.length > MAX_PUSH) return c.json({ error: `At most ${MAX_PUSH} changes per upload` }, 400);

  const nowIso = new Date().toISOString();
  const skipped: { entity?: string; id?: string; reason: string; merged_into?: string; current?: CloudChange }[] = [];
  const valid: Clean[] = [];
  for (const raw of changes) {
    const v = validate(raw, nowIso);
    if (typeof v === 'string') skipped.push({ entity: raw?.entity, id: raw?.id, reason: v });
    else valid.push(v);
  }

  // Current server rows for everything in this upload (few reads instead of one per row)
  const existing: Record<Entity, Map<string, any>> = {
    setting: await readRows(c.env.DB, 'setting', valid.filter((v) => v.entity === 'setting').map((v) => v.id)),
    category: await readRows(c.env.DB, 'category', valid.filter((v) => v.entity === 'category').map((v) => v.id)),
    material: await readRows(c.env.DB, 'material', valid.filter((v) => v.entity === 'material').map((v) => v.id)),
    jewelry: await readRows(c.env.DB, 'jewelry', valid.filter((v) => v.entity === 'jewelry').map((v) => v.id)),
  };

  const winners: Clean[] = [];
  const applied: { entity: Entity; id: string }[] = [];
  for (const v of valid) {
    const cur = existing[v.entity].get(v.id);
    if (cur && cur.updated_at > v.updated_at) {
      // Another device changed it more recently: tell this device what the cloud has now
      skipped.push({ entity: v.entity, id: v.id, reason: 'newer change in the cloud', current: toChange(v.entity, cur) });
      continue;
    }
    if (v.deleted) {
      if (!cur || cur.deleted === 1) {
        applied.push({ entity: v.entity, id: v.id }); // nothing (left) to delete
        continue;
      }
    } else if (v.entity === 'material' && !v.id.startsWith('stone:')) {
      // The same material (category + name, capitals ignored) must exist only once. Kundan stone price entries are
      // tied to their stone (not to a name), so they are left out of this rule.
      const dup = await c.env.DB.prepare(
        `SELECT * FROM costing_materials WHERE category_id = ? AND LOWER(name) = LOWER(?) AND deleted = 0 AND id != ? AND id NOT LIKE 'stone:%' LIMIT 1`
      ).bind(v.row.category_id, v.row.name, v.id).first<any>();
      if (dup) {
        if (!cur) {
          skipped.push({ entity: 'material', id: v.id, reason: 'already exists', merged_into: dup.id, current: toChange('material', dup) });
        } else {
          skipped.push({ entity: 'material', id: v.id, reason: `another material is already called "${dup.name}"`, current: toChange('material', cur) });
        }
        continue;
      }
    }
    winners.push(v);
  }

  let rev = 0;
  if (winners.length) {
    const seq = await c.env.DB.prepare('INSERT INTO costing_seq DEFAULT VALUES').run();
    rev = Number(seq.meta.last_row_id);
    const stmts = winners.map((v) => (v.deleted ? tombstoneStmt(c.env.DB, v, rev) : upsertStmt(c.env.DB, v, rev)));
    for (let i = 0; i < stmts.length; i += 50) {
      await c.env.DB.batch(stmts.slice(i, i + 50));
    }
    for (const v of winners) applied.push({ entity: v.entity, id: v.id });
  }
  return c.json({ success: true, rev, applied, skipped });
});

// ── GET /pull?since=<rev> ────────────────────────────────────────

costing.get('/pull', async (c) => {
  const since = Math.max(0, parseInt(c.req.query('since') || '0', 10) || 0);
  const rows: CloudChange[] = [];
  for (const entity of Object.keys(TABLE) as Entity[]) {
    const { results } = await c.env.DB.prepare(
      `SELECT * FROM ${TABLE[entity].table} WHERE rev > ? ORDER BY rev ASC LIMIT ?`
    ).bind(since, PULL_LIMIT).all();
    for (const r of results || []) rows.push(toChange(entity, r));
  }
  rows.sort((a, b) => (a.rev ?? 0) - (b.rev ?? 0));
  let page = rows;
  let hasMore = false;
  if (rows.length > PULL_LIMIT) {
    // Never split one upload batch (same rev) across pages
    page = rows.slice(0, PULL_LIMIT);
    const lastRev = page[page.length - 1].rev ?? 0;
    const trimmed = page.filter((r) => (r.rev ?? 0) < lastRev);
    page = trimmed.length ? trimmed : page;
    hasMore = true;
  }
  const latest = await c.env.DB.prepare('SELECT COALESCE(MAX(id), 0) AS rev FROM costing_seq').first<{ rev: number }>();
  const nextSince = page.length ? page[page.length - 1].rev ?? since : since;
  return c.json({ changes: page, next_since: nextSince, has_more: hasMore, latest_rev: latest?.rev ?? 0 });
});

// ── GET /status ──────────────────────────────────────────────────

costing.get('/status', async (c) => {
  const count = async (t: string) =>
    (await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE deleted = 0`).first<{ n: number }>())?.n ?? 0;
  const latest = await c.env.DB.prepare('SELECT COALESCE(MAX(id), 0) AS rev FROM costing_seq').first<{ rev: number }>();
  return c.json({
    latest_rev: latest?.rev ?? 0,
    categories: await count('costing_categories'),
    materials: await count('costing_materials'),
    designs: await count('costing_jewelry'),
  });
});

export default costing;
