import { Hono } from 'hono';
import type { Env, SessionData } from '../types';
import { authMiddleware, ownerOnly } from '../middleware/auth';
import { listJewelryTypes, PREFIX_RE } from '../utils/jewelryCategory';

type AppEnv = { Bindings: Env; Variables: { session: SessionData } };

/**
 * Jewelry types (agreed 2026-11-21): GET the list (everyone; phones keep a copy for offline use);
 * POST a new one (owner). Types are only added, never renamed or removed here, so no item ever changes group
 * unexpectedly. Not related to Costing categories.
 */
const jc = new Hono<AppEnv>();
jc.use('*', authMiddleware);

jc.get('/', async (c) => {
  const types = await listJewelryTypes(c.env.DB);
  return c.json({ types: types.map((t) => ({ prefix: t.prefix, name: t.name })) });
});

jc.post('/', ownerOnly, async (c) => {
  const body = await c.req.json<{ name?: unknown; prefix?: unknown }>().catch(() => null);
  const name = typeof body?.name === 'string' ? body.name.trim().replace(/\s+/g, ' ') : '';
  const prefix = typeof body?.prefix === 'string' ? body.prefix.trim().toUpperCase() : '';
  if (!name) return c.json({ error: 'Type a name for the jewelry type (e.g. Necklace set).' }, 400);
  if (name.length > 40) return c.json({ error: 'The name is too long (at most 40 characters).' }, 400);
  if (!PREFIX_RE.test(prefix)) {
    return c.json({ error: 'The code letters must be 1 to 5 letters A–Z only (e.g. NK), no numbers, spaces or symbols.' }, 400);
  }
  const types = await listJewelryTypes(c.env.DB);
  const samePrefix = types.find((t) => t.prefix === prefix);
  if (samePrefix) return c.json({ error: `The letters ${prefix} are already used by "${samePrefix.name}". Choose different letters.` }, 409);
  const sameName = types.find((t) => t.name.toLowerCase() === name.toLowerCase());
  if (sameName) return c.json({ error: `"${sameName.name}" already exists (letters ${sameName.prefix}).` }, 409);
  const order = types.reduce((m, t) => Math.max(m, t.sort_order), 0) + 1;
  await c.env.DB.prepare('INSERT INTO jewelry_categories (prefix, name, sort_order, scan_tagged) VALUES (?, ?, ?, 0)').bind(prefix, name, order).run();
  // How many existing designs already start with these letters (they now appear under the new type)
  const glob = `${prefix}[^A-Z]*`;
  const count = async (table: string) =>
    (await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE is_deleted = 0 AND (UPPER(TRIM(item_id)) = ? OR UPPER(TRIM(item_id)) GLOB ?)`)
      .bind(prefix, glob)
      .first<{ n: number }>())?.n ?? 0;
  const [plated, raw] = await Promise.all([count('plated_jewelry'), count('raw_jewelry')]);
  const all = await listJewelryTypes(c.env.DB);
  return c.json({ added: { prefix, name }, existing: { plated, raw }, types: all.map((t) => ({ prefix: t.prefix, name: t.name })) }, 201);
});

export default jc;
