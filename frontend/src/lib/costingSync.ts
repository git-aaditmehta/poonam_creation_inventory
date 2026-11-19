/**
 * Costing cloud sync (owner devices only).
 *
 * Costing stays fully usable on this device (offline too). Every row the owner changes is listed in
 * costing_dirty (lib/costingDb.ts); this module uploads those rows (newest edit wins in the cloud) and downloads
 * what other devices changed. Only typed values travel: totals are recomputed here from the current prices.
 *
 * Runs: on start, every 30 s, when back online, and ~1 s after any Costing edit.
 * Staff devices never run it (the API refuses them) and never keep Costing data.
 */
import { api } from '../api';
import { localDb } from './localDb';
import { getCostingMultiplierX, recalculateSingleJewelryCosting, type CostingEntity } from './costingDb';
import { isDailyLimitError, dailyLimitMessage, errorText } from '../utils/friendlyErrors';

const BATCH = 200;
const FRESH_START_MARKER = 'costing_cloud_start_v1';
const CURSOR_KEY = 'costing_rev';

export interface CostingSyncState {
  active: boolean; // owner signed in on this device
  needsFreshStart: boolean; // one-time "start fresh" choice still pending on this device
  syncing: boolean;
  waiting: number; // changes on this device not yet in the cloud
  lastSyncedAt: string | null;
  error: string | null; // last problem worth showing (not "offline")
  dailyLimit: boolean;
}

let state: CostingSyncState = { active: false, needsFreshStart: false, syncing: false, waiting: 0, lastSyncedAt: null, error: null, dailyLimit: false };
const listeners = new Set<(s: CostingSyncState) => void>();
let timer: ReturnType<typeof setInterval> | null = null;
let debounce: ReturnType<typeof setTimeout> | null = null;
let running: Promise<void> | null = null;
let again = false;

function set(patch: Partial<CostingSyncState>) {
  state = { ...state, ...patch };
  for (const l of listeners) {
    try {
      l(state);
    } catch {
      /* ignore */
    }
  }
}

export function subscribeCostingSync(fn: (s: CostingSyncState) => void): () => void {
  listeners.add(fn);
  fn(state);
  return () => listeners.delete(fn);
}

function notice(type: 'success' | 'info' | 'warning' | 'error', title: string, message: string) {
  window.dispatchEvent(new CustomEvent('costing-notice', { detail: { type, title, message } }));
}

function changed() {
  window.dispatchEvent(new CustomEvent('costing-change'));
}

async function refreshWaiting() {
  try {
    const row = await localDb.get<{ n: number }>('SELECT COUNT(*) AS n FROM costing_dirty');
    set({ waiting: row?.n ?? 0 });
  } catch {
    /* ignore */
  }
}

export async function costingWaitingCount(): Promise<number> {
  await refreshWaiting();
  return state.waiting;
}

// ── One-time "start fresh in the cloud" ──────────────────────────

const getMarker = () => {
  try {
    return localStorage.getItem(FRESH_START_MARKER);
  } catch {
    return '1'; // storage blocked: never block Costing behind the panel
  }
};
const setMarker = () => {
  try {
    localStorage.setItem(FRESH_START_MARKER, new Date().toISOString());
  } catch {
    /* ignore */
  }
};

/** Does this device still hold Costing data from before the cloud version (and no choice was made yet)? */
async function deviceHasOldCostingData(): Promise<boolean> {
  if (getMarker()) return false;
  const n = async (sql: string) => (await localDb.get<{ n: number }>(sql))?.n ?? 0;
  const has =
    (await n('SELECT COUNT(*) AS n FROM jewelry_costing')) > 0 ||
    (await n('SELECT COUNT(*) AS n FROM costing_materials WHERE is_deleted = 0')) > 0 ||
    (await n('SELECT COUNT(*) AS n FROM costing_categories WHERE is_system = 0')) > 0 ||
    (await n("SELECT COUNT(*) AS n FROM costing_settings WHERE key = 'multiplier_x' AND value != '18.00'")) > 0;
  if (!has) setMarker(); // nothing to clear: start syncing straight away
  return has;
}

