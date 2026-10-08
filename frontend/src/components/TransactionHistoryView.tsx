import React, { useState, useEffect, useCallback } from 'react';
import {
  History,
  Download,
  Filter,
  Search,
  PlusCircle,
  MinusCircle,
  Loader2,
} from 'lucide-react';
import * as XLSX from 'xlsx';
import { api } from '../api';
import type { Transaction } from '../types';
import { useToast } from '../context/ToastContext';

export const TransactionHistoryView: React.FC = () => {
  const { showToast } = useToast();

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

  // Aggregates
  const [totals, setTotals] = useState<{ total_added: number; total_subtracted: number }>({
    total_added: 0,
    total_subtracted: 0,
  });

  const fetchHistory = useCallback(async () => {
    setIsLoading(true);
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
      setTotals(res.totals);
      setTotal(res.total);
      setTotalPages(res.totalPages || 1);
    } catch (err: any) {
      showToast('error', 'Failed to fetch history', err.message);
    } finally {
      setIsLoading(false);
    }
  }, [page, category, dateFrom, dateTo, itemSearch, showToast]);

  useEffect(() => {
    fetchHistory();
  }, [fetchHistory]);

  const handleExportExcel = () => {
    if (transactions.length === 0) {
      showToast('warning', 'No Data', 'No transactions to export');
      return;
    }

    try {
      const exportData = transactions.map((t) => ({
        'Transaction ID': t.id,
        'Timestamp': t.created_at,
        'Category': t.category.replace('_', ' ').toUpperCase(),
        'Item Code': t.item_display_id,
        'Operation': t.operation.toUpperCase(),
        'Quantity Change': t.quantity_change,
        'Unit': t.unit,
        'Balance Before': t.quantity_before,
        'Balance After': t.quantity_after,
        'Operator': t.performer_name || t.performed_by,
      }));

      const ws = XLSX.utils.json_to_sheet(exportData);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Audit_Trail');
      XLSX.writeFile(wb, `Poonam_Transactions_${new Date().toISOString().slice(0, 10)}.xlsx`);
      showToast('success', 'Export Completed', 'Audit trail exported to Excel');
    } catch (err: any) {
      showToast('error', 'Export Failed', err.message);
    }
  };

  return (
    <div style={{ padding: '24px', maxWidth: '1400px', margin: '0 auto', width: '100%' }}>
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
            <h2 style={{ fontSize: 22, fontWeight: 800 }}>Transaction Audit Trail</h2>
          </div>
          <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 4 }}>
            Immutable, sequential record of every stock movement and adjustment.
          </p>
        </div>

        <button onClick={handleExportExcel} className="btn btn-secondary">
          <Download size={15} /> Export Audit Log (.xlsx)
        </button>
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
            <div style={{ fontSize: 20, fontWeight: 800, color: 'var(--emerald-text)' }} className="mono">
              +{totals.total_added} units
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
            <div style={{ fontSize: 20, fontWeight: 800, color: 'var(--rose-text)' }} className="mono">
              -{totals.total_subtracted} units
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
          <option value="stones">Stones</option>
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
                <th>Timestamp</th>
                <th>Category</th>
                <th>Item Code</th>
                <th>Operation</th>
                <th>Quantity</th>
                <th>Balance Progression</th>
                <th>Performed By</th>
              </tr>
            </thead>
            <tbody>
              {transactions.map((t) => (
                <tr key={t.id}>
                  <td style={{ color: 'var(--text-secondary)', fontSize: 12 }} className="mono">
                    {t.created_at}
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
                  </td>
                  <td>
                    <span
                      style={{
                        fontWeight: 800,
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
    </div>
  );
};
