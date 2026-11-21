import React, { useCallback, useEffect, useState } from 'react';
import { History, ChevronDown, ChevronUp, Loader2, X } from 'lucide-react';
import { api } from '../api';
import { localDb } from '../lib/localDb';
import type { Transaction } from '../types';
import { formatIST } from '../utils/time';

const PAGE = 10;
const n = (x: number) => String(Math.round(Number(x) * 1000) / 1000);

/**
 * One item's stock movements (requested 2026-11-21): who, when, how much, balance before → after, undo marks.
 * From the cloud when online (complete), otherwise from this phone's copy (recent movements).
 */
export const ItemHistory: React.FC<{ itemUuid: string; startOpen?: boolean }> = ({ itemUuid, startOpen = false }) => {
  const [open, setOpen] = useState(startOpen);
  const [rows, setRows] = useState<Transaction[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [source, setSource] = useState<'cloud' | 'phone'>('cloud');

  const load = useCallback(
    async (p: number) => {
      setLoading(true);
      try {
        if (navigator.onLine) {
          try {
            const res = await api.history.list({ item_uuid: itemUuid, page: p, limit: PAGE });
            setRows((prev) => (p === 1 ? res.transactions : [...prev, ...res.transactions]));
            setTotal(res.total);
            setSource('cloud');
            return;
          } catch {
            /* fall back to this phone's copy */
          }
        }
        const list = await localDb.query<Transaction>(
          'SELECT * FROM transactions WHERE item_id = ? ORDER BY datetime(created_at) DESC LIMIT ? OFFSET ?',
          [itemUuid, PAGE, (p - 1) * PAGE],
        );
        const cnt = await localDb.get<{ c: number }>('SELECT COUNT(*) AS c FROM transactions WHERE item_id = ?', [itemUuid]);
        setRows((prev) => (p === 1 ? list : [...prev, ...list]));
        setTotal(cnt?.c ?? list.length);
        setSource('phone');
      } finally {
        setLoading(false);
      }
    },
    [itemUuid],
  );

  // Fresh list for each item; refresh after stock changes reach this phone
  useEffect(() => {
    setRows([]);
    setTotal(null);
    setPage(1);
    load(1);
    let timer: ReturnType<typeof setTimeout> | null = null;
    const refresh = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        setPage(1);
        load(1);
      }, 1500);
    };
    window.addEventListener('localdb-change', refresh);
    return () => {
      if (timer) clearTimeout(timer);
      window.removeEventListener('localdb-change', refresh);
    };
  }, [load]);

  return (
    <div style={{ border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-md)', marginBottom: 12, background: 'var(--bg-surface-1)' }}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: '8px 12px', background: 'none', border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: 700, color: 'var(--text-primary)' }}
        aria-expanded={open}
      >
        <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <History size={14} /> Stock history {total !== null && <span style={{ fontWeight: 500, color: 'var(--text-muted)' }}>({total})</span>}
        </span>
        {open ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
      </button>
      {open && (
        <div style={{ maxHeight: 260, overflowY: 'auto', borderTop: '1px solid var(--border-subtle)' }}>
          {source === 'phone' && (
            <div style={{ fontSize: 11, color: 'var(--amber-text)', padding: '6px 12px' }}>Offline: recent movements stored on this phone only.</div>
          )}
          {rows.length === 0 && !loading && (
            <div style={{ fontSize: 12, color: 'var(--text-muted)', padding: '10px 12px' }}>No stock movements yet for this item.</div>
          )}
          {rows.map((t) => (
            <div key={t.id} style={{ padding: '7px 12px', borderBottom: '1px solid var(--border-subtle)', fontSize: 12 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                <strong className="mono" style={{ color: t.operation === 'add' ? 'var(--emerald-text)' : 'var(--rose-text)' }}>
                  {t.operation === 'add' ? '+' : '−'}{n(t.quantity_change)} {t.unit}
                </strong>
                <span style={{ color: 'var(--text-secondary)' }}>{t.operation === 'add' ? 'Stock in' : 'Stock out'}</span>
                {t.reverses_id && <span className="badge" style={{ fontSize: 9, background: 'rgba(99,102,241,.12)', color: '#4338CA' }}>UNDO</span>}
                {t.undone_by && <span className="badge badge-rose" style={{ fontSize: 9 }}>UNDONE by {t.undone_by}</span>}
                <span className="mono" style={{ marginLeft: 'auto', color: 'var(--text-muted)' }}>{n(t.quantity_before)} → {n(t.quantity_after)}</span>
              </div>
              <div style={{ color: 'var(--text-muted)', fontSize: 11, marginTop: 1 }}>
                {t.performer_name || t.performed_by} · {formatIST(t.created_at)}
              </div>
            </div>
          ))}
          {loading && (
            <div style={{ padding: 10, textAlign: 'center' }}><Loader2 size={16} className="animate-spin" /></div>
          )}
          {!loading && total !== null && rows.length < total && (
            <button
              type="button"
              className="btn btn-secondary"
              style={{ margin: 8, fontSize: 12, padding: '4px 10px' }}
              onClick={() => {
                const p = page + 1;
                setPage(p);
                load(p);
              }}
            >
              Show older ({total - rows.length} more)
            </button>
          )}
        </div>
      )}
    </div>
  );
};

/** For table screens (Raw, Kundan, Foil): a small window with one item's history. */
export const ItemHistoryModal: React.FC<{ itemUuid: string; title: string; onClose: () => void }> = ({ itemUuid, title, onClose }) => (
  <div className="modal-backdrop" onClick={onClose}>
    <div className="modal-content" style={{ maxWidth: 460 }} onClick={(e) => e.stopPropagation()}>
      <div className="modal-header">
        <h3 style={{ fontSize: 16, fontWeight: 700 }} className="mono">{title}</h3>
        <button className="btn-icon" onClick={onClose} aria-label="Close"><X size={16} /></button>
      </div>
      <div className="modal-body">
        <ItemHistory itemUuid={itemUuid} startOpen />
      </div>
    </div>
  </div>
);
