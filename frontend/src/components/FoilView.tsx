import React, { useState, useEffect, useCallback } from 'react';
import {
  Search,
  Plus,
  Edit2,
  Trash2,
  AlertTriangle,
  CheckCircle2,
  Loader2,
  X,
  Scroll,
  IndianRupee,
} from 'lucide-react';
import { api } from '../api';
import { localDb } from '../lib/localDb';
import type { FoilItem, User } from '../types';
import { useToast } from '../context/ToastContext';
import { GeneratePdfButton } from './GeneratePdfButton';
import { emitSyncStatus } from './SyncStatusBar';
import { parseFriendlyError } from '../utils/friendlyErrors';

interface FoilViewProps {
  user: User;
  onQuickOperate?: (category: 'foil', item: FoilItem) => void;
}

export const FoilView: React.FC<FoilViewProps> = ({ user, onQuickOperate }) => {
  const isOwner = user.role === 'owner';
  const { showToast } = useToast();

  const [items, setItems] = useState<FoilItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [search, setSearch] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [valuation, setValuation] = useState<number | null>(null);

  // Modals
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [isEditOpen, setIsEditOpen] = useState(false);
  const [activeItem, setActiveItem] = useState<FoilItem | null>(null);

  // Forms
  const [formItemId, setFormItemId] = useState('');
  const [formQty, setFormQty] = useState<number | ''>('');
  const [formThreshold, setFormThreshold] = useState<number | ''>('');
  const [formCost, setFormCost] = useState<number | ''>('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const fetchItems = useCallback(async (forceCloud = false) => {
    setIsLoading(true);
    try {
      if (!forceCloud) {
        const res = await localDb.getItemsPaginated<FoilItem>('foil', page, 30, search.trim() || undefined);
        if (res.total > 0 || !navigator.onLine) {
          setItems(res.items);
          setTotal(res.total);
          setTotalPages(res.totalPages || 1);
          setIsLoading(false);
          return;
        }
      }

      const res = await api.inventory.listFoil({ page, limit: 30, search: search.trim() || undefined });
      setItems(res.items);
      setTotal(res.total);
      setTotalPages(res.totalPages || 1);

      if (res.items.length > 0) {
        await localDb.bulkUpsert('foil', res.items);
      }
    } catch (err: any) {
      try {
        const res = await localDb.getItemsPaginated<FoilItem>('foil', page, 30, search.trim() || undefined);
        setItems(res.items);
        setTotal(res.total);
        setTotalPages(res.totalPages || 1);
      } catch {
        showToast('error', 'Failed to load foil items', err.message);
      }
    } finally {
      setIsLoading(false);
    }
  }, [page, search, showToast]);

  const fetchValuation = useCallback(async (forceCloud = false) => {
    if (!isOwner) return;
    try {
      if (!forceCloud) {
        const val = await localDb.getValuation('foil');
        if (val > 0 || !navigator.onLine) {
          setValuation(val);
          return;
        }
      }
      const res = await api.inventory.getValuation('foil');
      setValuation(res.total_value);
    } catch {
      try {
        const val = await localDb.getValuation('foil');
        setValuation(val);
      } catch { /* ignore */ }
    }
  }, [isOwner]);

  useEffect(() => {
    fetchItems();
  }, [fetchItems]);

  useEffect(() => {
    fetchValuation();
  }, [fetchValuation]);

  useEffect(() => {
    const handler = () => { fetchItems(); fetchValuation(); };
    window.addEventListener('localdb-change', handler);
    return () => window.removeEventListener('localdb-change', handler);
  }, [fetchItems, fetchValuation]);

  const handleCreateSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedId = formItemId.trim();
    if (!trimmedId || formQty === '' || formThreshold === '' || formCost === '') {
      const friendly = parseFriendlyError('Validation: Please fill all required fields', { categoryName: 'Foil' });
      showToast('error', friendly.title, friendly.solution);
      return;
    }

    // Fast local duplicate check (<1ms)
    try {
      const existing = await localDb.get('SELECT id FROM foil WHERE item_id = ? AND is_deleted = 0', [trimmedId]);
      if (existing) {
        const friendly = parseFriendlyError('Item already exists', { categoryName: 'Foil', itemId: trimmedId });
        showToast('error', friendly.title, `${friendly.message} ${friendly.solution}`);
        return;
      }
    } catch { /* proceed */ }

    const clientId = 'foil_' + crypto.randomUUID();
    const qtyNum = Math.round(Number(formQty) * 1000) / 1000;
    const thresholdNum = Math.round(Number(formThreshold) * 1000) / 1000;
    const costNum = Number(formCost);
    const nowIso = new Date().toISOString();

    const newItem: FoilItem = {
      id: clientId,
      item_id: trimmedId,
      quantity: qtyNum,
      unit: 'KGS',
      low_stock_threshold: thresholdNum,
      cost_price: isOwner ? costNum : 0,
      cost_price_cents: isOwner ? Math.round(costNum * 100) : 0,
      is_low_stock: qtyNum < thresholdNum,
      created_at: nowIso,
      updated_at: nowIso,
    };

    // 1. Optimistic local insert (<2ms)
    try {
      await localDb.upsertItem('foil', newItem);
      setItems((prev) => [newItem, ...prev.filter((i) => i.id !== clientId)]);
      setTotal((t) => t + 1);

      if (isOwner) {
        const newTotalVal = await localDb.getValuation('foil');
        setValuation(newTotalVal);
      }
    } catch (dbErr) {
      console.warn('[Foil] Local insert error:', dbErr);
    }

    // 2. Instant UI feedback (<5ms modal close)
    showToast('success', 'Foil Stock Added', `${trimmedId} saved to inventory`);
    setIsCreateOpen(false);
    resetForm();

    // 3. Notify Sync Status Bar
    emitSyncStatus({
      state: 'syncing',
      title: 'Saving to Cloud',
      message: `Uploading ${trimmedId}...`,
      itemId: trimmedId,
      category: 'Foil',
    });

    // 4. Background Cloudflare sync (non-blocking)
    (async () => {
      try {
        const res = await api.inventory.createItem('foil', {
          item_id: trimmedId,
          quantity: qtyNum,
          unit: 'KGS',
          low_stock_threshold: thresholdNum,
          cost_price: costNum,
        });

        // Harmonize authoritative ID if different
        if (res?.id && res.id !== clientId) {
          await localDb.deleteItem('foil', clientId);
          const authoritativeItem = { ...newItem, id: res.id, ...(res.item || {}) };
          await localDb.upsertItem('foil', authoritativeItem);
          setItems((prev) => prev.map((i) => (i.id === clientId ? authoritativeItem : i)));
        }

        emitSyncStatus({
          state: 'synced',
          title: 'Saved to Cloud',
          message: `${trimmedId} is backed up to Cloudflare D1.`,
          itemId: trimmedId,
          category: 'Foil',
        });
      } catch (err: any) {
        const friendly = parseFriendlyError(err, { categoryName: 'Foil', itemId: trimmedId });

        if (friendly.isOffline) {
          emitSyncStatus({
            state: 'offline',
            title: 'Working Offline',
            message: `${trimmedId} safely saved locally. Will sync when reconnected.`,
            solution: friendly.solution,
            itemId: trimmedId,
            category: 'Foil',
          });
        } else {
          // Rollback on duplicate or invalid error
          await localDb.deleteItem('foil', clientId);
          setItems((prev) => prev.filter((i) => i.id !== clientId));
          setTotal((t) => Math.max(0, t - 1));

          if (isOwner) {
            const currentVal = await localDb.getValuation('foil');
            setValuation(currentVal);
          }

          emitSyncStatus({
            state: 'error',
            title: friendly.title,
            message: friendly.message,
            solution: friendly.solution,
            itemId: trimmedId,
            category: 'Foil',
            error: friendly,
          });
          showToast('error', friendly.title, friendly.solution);
        }
      }
    })();
  };

  const handleEditSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeItem) return;

    setIsSubmitting(true);
    try {
      await api.inventory.updateItem('foil', activeItem.id, {
        item_id: formItemId.trim(),
        low_stock_threshold: Number(formThreshold),
        cost_price: Number(formCost),
      });
      showToast('success', 'Foil Updated', `Updated metadata for ${formItemId}`);
      setIsEditOpen(false);
      fetchItems();
      fetchValuation();
    } catch (err: any) {
      const friendly = parseFriendlyError(err, { categoryName: 'Foil', itemId: formItemId.trim() });
      showToast('error', friendly.title, friendly.solution);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDelete = async (item: FoilItem) => {
    if (!confirm(`Delete foil record ${item.item_id}?`)) return;

    try {
      await api.inventory.deleteItem('foil', item.id);
      await localDb.deleteItem('foil', item.id);
      setItems((prev) => prev.filter((i) => i.id !== item.id));
      setTotal((t) => Math.max(0, t - 1));
      if (isOwner) {
        const v = await localDb.getValuation('foil');
        setValuation(v);
      }
      showToast('success', 'Item Deleted', `${item.item_id} removed`);
    } catch (err: any) {
      const friendly = parseFriendlyError(err, { categoryName: 'Foil', itemId: item.item_id });
      showToast('error', friendly.title, friendly.solution);
    }
  };

  const openEditModal = (item: FoilItem) => {
    setActiveItem(item);
    setFormItemId(item.item_id);
    setFormThreshold(item.low_stock_threshold);
    setFormCost(item.cost_price || 0);
    setIsEditOpen(true);
  };

  const resetForm = () => {
    setFormItemId('');
    setFormQty('');
    setFormThreshold('');
    setFormCost('');
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
          <h2 style={{ fontSize: 22, fontWeight: 700 }}>Silver & Metal Foil Stock</h2>
          <p style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
            Raw silver foil rolls and plating foils (weighted in kilograms / KGS).
          </p>
        </div>

        <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          {isOwner && valuation !== null && (
            <div
              style={{
                background: 'var(--bg-surface-1)',
                border: '1px solid var(--border-medium)',
                borderRadius: 'var(--radius-md)',
                padding: '8px 14px',
                display: 'flex',
                alignItems: 'center',
                gap: 8,
              }}
            >
              <IndianRupee size={16} color="var(--teal-deep)" />
              <div>
                <div style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase' }}>
                  Foil Valuation
                </div>
                <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--teal-deep)' }} className="mono">
                  ₹{valuation.toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                </div>
              </div>
            </div>
          )}

          <GeneratePdfButton
            category="foil"
            categoryTitle="Silver & Metal Foil Stock"
            username={user.username}
            showToast={showToast}
          />

          {isOwner && (
            <button
              onClick={() => {
                resetForm();
                setIsCreateOpen(true);
              }}
              className="btn btn-primary"
            >
              <Plus size={16} /> New Foil Item
            </button>
          )}
        </div>
      </div>

      {/* Search Toolbar */}
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 20 }}>
        <div style={{ position: 'relative', flex: 1, maxWidth: 400 }}>
          <Search size={16} color="var(--text-muted)" style={{ position: 'absolute', left: 12, top: 11 }} />
          <input
            type="text"
            className="input"
            style={{ paddingLeft: 38 }}
            placeholder="Search foil type / ID..."
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
          />
        </div>
        <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>
          Showing <strong>{items.length}</strong> of <strong>{total}</strong> foil grades
        </div>
      </div>

      {/* Table */}
      {isLoading ? (
        <div style={{ textAlign: 'center', padding: '60px 0', color: 'var(--text-muted)' }}>
          <Loader2 size={32} className="animate-spin" style={{ margin: '0 auto 12px' }} />
          <div>Loading foil inventory...</div>
        </div>
      ) : items.length === 0 ? (
        <div
          style={{
            textAlign: 'center',
            padding: '60px 20px',
            background: 'var(--bg-surface-1)',
            borderRadius: 'var(--radius-lg)',
            border: '1px dashed var(--border-medium)',
          }}
        >
          <Scroll size={40} color="var(--text-muted)" style={{ margin: '0 auto 12px' }} />
          <h3 style={{ fontSize: 16 }}>No Foil Stock Found</h3>
          <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 4 }}>
            {search ? 'No match found.' : 'Create a foil record to begin.'}
          </p>
        </div>
      ) : (
        <div className="table-container">
          <table className="data-table">
            <thead>
              <tr>
                <th>Foil Grade / Code</th>
                <th>Current Stock</th>
                <th>Unit</th>
                {isOwner && <th>Cost Price / KG (₹)</th>}
                <th>Min Threshold</th>
                <th>Status</th>
                <th style={{ textAlign: 'right' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr
                  key={item.id}
                  className={item.is_low_stock || item.quantity <= item.low_stock_threshold ? 'row-low-stock' : ''}
                >
                  <td>
                    <div style={{ fontWeight: 700, fontSize: 14 }} className="mono">
                      {item.item_id}
                    </div>
                  </td>
                  <td>
                    <span
                      style={{
                        fontSize: 16,
                        fontWeight: 700,
                        color: item.is_low_stock ? 'var(--amber-text)' : 'var(--text-primary)',
                      }}
                      className="mono"
                    >
                      {item.quantity}
                    </span>
                  </td>
                  <td>
                    <span className="badge badge-gold">KGS</span>
                  </td>
                  {isOwner && (
                    <td className="mono" style={{ color: 'var(--teal-deep)', fontWeight: 600 }}>
                      ₹{item.cost_price !== undefined ? item.cost_price.toFixed(2) : '—'}
                    </td>
                  )}
                  <td className="mono" style={{ color: 'var(--text-secondary)' }}>
                    {item.low_stock_threshold}
                  </td>
                  <td>
                    {item.is_low_stock ? (
                      <span className="badge badge-amber" style={{ display: 'inline-flex', gap: 4 }}>
                        <AlertTriangle size={11} /> Low Stock
                      </span>
                    ) : (
                      <span className="badge badge-emerald" style={{ display: 'inline-flex', gap: 4 }}>
                        <CheckCircle2 size={11} /> In Stock
                      </span>
                    )}
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    <div style={{ display: 'inline-flex', gap: 6 }}>
                      {onQuickOperate && (
                        <button
                          onClick={() => onQuickOperate('foil', item)}
                          className="btn btn-secondary"
                          style={{ padding: '5px 10px', fontSize: 12 }}
                        >
                          Adjust
                        </button>
                      )}
                      {isOwner && (
                        <>
                          <button
                            onClick={() => openEditModal(item)}
                            className="btn btn-secondary"
                            style={{ padding: '5px 8px' }}
                            title="Edit"
                          >
                            <Edit2 size={13} />
                          </button>
                          <button
                            onClick={() => handleDelete(item)}
                            className="btn btn-danger"
                            style={{ padding: '5px 8px' }}
                            title="Delete"
                          >
                            <Trash2 size={13} />
                          </button>
                        </>
                      )}
                    </div>
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
            Page {page} of {totalPages}
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

      {/* Create Modal */}
      {isCreateOpen && (
        <div className="modal-backdrop">
          <div className="modal-content">
            <div className="modal-header">
              <h3 style={{ fontSize: 16, fontWeight: 700 }}>Add Foil Item</h3>
              <button
                onClick={() => setIsCreateOpen(false)}
                style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer' }}
              >
                <X size={18} />
              </button>
            </div>
            <form onSubmit={handleCreateSubmit}>
              <div className="modal-body">
                <div className="form-group">
                  <label className="form-label">
                    Foil Code / Grade <span className="required">*</span>
                  </label>
                  <input
                    type="text"
                    className="input mono"
                    placeholder="e.g. SILVER-FOIL-999"
                    value={formItemId}
                    onChange={(e) => setFormItemId(e.target.value)}
                    required
                  />
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                  <div className="form-group">
                    <label className="form-label">
                      Initial Weight (KGS) <span className="required">*</span>
                    </label>
                    <input
                      type="number"
                      step="any"
                      min="0"
                      className="input mono"
                      placeholder="e.g. 15.5"
                      value={formQty}
                      onChange={(e) => setFormQty(e.target.value === '' ? '' : Number(e.target.value))}
                      required
                    />
                  </div>

                  <div className="form-group">
                    <label className="form-label">Fixed Unit</label>
                    <input type="text" className="input mono" value="KGS" disabled readOnly />
                  </div>
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                  <div className="form-group">
                    <label className="form-label">
                      Low Stock Threshold (KGS) <span className="required">*</span>
                    </label>
                    <input
                      type="number"
                      step="any"
                      min="0"
                      className="input mono"
                      placeholder="e.g. 5"
                      value={formThreshold}
                      onChange={(e) => setFormThreshold(e.target.value === '' ? '' : Number(e.target.value))}
                      required
                    />
                  </div>

                  <div className="form-group">
                    <label className="form-label">
                      Cost Price / KG (₹) <span className="required">*</span>
                    </label>
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      className="input mono"
                      placeholder="e.g. 78500.00"
                      value={formCost}
                      onChange={(e) => setFormCost(e.target.value === '' ? '' : Number(e.target.value))}
                      required
                    />
                  </div>
                </div>
              </div>
              <div className="modal-footer">
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => setIsCreateOpen(false)}
                >
                  Cancel
                </button>
                <button type="submit" className="btn btn-primary" disabled={isSubmitting}>
                  {isSubmitting ? <Loader2 size={14} className="animate-spin" /> : 'Create Foil Item'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Edit Modal */}
      {isEditOpen && activeItem && (
        <div className="modal-backdrop">
          <div className="modal-content">
            <div className="modal-header">
              <h3 style={{ fontSize: 16, fontWeight: 700 }}>Edit {activeItem.item_id}</h3>
              <button
                onClick={() => setIsEditOpen(false)}
                style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer' }}
              >
                <X size={18} />
              </button>
            </div>
            <form onSubmit={handleEditSubmit}>
              <div className="modal-body">
                <div className="form-group">
                  <label className="form-label">Foil Code / Grade</label>
                  <input
                    type="text"
                    className="input mono"
                    value={formItemId}
                    onChange={(e) => setFormItemId(e.target.value)}
                    required
                  />
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                  <div className="form-group">
                    <label className="form-label">Low Stock Threshold (KGS)</label>
                    <input
                      type="number"
                      step="any"
                      min="0"
                      className="input mono"
                      value={formThreshold}
                      onChange={(e) => setFormThreshold(e.target.value === '' ? '' : Number(e.target.value))}
                      required
                    />
                  </div>

                  <div className="form-group">
                    <label className="form-label">Cost Price / KG (₹)</label>
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      className="input mono"
                      value={formCost}
                      onChange={(e) => setFormCost(e.target.value === '' ? '' : Number(e.target.value))}
                      required
                    />
                  </div>
                </div>
              </div>
              <div className="modal-footer">
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => setIsEditOpen(false)}
                >
                  Cancel
                </button>
                <button type="submit" className="btn btn-primary" disabled={isSubmitting}>
                  {isSubmitting ? <Loader2 size={14} className="animate-spin" /> : 'Save Changes'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