/** Remove this device's Costing copy (keeps the 4 default categories). Used by "start fresh" and at logout. */
export async function clearLocalCosting(): Promise<void> {
  await localDb.ready;
  for (const sql of [
    'DELETE FROM jewelry_costing_materials',
    'DELETE FROM jewelry_costing',
    'DELETE FROM costing_materials',
    'DELETE FROM costing_categories WHERE is_system = 0',
    'DELETE FROM costing_dirty',
  ]) {
    await localDb.exec(sql);
  }
  // Old timestamp: a value already in the cloud always replaces this default on the next download
  await localDb.exec("INSERT OR REPLACE INTO costing_settings (key, value, updated_at) VALUES ('multiplier_x', '18.00', '1970-01-01T00:00:00.000Z')");
  await localDb.setSyncState(CURSOR_KEY, '0');
  await refreshWaiting();
  changed();
}

/** The owner chose "Clear and start fresh" (after optionally downloading an Excel backup). */
export async function startFreshInCloud(): Promise<void> {
  await clearLocalCosting();
  setMarker();
  set({ needsFreshStart: false });
  await syncCostingNow();
}

// ── Upload ───────────────────────────────────────────────────────

async function buildChange(entity: CostingEntity, id: string, updated_at: string): Promise<any | null> {
  switch (entity) {
    case 'setting': {
      const r = await localDb.get<{ value: string }>('SELECT value FROM costing_settings WHERE key = ?', [id]);
      return r ? { entity, id, updated_at, deleted: false, data: { value: r.value } } : null;
    }
    case 'category': {
      const r = await localDb.get<any>('SELECT * FROM costing_categories WHERE id = ?', [id]);
      if (!r) return { entity, id, updated_at, deleted: true };
      return { entity, id, updated_at, deleted: false, data: { name: r.name, sort_order: Number(r.sort_order) || 0, created_at: r.created_at || updated_at } };
    }
    case 'material': {
      const r = await localDb.get<any>('SELECT * FROM costing_materials WHERE id = ?', [id]);
      if (!r || r.is_deleted) return { entity, id, updated_at, deleted: true };
      return {
        entity, id, updated_at, deleted: false,
        data: {
          category_id: r.category_id,
          name: r.name,
          weight: r.weight === null || r.weight === undefined ? null : Number(r.weight),
          cost_price: r.cost_price === null || r.cost_price === undefined ? null : Number(r.cost_price),
          created_at: r.created_at || updated_at,
        },
      };
    }
    case 'jewelry': {
      const r = await localDb.get<any>('SELECT * FROM jewelry_costing WHERE id = ?', [id]);
      if (!r) return { entity, id, updated_at, deleted: true };
      const lines = await localDb.query<any>(
        'SELECT category_id, material_id, material_name, quantity, weight FROM jewelry_costing_materials WHERE jewelry_costing_id = ? ORDER BY rowid',
        [id]
      );
      return {
        entity, id, updated_at, deleted: false,
        data: {
          plated_jewelry_id: r.plated_jewelry_id,
          weight: Number(r.weight) || 0,
          created_at: r.created_at || updated_at,
          lines: lines.map((l) => ({
            category_id: l.category_id,
            material_id: l.material_id,
            material_name: l.material_name || '',
            quantity: Math.max(1, Math.round(Number(l.quantity) || 1)),
            weight: l.weight === null || l.weight === undefined ? null : Number(l.weight),
          })),
        },
      };
    }
  }
}

const clearDirty = (entity: string, id: string, updated_at: string) =>
  localDb.exec('DELETE FROM costing_dirty WHERE entity = ? AND id = ? AND updated_at = ?', [entity, id, updated_at]);

