import React, { useCallback, useEffect, useState } from 'react';
import { History, Undo2, Loader2, WifiOff } from 'lucide-react';
import { api } from '../api';
import type { Transaction, User } from '../types';
import { formatIST } from '../utils/time';
import { useToast } from '../context/ToastContext';
import { errorText } from '../utils/friendlyErrors';
import { undoBlockedReason, undoStockOperation, UNDO_DAYS, localHistorySignature } from '../lib/stockUndo';

const CATEGORY_LABEL: Record<string, string> = { plated_jewelry: 'Plated', raw_jewelry: 'Raw', stones: 'Kundan', foil: 'Foil' };
const n = (x: number) => String(Math.round(Number(x) * 1000) / 1000);

/** Short description used in the confirm question and messages. */
export function describeMove(t: Pick<Transaction, 'operation' | 'quantity_change' | 'unit' | 'item_display_id'>): string {
  return `${t.operation === 'add' ? 'stock in' : 'stock out'} of ${n(t.quantity_change)} ${t.unit} on ${t.item_display_id}`;
}

/** Asks, undoes in the cloud, and says what happened. Returns the cloud's new balance when undone, else null. */
export async function confirmAndUndo(
  t: Pick<Transaction, 'id' | 'operation' | 'quantity_change' | 'unit' | 'item_display_id' | 'performer_name' | 'created_at'> & { idempotency_key?: string },
  showToast: (type: 'success' | 'error' | 'info' | 'warning', title: string, message?: string) => void,
  byKey = false,
): Promise<{ newBalance: number; unit: string } | null> {
  const back = t.operation === 'add' ? `go down by ${n(t.quantity_change)}` : `go back up by ${n(t.quantity_change)}`;
  if (!window.confirm(`Undo ${describeMove(t)} (by ${t.performer_name}, ${formatIST(t.created_at)})?\n\nThe stock will ${back} ${t.unit}. The history keeps both entries.`)) return null;
  try {
    const res = await undoStockOperation(byKey && t.idempotency_key ? { idempotency_key: t.idempotency_key } : { transaction_id: t.id });
    showToast('success', 'Undone', res.message);
    return { newBalance: res.newBalance, unit: res.unit };
  } catch (err: any) {
    showToast('error', 'Not undone', err?.message || errorText(err));
    return null;
  }
}

/**
 * Recent stock operations (everyone's; visible to owner and staff alike) with Undo where allowed:
 * staff their own, the owner anyone's, within 7 days.
 */
export const RecentStockOps: React.FC<{ user: User | null }> = ({ user }) => {
  const { showToast } = useToast();
  const [rows, setRows] = useState<Transaction[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [online, setOnline] = useState(navigator.onLine);

  const load = useCallback(async () => {
    if (!navigator.onLine) return;
    try {
      const res = await api.history.list({ page: 1, limit: 10, lite: true });
      setRows(res.transactions);
    } catch {
      /* keep the last list */
    }
  }, []);

  useEffect(() => {
    let lastSig = '';
    localHistorySignature().then((sig) => { lastSig = sig; });
    load();
    let timer: ReturnType<typeof setTimeout> | null = null;
    // After a sync: ask the cloud again only if a stock movement was added on this phone's copy (from any phone)
    const refresh = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(async () => {
        const sig = await localHistorySignature();
        if (sig && sig === lastSig) return;
        lastSig = sig;
        load();
      }, 1200);
    };
    const on = () => {
      setOnline(true);
      load();
    };
    const off = () => setOnline(false);
    window.addEventListener('localdb-change', refresh);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      if (timer) clearTimeout(timer);
      window.removeEventListener('localdb-change', refresh);
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, [load]);

  const undo = async (t: Transaction) => {
    setBusy(t.id);
    const ok = await confirmAndUndo(t, showToast);
    setBusy(null);
    if (ok) setTimeout(load, 600);
  };

  return (
    <div style={{ marginTop: 24, border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-md)', background: 'var(--bg-surface-1)' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: '12px 16px', borderBottom: '1px solid var(--border-subtle)', flexWrap: 'wrap' }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, fontWeight: 700 }}>
          <History size={15} /> Recent operations
        </span>
        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
          Undo within {UNDO_DAYS} days · staff their own, owner anyone's
        </span>
      </div>
      {!online ? (
        <div style={{ padding: 16, fontSize: 12, color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: 6 }}>
          <WifiOff size={14} /> Offline: recent operations and Undo need internet. Operations waiting to be sent can be removed in Sync Queue.
        </div>
      ) : rows === null ? (
        <div style={{ padding: 16, fontSize: 12, color: 'var(--text-muted)' }}>Loading…</div>
      ) : rows.length === 0 ? (
        <div style={{ padding: 16, fontSize: 12, color: 'var(--text-muted)' }}>No stock operations yet.</div>
      ) : (
        <div>
          {rows.map((t) => {
            const blocked = undoBlockedReason(t, user);
            const isUndo = !!t.reverses_id;
            return (
              <div key={t.id} className="rso-row">
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                    <strong className="mono" style={{ fontSize: 13 }}>{t.item_display_id}</strong>
                    <span className="mono" style={{ fontSize: 13, fontWeight: 700, color: t.operation === 'add' ? 'var(--emerald-text)' : 'var(--rose-text)' }}>
                      {t.operation === 'add' ? '+' : '−'}{n(t.quantity_change)} {t.unit}
                    </span>
                    <span className="badge" style={{ fontSize: 10, background: 'var(--bg-surface-2)' }}>{CATEGORY_LABEL[t.category] || t.category}</span>
                    {isUndo && <span className="badge" style={{ fontSize: 10, background: "rgba(99,102,241,.12)", color: "#4338CA" }}>UNDO</span>}
                    {t.undone_by && <span className="badge badge-rose" style={{ fontSize: 10 }}>UNDONE by {t.undone_by}</span>}
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
                    {t.performer_name} · {formatIST(t.created_at)} · balance {n(t.quantity_before)} → {n(t.quantity_after)}
                  </div>
                  {t.remarks && <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 2, fontStyle: 'italic' }}>“{t.remarks}”</div>}
                </div>
                {!blocked ? (
                  <button type="button" className="btn btn-secondary" style={{ padding: '5px 10px', fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 4 }} onClick={() => undo(t)} disabled={busy !== null}>
                    {busy === t.id ? <Loader2 size={13} className="animate-spin" /> : <Undo2 size={13} />} Undo
                  </button>
                ) : !isUndo && !t.undone_by ? (
                  <span style={{ fontSize: 10, color: 'var(--text-muted)', maxWidth: 140, textAlign: 'right' }}>{blocked}</span>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
      <style>{`
        .rso-row { display: flex; align-items: center; gap: 10px; padding: 10px 16px; border-bottom: 1px solid var(--border-subtle); }
        .rso-row:last-child { border-bottom: none; }
      `}</style>
    </div>
  );
};
