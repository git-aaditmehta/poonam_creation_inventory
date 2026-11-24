/**
 * Undo a stock movement (agreed 2026-11-21). The cloud records the opposite movement, linked to the original
 * (backend/src/routes/stock.ts /undo); this phone's copy is updated at once and then synced.
 * Rules (same as the server): staff undo their own movements, the owner anyone's; within 7 days; once;
 * an undo itself can't be undone; needs internet.
 */
import { api } from '../api';
import { localDb } from './localDb';
import { syncEngine } from './syncEngine';
import { getAllPendingOps } from './pendingOps';
import { errorText } from '../utils/friendlyErrors';
import type { Transaction, User } from '../types';

export const UNDO_DAYS = 7;

/** Why this user can't undo this movement, or null if they can. */
export function undoBlockedReason(tx: Pick<Transaction, 'reverses_id' | 'undone_by' | 'created_at' | 'performed_by' | 'performer_name'>, user: User | null): string | null {
  if (!user) return 'Log in to undo.';
  if (tx.reverses_id) return 'This entry is an undo.';
  if (tx.undone_by) return `Already undone by ${tx.undone_by}.`;
  const t = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(tx.created_at) ? tx.created_at : tx.created_at.replace(' ', 'T') + 'Z');
  if (Number.isFinite(t) && Date.now() - t > UNDO_DAYS * 86400000) return `Older than ${UNDO_DAYS} days.`;
  if (user.role !== 'owner' && tx.performed_by !== user.id) return `Only ${tx.performer_name} or the owner can undo this.`;
  return null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Undo; returns the message and the cloud's exact new balance. Throws an Error with a plain-words message if it can't be done. */
export async function undoStockOperation(ref: { transaction_id?: string; idempotency_key?: string }): Promise<{ message: string; newBalance: number; unit: string }> {
  if (!navigator.onLine) throw new Error('Undo needs internet, because it changes the stock in the cloud. Connect and try again.');
  let res: Awaited<ReturnType<typeof api.stock.undo>> | null = null;
  for (let attempt = 0; attempt < 6 && !res; attempt++) {
    try {
      res = await api.stock.undo(ref);
    } catch (err: any) {
      // A just-made operation may still be on its way to the cloud: send it now and try again
      const stillSending = err?.data?.code === 'not_in_cloud' && ref.idempotency_key &&
        (await getAllPendingOps().catch(() => [])).some((op: any) => op.idempotency_key === ref.idempotency_key);
      if (stillSending && attempt < 5) {
        syncEngine.triggerSync().catch(() => undefined);
        await sleep(1500);
        continue;
      }
      throw new Error(errorText(err));
    }
  }
  if (!res) throw new Error('The operation has not reached the cloud yet. Wait a moment and try Undo again.');
  // This phone's copy at once (the sync brings the history entry)
  try {
    const table = ['plated_jewelry', 'raw_jewelry', 'stones', 'foil'].includes(res.category) ? res.category : null;
    if (table) {
      await localDb.exec(`UPDATE ${table} SET quantity = ?, updated_at = ? WHERE id = ?`, [res.new_balance, new Date().toISOString(), res.item_uuid]);
      window.dispatchEvent(new CustomEvent('localdb-change', { detail: { store: table } }));
    }
  } catch {
    /* the next sync corrects it */
  }
  syncEngine.triggerSync().catch(() => undefined);
  return { message: res.message, newBalance: res.new_balance, unit: res.unit };
}

/**
 * A cheap fingerprint of this phone's copy of the stock history (how many movements, the newest one). Screens that
 * show the cloud's history compare it after each sync and ask the cloud again only when it changed: a new movement
 * (from any phone, including an undo) always reaches this copy through the sync (agreed 2026-11-24, saves the
 * free daily cloud reads). Never throws; '' when unknown (= ask the cloud).
 */
export async function localHistorySignature(itemUuid?: string): Promise<string> {
  try {
    // p = movements made on this phone that still carry their temporary id ("tx_…"): it drops when the cloud's id
    // replaces it, so the screen also refreshes once this phone's own movement has reached the cloud
    const r = await localDb.get<{ n: number; m: string | null; p: number | null }>(
      `SELECT COUNT(*) AS n, MAX(created_at) AS m, SUM(CASE WHEN id LIKE 'tx_%' THEN 1 ELSE 0 END) AS p
       FROM transactions${itemUuid ? ' WHERE item_id = ?' : ''}`,
      itemUuid ? [itemUuid] : [],
    );
    return r ? `${r.n}|${r.m ?? ''}|${r.p ?? 0}` : '';
  } catch {
    return '';
  }
}