async function upload(): Promise<void> {
  for (let round = 0; round < 50; round++) {
    const dirty = await localDb.query<{ entity: CostingEntity; id: string; updated_at: string }>(
      'SELECT entity, id, updated_at FROM costing_dirty ORDER BY updated_at LIMIT ?',
      [BATCH]
    );
    if (!dirty.length) return;
    const changes = [];
    const sentAt = new Map<string, string>();
    for (const d of dirty) {
      const c = await buildChange(d.entity, d.id, d.updated_at);
      if (!c) {
        await clearDirty(d.entity, d.id, d.updated_at);
        continue;
      }
      changes.push(c);
      sentAt.set(`${d.entity}:${d.id}`, d.updated_at);
    }
    if (!changes.length) continue;
    const res = await api.costing.push(changes);
    for (const a of res.applied) await clearDirty(a.entity, a.id, sentAt.get(`${a.entity}:${a.id}`) || '');
    let touched = false;
    for (const sk of res.skipped) {
      const key = `${sk.entity}:${sk.id}`;
      const at = sentAt.get(key) || '';
      if (sk.merged_into && sk.id) {
        // The same material was created on another device first: use that one everywhere on this device
        const dupName = (await localDb.get<{ name: string }>('SELECT name FROM costing_materials WHERE id = ?', [sk.id]))?.name || 'Material';
        await mergeLocalMaterial(sk.id, sk.merged_into);
        if (sk.current) await applyCloudChange(sk.current);
        await clearDirty('material', sk.id, at);
        notice('info', 'Material merged', `"${dupName}" already existed in the cloud, so both copies are now one.`);
        touched = true;
      } else if (sk.current) {
        // A newer change from another device won, or a rename clashed: show the cloud version
        await applyCloudChange(sk.current);
        await clearDirty(sk.entity || '', sk.id || '', at);
        if (/already called/.test(sk.reason)) notice('warning', 'Rename not saved', `${sk.reason}. The name was changed back.`);
        touched = true;
      } else {
        // Refused as invalid: keep it on this device, stop retrying, and say so
        await clearDirty(sk.entity || '', sk.id || '', at);
        notice('error', 'Costing change not saved to the cloud', `${sk.reason}. It is still saved on this device.`);
      }
    }
    if (touched) changed();
  }
}

/** Re-point design lines from a duplicate material to the existing one, then remove the duplicate. */
async function mergeLocalMaterial(fromId: string, toId: string): Promise<void> {
  if (fromId === toId) return;
  const affected = await localDb.query<{ jewelry_costing_id: string }>(
    'SELECT DISTINCT jewelry_costing_id FROM jewelry_costing_materials WHERE material_id = ?',
    [fromId]
  );
  await localDb.exec('UPDATE jewelry_costing_materials SET material_id = ? WHERE material_id = ?', [toId, fromId]);
  await localDb.exec('DELETE FROM costing_materials WHERE id = ?', [fromId]);
  const now = new Date().toISOString();
  for (const a of affected) {
    // Their lines changed: upload them again
    await localDb.exec(
      `INSERT INTO costing_dirty (entity, id, updated_at) VALUES ('jewelry', ?, ?)
       ON CONFLICT(entity, id) DO UPDATE SET updated_at = excluded.updated_at`,
      [a.jewelry_costing_id, now]
    );
  }
}

// ── Download ─────────────────────────────────────────────────────

async function isDirty(entity: string, id: string): Promise<boolean> {
  return Boolean(await localDb.get('SELECT 1 AS x FROM costing_dirty WHERE entity = ? AND id = ?', [entity, id]));
}

const isUnique = (e: unknown) => /UNIQUE constraint failed/i.test(String((e as any)?.message || e));

