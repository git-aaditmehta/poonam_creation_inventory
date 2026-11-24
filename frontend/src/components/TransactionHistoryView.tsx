import React, { useState, useEffect, useCallback } from 'react';
import {
  History,
  Download,
  Filter,
  Search,
  PlusCircle,
  MinusCircle,
  Loader2,
  FileText,
  Undo2,
} from 'lucide-react';
import { api } from '../api';
import { localDb } from '../lib/localDb';
import type { Transaction, UnitTotal, User } from '../types';
import { undoBlockedReason, UNDO_DAYS } from '../lib/stockUndo';
import { confirmAndUndo } from './RecentStockOps';
import { formatIST, istDayStartUtc, istDayEndUtc, todayIST } from '../utils/time';
import { itemIdSearchSql } from '../utils/itemId';
import { useToast } from '../context/ToastContext';
import { errorText } from '../utils/friendlyErrors';
import { StockPdfModal } from './StockPdfModal';
import type { GeneratedPdfResult } from '../utils/pdfGenerator';

export const TransactionHistoryView: React.FC<{ user: User | null }> = ({ user }) => {
  const { showToast } = useToast();
  const [undoing, setUndoing] = useState<string | null>(null);

  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [page, setPage] = useState(1);
  const [isLoading, setIsLoading] = useState(false);

  // Filters
  const [category, setCategory] = useState<string>('');
  const [dateFrom, setDateFrom] = useState<string>('');
  const [dateTo, setDateTo] = useState<string>('');
  const [itemSearch, setItemSearch] = useState<string>('');

  // Totals per unit (pieces, grams and kg are never added together)
  const [unitTotals, setUnitTotals] = useState<UnitTotal[]>([]);
  // Where the list came from: the cloud (complete) or this phone (offline: recent entries only)
  const [source, setSource] = useState<'cloud' | 'phone'>('cloud');

  /** The same filters as SQL for this phone's own copy (dates are Indian calendar days). */
  const localWhere = useCallback(() => {
    let where = 'WHERE 1=1';
    const params: any[] = [];
    if (category) {
      where += ' AND category = ?';
      params.push(category);
    }
    // Stored times are UTC in two formats; datetime() reads both
    if (dateFrom) {
      where += ' AND datetime(created_at) >= ?';
      params.push(istDayStartUtc(dateFrom));
    }
    if (dateTo) {
      where += ' AND datetime(created_at) < ?';
      params.push(istDayEndUtc(dateTo));
    }
    if (itemSearch.trim()) {
      const q = itemIdSearchSql(itemSearch, 'item_display_id'); // ignores capitals, spaces and dashes
      where += ` AND ${q.sql}`;
      params.push(...q.params);
    }
    return { where, params };
  }, [category, dateFrom, dateTo, itemSearch]);

  const loadFromPhone = useCallback(async () => {
    const { where, params } = localWhere();
    const countRow = await localDb.get<{ total: number }>(`SELECT COUNT(*) as total FROM transactions ${where}`, params);
    const totalCount = countRow?.total ?? 0;
    const rows = await localDb.query<Transaction>(
      `SELECT * FROM transactions ${where} ORDER BY datetime(created_at) DESC LIMIT 50 OFFSET ?`,
      [...params, (page - 1) * 50]
    );
    const byUnit = await localDb.query<UnitTotal>(
      `SELECT unit,
         COALESCE(SUM(CASE WHEN operation = 'add' THEN quantity_change ELSE 0 END), 0) AS added,
         COALESCE(SUM(CASE WHEN operation = 'subtract' THEN quantity_change ELSE 0 END), 0) AS removed
       FROM transactions ${where} GROUP BY unit ORDER BY unit`,
      params
    );
    setTransactions(rows);
    setUnitTotals(byUnit);
    setTotal(totalCount);
    setTotalPages(Math.ceil(totalCount / 50) || 1);
    setSource('phone');
  }, [localWhere, page]);

  // Online: the complete history from the cloud. Offline (or cloud unreachable): this phone's recent copy.
  // quiet = a background refresh after a sync: no spinner, the page stays where it is (2026-11-24)
  const fetchHistory = useCallback(async (quiet = false) => {
    if (!quiet) setIsLoading(true);
    try {
      if (navigator.onLine) {
        try {
          const res = await api.history.list({
            page,
            limit: 50,
            category: category || undefined,
            date_from: dateFrom || undefined,
            date_to: dateTo || undefined,
            item_search: itemSearch.trim() || undefined,
          });
          setTransactions(res.transactions);
          setUnitTotals(res.totals_by_unit ?? []);
          setTotal(res.total);
          setTotalPages(res.totalPages || 1);
          setSource('cloud');
          return;
        } catch (err: any) {
          if (err?.status && err.status !== 0 && err.status < 500) {
            showToast('error', 'Could not load history', errorText(err));
            return;
          }
          // Network/server problem: fall back to this phone's copy below
        }
      }
      await loadFromPhone();
    } catch (err: any) {
      showToast('error', 'Could not load history', err?.message || 'Please try again.');
    } finally {
      setIsLoading(false);
    }
  }, [page, category, dateFrom, dateTo, itemSearch, showToast, loadFromPhone]);

  useEffect(() => {
    fetchHistory();
  }, [fetchHistory]);

  useEffect(() => {
    // Offline the list IS this phone's copy: refresh at once. Online it comes from the cloud: refresh shortly
    // after sync activity settles (not on every background sync tick).
    let timer: ReturnType<typeof setTimeout> | null = null;
    const handler = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => fetchHistory(true), navigator.onLine ? 2000 : 0);
    };
    window.addEventListener('localdb-change', handler);
    return () => {
      if (timer) clearTimeout(timer);
      window.removeEventListener('localdb-change', handler);
    };
  }, [fetchHistory]);

  /** ALL entries matching the filters (not only the 50 on screen): from the cloud, or offline this phone's copy. */
  const collectAllRows = async (): Promise<{ rows: Transaction[]; fromCloud: boolean }> => {
      let rows: Transaction[] = [];
      let fromCloud = false;
      if (navigator.onLine) {
        try {
          for (let p = 1; p <= 500; p++) {
            const res = await api.history.list({
              page: p,
              limit: 200,
              category: category || undefined,
              date_from: dateFrom || undefined,
              date_to: dateTo || undefined,
              item_search: itemSearch.trim() || undefined,
            });
            rows.push(...res.transactions);
            if (p >= (res.totalPages || 1)) break;
          }
          fromCloud = true;
        } catch {
          rows = [];
        }
      }
      if (!fromCloud) {
        const { where, params } = localWhere();
        rows = await localDb.query<Transaction>(`SELECT * FROM transactions ${where} ORDER BY datetime(created_at) DESC`, params);
      }
      return { rows, fromCloud };
  };

  // PDF of exactly what the filters show (all pages), with the filters printed on it
  const [pdfResult, setPdfResult] = useState<GeneratedPdfResult | null>(null);
  const [makingPdf, setMakingPdf] = useState(false);
  const handleGeneratePdf = async () => {
    setMakingPdf(true);
    try {
      const { rows, fromCloud } = await collectAllRows();
      if (rows.length === 0) {
        showToast('warning', 'Nothing to put in the PDF', 'No stock movements match the selected filters. Change the filters and try again.');
        return;
      }
      const { generateHistoryPdf } = await import('../utils/historyPdf');
      setPdfResult(generateHistoryPdf({ rows, filters: { category, dateFrom, dateTo, itemSearch }, complete: fromCloud }));
      if (!fromCloud) showToast('info', 'Made offline', 'Only the recent movements stored on this phone are in this PDF. Connect to the internet for the complete history.');
    } catch (err: any) {
      showToast('error', 'PDF could not be made', errorText(err));
    } finally {
      setMakingPdf(false);
    }
  };

  // Exports ALL matching entries (not only the 50 on screen), with Indian time
  const handleExportExcel = async () => {
    try {
      const { rows, fromCloud } = await collectAllRows();
      if (rows.length === 0) {
        showToast('warning', 'Nothing to export', 'No stock movements match the selected filters.');
        return;
      }
      const XLSX = await import('xlsx');
      const exportData = rows.map((t) => ({
        'Date & time (IST)': formatIST(t.created_at),
        'Category': t.category.replace('_', ' ').toUpperCase(),
        'Item Code': t.item_display_id,
        'Operation': `${t.operation === 'add' ? 'STOCK IN' : 'STOCK OUT'}${t.reverses_id ? ' (UNDO)' : ''}${t.undone_by ? ` (UNDONE by ${t.undone_by})` : ''}`,
        'Quantity': t.quantity_change,
        'Unit': t.unit,
        'Balance Before': t.quantity_before,
        'Balance After': t.quantity_after,
        'Done by': t.performer_name || t.performed_by,
        'Transaction ID': t.id,
      }));
      const ws = XLSX.utils.json_to_sheet(exportData);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Stock_History');
      XLSX.writeFile(wb, `Poonam_Stock_History_${todayIST()}.xlsx`);
      showToast(
        'success',
        'Excel downloaded',
        `${rows.length} stock movement${rows.length === 1 ? '' : 's'} exported${fromCloud ? '' : ' (offline: recent entries on this phone only)'}.`
      );
    } catch (err: any) {
      showToast('error', 'Export failed', err?.message || 'Please try again.');
    }
  };

  return (
    <div className="view-container">
      {/* Header */}
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 16,
          marginBottom: 24,
        }}
      >
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <History size={24} color="var(--gold-primary)" />
            <h2 style={{ fontSize: 22, fontWeight: 700 }}>Transaction Audit Trail</h2>
          </div>
          <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 4 }}>
            Immutable, sequential record of every stock movement and adjustment.
          </p>
        </div>

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
          <button onClick={handleExportExcel} className="btn btn-secondary">
            <Download size={15} /> Export Audit Log (.xlsx)
          </button>
          <button onClick={handleGeneratePdf} className="btn btn-secondary" disabled={makingPdf} title="PDF of the movements matching the filters below">
            {makingPdf ? <Loader2 size={15} className="animate-spin" /> : <FileText size={15} />} {makingPdf ? 'Generating...' : 'Generate PDF'}
          </button>
        </div>
      </div>

      {/* Aggregate Cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 16, marginBottom: 24 }}>
        <div className="card" style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <div
            style={{
              width: 44,
              height: 44,
              borderRadius: 'var(--radius-md)',
              background: 'var(--emerald-bg)',
              color: 'var(--emerald-text)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <PlusCircle size={24} />
          </div>
          <div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase' }}>
              Total Stock Inflow
            </div>
            <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--emerald-text)' }} className="mono">
              {unitTotals.length === 0
                ? '—'
                : unitTotals.filter((u) => u.added > 0).map((u) => `+${u.added} ${u.unit}`).join(' · ') || '—'}
            </div>
          </div>
        </div>

        <div className="card" style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <div
            style={{
              width: 44,
              height: 44,
              borderRadius: 'var(--radius-md)',
              background: 'var(--rose-bg)',
              color: 'var(--rose-text)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <MinusCircle size={24} />
          </div>
          <div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase' }}>
              Total Stock Outflow
            </div>
            <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--rose-text)' }} className="mono">
              {unitTotals.length === 0
                ? '—'
                : unitTotals.filter((u) => u.removed > 0).map((u) => `−${u.removed} ${u.unit}`).join(' · ') || '—'}
            </div>
          </div>
        </div>
      </div>

      {/* Filter Toolbar */}
      <div
        style={{
          background: 'var(--bg-surface-1)',
          border: '1px solid var(--border-subtle)',
          borderRadius: 'var(--radius-lg)',
          padding: '16px',
          marginBottom: 20,
          display: 'flex',
          flexWrap: 'wrap',
          gap: 12,
          alignItems: 'center',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text-secondary)', fontSize: 13 }}>
          <Filter size={16} /> Filters:
        </div>

        {/* Category */}
        <select
          className="select"
          style={{ width: 'auto', minWidth: 160 }}
          value={category}
          onChange={(e) => {
            setCategory(e.target.value);
            setPage(1);
          }}
        >
          <option value="">All Categories</option>
          <option value="plated_jewelry">Plated Jewelry</option>
          <option value="raw_jewelry">Raw Jewelry</option>
          <option value="stones">Kundan Stone</option>
          <option value="foil">Foil</option>
        </select>

        {/* Search */}
        <div style={{ position: 'relative', width: 200 }}>
          <Search size={14} color="var(--text-muted)" style={{ position: 'absolute', left: 10, top: 11 }} />
          <input
            type="text"
            className="input mono"
            style={{ paddingLeft: 32, fontSize: 12 }}
            placeholder="Search item code..."
            value={itemSearch}
            onChange={(e) => {
              setItemSearch(e.target.value);
              setPage(1);
            }}
          />
        </div>

        {/* Date From */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>From:</span>
          <input
            type="date"
            className="input"
            style={{ width: 'auto', padding: '6px 10px', fontSize: 12 }}
            value={dateFrom}
            onChange={(e) => {
              setDateFrom(e.target.value);
              setPage(1);
            }}
          />
        </div>

        {/* Date To */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>To:</span>
          <input
            type="date"
            className="input"
            style={{ width: 'auto', padding: '6px 10px', fontSize: 12 }}
            value={dateTo}
            onChange={(e) => {
              setDateTo(e.target.value);
              setPage(1);
            }}
          />
        </div>

        {(category || dateFrom || dateTo || itemSearch) && (
          <button
            className="btn btn-secondary"
            style={{ padding: '6px 10px', fontSize: 12 }}
            onClick={() => {
              setCategory('');
              setDateFrom('');
              setDateTo('');
              setItemSearch('');
              setPage(1);
            }}
          >
            Clear Filters
          </button>
        )}
      </div>

      {source === 'phone' && (
        <div
          role="status"
          style={{
            padding: '10px 14px',
            marginBottom: 12,
            borderRadius: 'var(--radius-md)',
            background: 'rgba(245,158,11,.10)',
            border: '1px solid rgba(245,158,11,.3)',
            color: '#92400E',
            fontSize: 13,
          }}
        >
          <strong>Offline — showing recent entries only.</strong> The complete history is in the cloud and appears when
          you are back online.
        </div>
      )}

      {/* Transactions Table */}
      {isLoading ? (
        <div style={{ textAlign: 'center', padding: '60px 0', color: 'var(--text-muted)' }}>
          <Loader2 size={32} className="animate-spin" style={{ margin: '0 auto 12px' }} />
          <div>Retrieving audit trail...</div>
        </div>
      ) : transactions.length === 0 ? (
        <div
          style={{
            textAlign: 'center',
            padding: '60px 20px',
            background: 'var(--bg-surface-1)',
            borderRadius: 'var(--radius-lg)',
            border: '1px dashed var(--border-medium)',
          }}
        >
          <History size={40} color="var(--text-muted)" style={{ margin: '0 auto 12px' }} />
          <h3 style={{ fontSize: 16 }}>No Transactions Found</h3>
          <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 4 }}>
            No stock movements match the selected filters.
          </p>
        </div>
      ) : (
        <div className="table-container">
          <table className="data-table">
            <thead>
              <tr>
                <th>Date &amp; time (IST)</th>
                <th>Category</th>
                <th>Item Code</th>
                <th>Operation</th>
                <th>Quantity</th>
                <th>Balance Progression</th>
                <th>Performed By</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {transactions.map((t) => (
                <tr key={t.id}>
                  <td style={{ color: 'var(--text-secondary)', fontSize: 12 }} className="mono">
                    {formatIST(t.created_at)}
                  </td>
                  <td>
                    <span className="badge badge-gold">
                      {t.category.replace('_', ' ')}
                    </span>
                  </td>
                  <td>
                    <div style={{ fontWeight: 700 }} className="mono">
                      {t.item_display_id}
                    </div>
                  </td>
                  <td>
                    {t.operation === 'add' ? (
                      <span className="badge badge-emerald" style={{ display: 'inline-flex', gap: 4 }}>
                        <PlusCircle size={11} /> ADD
                      </span>
                    ) : (
                      <span className="badge badge-rose" style={{ display: 'inline-flex', gap: 4 }}>
                        <MinusCircle size={11} /> SUBTRACT
                      </span>
                    )}
                    {t.reverses_id && <div><span className="badge" style={{ fontSize: 10, marginTop: 4, background: "rgba(99,102,241,.12)", color: "#4338CA" }}>UNDO of an earlier operation</span></div>}
                    {t.undone_by && <div><span className="badge badge-rose" style={{ fontSize: 10, marginTop: 4 }}>UNDONE by {t.undone_by}{t.undone_at ? `, ${formatIST(t.undone_at)}` : ''}</span></div>}
                  </td>
                  <td>
                    <span
                      style={{
                        fontWeight: 700,
                        fontSize: 14,
                        color: t.operation === 'add' ? 'var(--emerald-text)' : 'var(--rose-text)',
                      }}
                      className="mono"
                    >
                      {t.operation === 'add' ? '+' : '-'}{t.quantity_change} {t.unit}
                    </span>
                  </td>
                  <td className="mono" style={{ fontSize: 12 }}>
                    <span style={{ color: 'var(--text-muted)' }}>{t.quantity_before}</span>
                    <span style={{ color: 'var(--text-secondary)', margin: '0 6px' }}>→</span>
                    <span style={{ fontWeight: 700, color: 'var(--text-primary)' }}>{t.quantity_after} {t.unit}</span>
                  </td>
                  <td style={{ fontSize: 13 }}>
                    {t.performer_name || t.performed_by}
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    {source === 'cloud' && !undoBlockedReason(t, user) && (
                      <button
                        type="button"
                        className="btn btn-secondary"
                        style={{ padding: '4px 10px', fontSize: 11, display: 'inline-flex', alignItems: 'center', gap: 4 }}
                        disabled={undoing !== null}
                        onClick={async () => {
                          setUndoing(t.id);
                          const ok = await confirmAndUndo(t, showToast);
                          setUndoing(null);
                          if (ok) fetchHistory(true);
                        }}
                        title={`Undo this operation (possible for ${UNDO_DAYS} days)`}
                      >
                        {undoing === t.id ? <Loader2 size={12} className="animate-spin" /> : <Undo2 size={12} />} Undo
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Pagination */}
      {totalPages > 1 && (
        <div style={{ display: 'flex', justifyContent: 'center', gap: 10, marginTop: 24 }}>
          <button
            className="btn btn-secondary"
            disabled={page <= 1}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
          >
            Previous
          </button>
          <span style={{ fontSize: 13, color: 'var(--text-secondary)', alignSelf: 'center' }}>
            Page {page} of {totalPages} ({total} total records)
          </span>
          <button
            className="btn btn-secondary"
            disabled={page >= totalPages}
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
          >
            Next
          </button>
        </div>
      )}
      {pdfResult && (
        <StockPdfModal
          pdfResult={pdfResult}
          categoryTitle="Stock History"
          heading="Stock Movement History"
          subtitle={`${pdfResult.totalItems} movement${pdfResult.totalItems === 1 ? '' : 's'} • matching the filters on screen`}
          shareText={`Stock movement history: ${pdfResult.totalItems} movement${pdfResult.totalItems === 1 ? '' : 's'}.`}
          onClose={() => {
            URL.revokeObjectURL(pdfResult.url);
            setPdfResult(null);
          }}
          showToast={showToast}
        />
      )}
    </div>
  );
};