/** Apply one row from the cloud to this device (no "needs uploading" mark: it came from the cloud). */
async function applyCloudChange(c: any): Promise<void> {
  const d = c.data || {};
  switch (c.entity as CostingEntity) {
    case 'setting':
      if (!c.deleted) {
        await localDb.exec('INSERT OR REPLACE INTO costing_settings (key, value, updated_at) VALUES (?, ?, ?)', [c.id, String(d.value), c.updated_at]);
      }
      return;
    case 'category': {
      if (c.deleted) {
        await localDb.exec('DELETE FROM costing_categories WHERE id = ? AND is_system = 0', [c.id]);
        return;
      }
      const up = () =>
        localDb.exec(
          `INSERT INTO costing_categories (id, name, sort_order, is_system, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET name = excluded.name, sort_order = excluded.sort_order, is_system = excluded.is_system, updated_at = excluded.updated_at`,
          [c.id, d.name, d.sort_order ?? 0, d.is_system ? 1 : 0, d.created_at || c.updated_at, c.updated_at]
        );
      try {
        await up();
      } catch (e) {
        if (!isUnique(e)) throw e;
        // Same category name created on two devices: keep the cloud one, move this device's materials and lines to it
        const other = await localDb.get<{ id: string }>('SELECT id FROM costing_categories WHERE LOWER(name) = LOWER(?) AND id != ?', [d.name, c.id]);
        if (!other) throw e;
        await localDb.exec('UPDATE costing_materials SET category_id = ? WHERE category_id = ?', [c.id, other.id]);
        await localDb.exec('UPDATE jewelry_costing_materials SET category_id = ? WHERE category_id = ?', [c.id, other.id]);
        await localDb.exec('DELETE FROM costing_categories WHERE id = ?', [other.id]);
        await up();
      }
      return;
    }
    case 'material': {
      if (c.deleted) {
        await localDb.exec('UPDATE costing_materials SET is_deleted = 1, updated_at = ? WHERE id = ?', [c.updated_at, c.id]);
        return;
      }
      const up = () =>
        localDb.exec(
          `INSERT INTO costing_materials (id, category_id, name, weight, cost_price, is_deleted, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?)
           ON CONFLICT(id) DO UPDATE SET category_id = excluded.category_id, name = excluded.name, weight = excluded.weight,
             cost_price = excluded.cost_price, is_deleted = 0, updated_at = excluded.updated_at`,
          [c.id, d.category_id, d.name, d.weight ?? null, d.cost_price ?? null, d.created_at || c.updated_at, c.updated_at]
        );
      try {
        await up();
      } catch (e) {
        if (!isUnique(e)) throw e;
        const other = await localDb.get<{ id: string }>(
          'SELECT id FROM costing_materials WHERE category_id = ? AND LOWER(name) = LOWER(?) AND is_deleted = 0 AND id != ?',
          [d.category_id, d.name, c.id]
        );
        if (!other) throw e;
        await mergeLocalMaterial(other.id, c.id);
        await up();
      }
      return;
    }
    case 'jewelry': {
      if (c.deleted) {
        await localDb.exec('DELETE FROM jewelry_costing_materials WHERE jewelry_costing_id = ?', [c.id]);
        await localDb.exec('DELETE FROM jewelry_costing WHERE id = ?', [c.id]);
        return;
      }
      const up = () =>
        localDb.exec(
          `INSERT INTO jewelry_costing (id, plated_jewelry_id, weight, cached_total_cost, is_complete, created_at, updated_at) VALUES (?, ?, ?, 0, 0, ?, ?)
           ON CONFLICT(id) DO UPDATE SET plated_jewelry_id = excluded.plated_jewelry_id, weight = excluded.weight, updated_at = excluded.updated_at`,
          [c.id, d.plated_jewelry_id, Number(d.weight) || 0, d.created_at || c.updated_at, c.updated_at]
        );
      try {
        await up();
      } catch (e) {
        if (!isUnique(e)) throw e;
        // The same jewelry item was costed on two devices: the cloud version replaces this device's one
        const other = await localDb.get<{ id: string }>('SELECT id FROM jewelry_costing WHERE plated_jewelry_id = ? AND id != ?', [d.plated_jewelry_id, c.id]);
        if (!other) throw e;
        await localDb.exec('DELETE FROM jewelry_costing_materials WHERE jewelry_costing_id = ?', [other.id]);
        await localDb.exec('DELETE FROM jewelry_costing WHERE id = ?', [other.id]);
        await localDb.exec('DELETE FROM costing_dirty WHERE entity = ? AND id = ?', ['jewelry', other.id]);
        await up();
      }
      await localDb.exec('DELETE FROM jewelry_costing_materials WHERE jewelry_costing_id = ?', [c.id]);
      const lines: any[] = Array.isArray(d.lines) ? d.lines : [];
      for (let i = 0; i < lines.length; i++) {
        const l = lines[i];
        await localDb.exec(
          `INSERT INTO jewelry_costing_materials (id, jewelry_costing_id, category_id, material_id, material_name, quantity, unit_cost, extended_cost, weight, created_at)
           VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)`,
          [`${c.id}_l${i}`, c.id, l.category_id, l.material_id, l.material_name || '', l.quantity || 1, l.weight ?? null, c.updated_at]
        );
      }
      await recalculateSingleJewelryCosting(c.id, await getCostingMultiplierX());
      return;
    }
  }
}

async function download(): Promise<void> {
  let since = Number((await localDb.getSyncState(CURSOR_KEY)) || 0) || 0;
  let appliedAny = false;
  for (let page = 0; page < 200; page++) {
    const res = await api.costing.pull(since);
    for (const c of res.changes) {
      if (await isDirty(c.entity, c.id)) continue; // this device has a newer unsent edit: the upload decides
      await applyCloudChange(c);
      appliedAny = true;
    }
    since = res.has_more ? res.next_since : Math.max(res.next_since, res.latest_rev);
    await localDb.setSyncState(CURSOR_KEY, String(since));
    if (!res.has_more) break;
  }
  if (appliedAny) changed();
}

// ── Running ──────────────────────────────────────────────────────

async function runOnce(): Promise<void> {
  if (!state.active || state.needsFreshStart) return;
  await localDb.ready;
  await refreshWaiting();
  if (!navigator.onLine) {
    set({ error: null });
    return;
  }
  set({ syncing: true });
  try {
    await upload();
    await download();
    set({ lastSyncedAt: new Date().toISOString(), error: null, dailyLimit: false });
  } catch (err: any) {
    const offline = !navigator.onLine || /Failed to fetch|Load failed|NetworkError/i.test(String(err?.message || ''));
    if (isDailyLimitError(err)) {
      set({ error: dailyLimitMessage(err), dailyLimit: true });
      window.dispatchEvent(new CustomEvent('cloud-daily-limit', { detail: err.data }));
    } else if (err?.status === 401 || err?.status === 403) {
      set({ error: null }); // the app handles sign-in; changes stay waiting
    } else if (!offline) {
      set({ error: errorText(err) });
    }
  } finally {
    set({ syncing: false });
    await refreshWaiting();
  }
}

/** Upload and download now (safe to call often: runs one at a time). */
export function syncCostingNow(): Promise<void> {
  if (running) {
    again = true;
    return running;
  }
  running = runOnce().finally(() => {
    running = null;
    if (again) {
      again = false;
      syncCostingNow();
    }
  });
  return running;
}

const onDirty = () => {
  refreshWaiting();
  if (debounce) clearTimeout(debounce);
  debounce = setTimeout(() => syncCostingNow(), 1000);
};
const onOnline = () => syncCostingNow();

/** Start syncing on this device (call only for the owner). */
export async function startCostingSync(): Promise<void> {
  if (state.active) return;
  await localDb.ready;
  set({ active: true, needsFreshStart: await deviceHasOldCostingData() });
  window.addEventListener('costing-dirty', onDirty);
  window.addEventListener('online', onOnline);
  timer = setInterval(() => syncCostingNow(), 30_000);
  syncCostingNow();
}

export function stopCostingSync(): void {
  set({ active: false, syncing: false });
  window.removeEventListener('costing-dirty', onDirty);
  window.removeEventListener('online', onOnline);
  if (timer) clearInterval(timer);
  if (debounce) clearTimeout(debounce);
  timer = null;
  debounce = null;
}

/** Re-download everything from the cloud (Force re-sync). Changes waiting on this device are kept and sent. */
export async function redownloadCosting(): Promise<void> {
  if (!state.active) return;
  await localDb.setSyncState(CURSOR_KEY, '0');
  await syncCostingNow();
}
