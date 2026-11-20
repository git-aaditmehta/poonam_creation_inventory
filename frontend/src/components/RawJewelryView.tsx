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
  Layers,
} from 'lucide-react';
import { api } from '../api';
import { localDb } from '../lib/localDb';
import { isLowStock } from '../utils/lowStock';
import { ITEM_KEY_SQL, itemKey } from '../utils/itemId';
import { JewelryCategoryChips } from './JewelryCategoryChips';
import { jewelryCategoryWhere, useJewelryTypes, type JewelryCategory } from '../utils/jewelryCategory';
import type { RawJewelryItem, InventoryUnit, User } from '../types';
import { useToast } from '../context/ToastContext';
import { blockIfOffline, OFFLINE_TITLE } from '../utils/offlineGuard';
import { GeneratePdfButton } from './GeneratePdfButton';
import { emitSyncStatus } from './SyncStatusBar';
import { parseFriendlyError, errorText } from '../utils/friendlyErrors';

interface RawJewelryViewProps {
  user: User;
  onQuickOperate?: (category: 'raw_jewelry', item: RawJewelryItem) => void;
}

export const RawJewelryView: React.FC<RawJewelryViewProps> = ({ user, onQuickOperate }) => {
  const isOwner = user.role === 'owner';
  const { showToast } = useToast();

  const [items, setItems] = useState<RawJewelryItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [search, setSearch] = useState('');
  // Jewelry-type chips: always start on All (not remembered)
  const [jewelryCat, setJewelryCat] = useState<JewelryCategory | null>(null);
  const jewelryTypes = useJewelryTypes(); // a type added by the owner shows up here at once
  const [catCounts, setCatCounts] = useState<Record<string, number> | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  // Modals
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [isEditOpen, setIsEditOpen] = useState(false);
  const [activeItem, setActiveItem] = useState<RawJewelryItem | null>(null);

  // Forms
  const [formItemId, setFormItemId] = useState('');
  const [formQty, setFormQty] = useState<number | ''>('');
  const [formUnit, setFormUnit] = useState<InventoryUnit>('PC');
  const [formThreshold, setFormThreshold] = useState<number | ''>('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const fetchItems = useCallback(async (forceCloud = false) => {
    setIsLoading(true);
    const catFilter = jewelryCat ? jewelryCategoryWhere(jewelryCat) : undefined;
    // Chip counts come from this phone's copy (instant, offline); never block the list on them
    const counts = await localDb.countByJewelryCategory('raw_jewelry').catch(() => null);
    // No numbers until this phone's copy has data (a first load is served from the cloud): never show false zeros
    setCatCounts(counts && counts.all > 0 ? counts : null);
    try {
      if (!forceCloud) {
        const res = await localDb.getItemsPaginated<RawJewelryItem>('raw_jewelry', page, 30, search.trim() || undefined, catFilter);
        // With a chip selected, an empty result is real when this phone has items at all (no cloud round trip)
        if (res.total > 0 || !navigator.onLine || (catFilter && (counts?.all ?? 0) > 0)) {
          setItems(res.items);
          setTotal(res.total);
          setTotalPages(res.totalPages || 1);
          setIsLoading(false);
          return;
        }
      }

      const res = await api.inventory.listRaw({ page, limit: 30, search: search.trim() || undefined, category: jewelryCat || undefined });
      setItems(res.items);
      setTotal(res.total);
      setTotalPages(res.totalPages || 1);

      if (res.items.length > 0) {
        await localDb.bulkUpsert('raw_jewelry', res.items);
      }
    } catch (err: any) {
      try {
        const res = await localDb.getItemsPaginated<RawJewelryItem>('raw_jewelry', page, 30, search.trim() || undefined, catFilter);
        setItems(res.items);
        setTotal(res.total);
        setTotalPages(res.totalPages || 1);
      } catch {
        showToast('error', 'Failed to load raw jewelry items', errorText(err));
      }
    } finally {
      setIsLoading(false);
    }
  }, [page, search, jewelryCat, jewelryTypes, showToast]);

  useEffect(() => {
    fetchItems();
  }, [fetchItems]);

  useEffect(() => {
    const handler = () => fetchItems();
    window.addEventListener('localdb-change', handler);
    return () => window.removeEventListener('localdb-change', handler);
  }, [fetchItems]);

  const handleCreateSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (blockIfOffline(showToast, 'Adding an item')) return;
    const trimmedId = formItemId.trim();
    if (!trimmedId || formQty === '' || formThreshold === '') {
      const friendly = parseFriendlyError('Validation: Please fill all required fields', { categoryName: 'Raw Casting Jewelry' });
      showToast('error', friendly.title, `${friendly.message} ${friendly.solution}`);
      return;
    }

    // Fast local duplicate check (<1ms)
    try {
      // Same item if the ID differs only in capitals, spaces or dashes ("PS 365" = "ps-365")
      const existing = await localDb.get<{ item_id: string }>(
        `SELECT item_id FROM raw_jewelry WHERE ${ITEM_KEY_SQL} = ? AND is_deleted = 0`,
        [itemKey(trimmedId)]
      );
      if (existing) {
        showToast(
          'error',
          'Item ID already in use',
          `"${trimmedId}" already exists${existing.item_id !== trimmedId ? ` as "${existing.item_id}"` : ''} in Raw Jewelry. IDs that differ only in capitals, spaces or dashes are the same item. To change its quantity, use Stock Operations.`
        );
        return;
      }
    } catch { /* proceed */ }

    const clientId = 'raw_' + crypto.randomUUID();
    const qtyNum = Number(formQty);
    const thresholdNum = Number(formThreshold);
    const unitVal = formUnit;
    const nowIso = new Date().toISOString();

    const newItem: RawJewelryItem = {
      id: clientId,
      item_id: trimmedId,
      quantity: qtyNum,
      unit: unitVal,
      low_stock_threshold: thresholdNum,
      is_low_stock: qtyNum < thresholdNum,
      created_at: nowIso,
      updated_at: nowIso,
    };

    // 1. Optimistic local insert (<2ms)
    try {
      await localDb.upsertItem('raw_jewelry', newItem);
      setItems((prev) => [newItem, ...prev.filter((i) => i.id !== clientId)]);
      setTotal((t) => t + 1);
    } catch (dbErr) {
      console.warn('[RawJewelry] Local insert error:', dbErr);
    }

    // 2. Instant UI feedback (<5ms modal close)
    showToast('success', 'Raw Casting Item Added', `${trimmedId} added. Saving to the cloud…`);
    setIsCreateOpen(false);
    resetForm();

    // 3. Notify Sync Status Bar
    emitSyncStatus({
      state: 'syncing',
      title: 'Saving to Cloud',
      message: `Uploading ${trimmedId}...`,
      itemId: trimmedId,
      category: 'Raw Casting',
    });

    // 4. Background Cloudflare sync (non-blocking)
    (async () => {
      try {
        const res = await api.inventory.createItem('raw-jewelry', {
          item_id: trimmedId,
          quantity: qtyNum,
          unit: unitVal,
          low_stock_threshold: thresholdNum,
        });

        // Harmonize authoritative ID if different
        if (res?.id && res.id !== clientId) {
          await localDb.deleteItem('raw_jewelry', clientId);
          const authoritativeItem = { ...newItem, id: res.id, ...(res.item || {}) };
          await localDb.upsertItem('raw_jewelry', authoritativeItem);
          setItems((prev) => prev.map((i) => (i.id === clientId ? authoritativeItem : i)));
        }

        emitSyncStatus({
          state: 'synced',
          title: 'Saved to Cloud',
          message: `${trimmedId} is backed up to Cloudflare D1.`,
          itemId: trimmedId,
          category: 'Raw Casting',
        });
      } catch (err: any) {
        const friendly = parseFriendlyError(err, { categoryName: 'Raw Casting Jewelry', itemId: trimmedId });

        if (friendly.isOffline) {
          // Internet dropped while saving: nothing reached the cloud, so take the item back off this screen
          // (items are only ever created online — no false "saved locally" promise)
          await localDb.deleteItem('raw_jewelry', clientId);
          setItems((prev) => prev.filter((i) => i.id !== clientId));
          setTotal((t) => Math.max(0, t - 1));
          emitSyncStatus({
            state: 'error',
            title: OFFLINE_TITLE,
            message: `${trimmedId} was NOT saved: the internet connection dropped.`,
            solution: 'Connect to the internet and add it again. Stock in/out still works offline.',
            itemId: trimmedId,
            category: 'Raw Casting',
          });
          showToast('warning', OFFLINE_TITLE, `${trimmedId} was not saved. Connect to the internet and add it again.`);
        } else {
          // Rollback on duplicate or invalid error
          await localDb.deleteItem('raw_jewelry', clientId);
          setItems((prev) => prev.filter((i) => i.id !== clientId));
          setTotal((t) => Math.max(0, t - 1));

          emitSyncStatus({
            state: 'error',
            title: friendly.title,
            message: friendly.message,
            solution: friendly.solution,
            itemId: trimmedId,
            category: 'Raw Casting',
            error: friendly,
          });
          showToast('error', friendly.title, `${friendly.message} ${friendly.solution}`);
        }
      }
    })();
  };

  const handleEditSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (blockIfOffline(showToast, 'Editing an item')) return;
    if (!activeItem) return;

    setIsSubmitting(true);
    try {
      await api.inventory.updateItem('raw-jewelry', activeItem.id, {
        item_id: formItemId.trim(),
        unit: formUnit,
        low_stock_threshold: Number(formThreshold),
      });
      showToast('success', 'Raw Item Updated', `Updated metadata for ${formItemId}`);
      setIsEditOpen(false);
      fetchItems();
    } catch (err: any) {
      const friendly = parseFriendlyError(err, { categoryName: 'Raw Casting Jewelry', itemId: formItemId.trim() });
      showToast('error', friendly.title, `${friendly.message} ${friendly.solution}`);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDelete = async (item: RawJewelryItem) => {
    if (blockIfOffline(showToast, 'Deleting an item')) return;
    if (!confirm(`Delete raw casting design ${item.item_id}?`)) return;

    try {
      await api.inventory.deleteItem('raw-jewelry', item.id);
      await localDb.deleteItem('raw_jewelry', item.id);
      setItems((prev) => prev.filter((i) => i.id !== item.id));
      setTotal((t) => Math.max(0, t - 1));
      showToast('success', 'Item Deleted', `${item.item_id} removed`);
    } catch (err: any) {
      const friendly = parseFriendlyError(err, { categoryName: 'Raw Casting Jewelry', itemId: item.item_id });
      showToast('error', friendly.title, `${friendly.message} ${friendly.solution}`);
    }
  };

  const openEditModal = (item: RawJewelryItem) => {
    setActiveItem(item);
    setFormItemId(item.item_id);
    setFormUnit(item.unit);
    setFormThreshold(item.low_stock_threshold);
    setIsEditOpen(true);
  };

  const resetForm = () => {
    setFormItemId('');
    setFormQty('');
    setFormUnit('PC');
    setFormThreshold('');
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
          <h2 style={{ fontSize: 20, fontWeight: 700 }}>Raw Jewelry</h2>
          <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 2 }}>
            {total} casting designs tracked
          </p>
        </div>

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center' }}>
          <GeneratePdfButton
            category="raw-jewelry"
            categoryTitle="Raw Jewelry"
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
              <Plus size={16} /> New Raw Casting
            </button>
          )}
        </div>
      </div>

      {/* Search Toolbar */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center', marginBottom: 20 }}>
        <div style={{ position: 'relative', flex: '1 1 220px', maxWidth: 400 }}>
          <Search size={16} color="var(--text-muted)" style={{ position: 'absolute', left: 12, top: 11 }} />
          <input
            type="text"
            className="input"
            style={{ paddingLeft: 38 }}
            placeholder="Search raw casting ID..."
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
          />
        </div>
        <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>
          Showing <strong>{items.length}</strong> of <strong>{total}</strong> castings
        </div>
      </div>

      <JewelryCategoryChips
        value={jewelryCat}
        counts={catCounts}
        onChange={(v) => {
          setJewelryCat(v);
          setPage(1);
        }}
      />

      {/* Table */}
      {isLoading ? (
        <div style={{ textAlign: 'center', padding: '60px 0', color: 'var(--text-muted)' }}>
          <Loader2 size={32} className="animate-spin" style={{ margin: '0 auto 12px' }} />
          <div>Loading raw jewelry castings...</div>
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
          <Layers size={40} color="var(--text-muted)" style={{ margin: '0 auto 12px' }} />
          <h3 style={{ fontSize: 16 }}>No Raw Items Found</h3>
          <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 4 }}>
            {search ? 'No match found.' : 'Create a raw casting item to begin.'}
          </p>
        </div>
      ) : (
        <div className="table-container">
          <table className="data-table">
            <thead>
              <tr>
                <th>Design / Item Code</th>
                <th>Current Stock</th>
                <th>Unit</th>
                <th>Min Threshold</th>
                <th>Status</th>
                <th style={{ textAlign: 'right' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr
                  key={item.id}
                  className={isLowStock(item) ? 'row-low-stock' : ''}
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
                    <span className="badge badge-gold">{item.unit}</span>
                  </td>
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
                        <CheckCircle2 size={11} /> Healthy
                      </span>
                    )}
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    <div style={{ display: 'inline-flex', gap: 6 }}>
                      {onQuickOperate && (
                        <button
                          onClick={() => onQuickOperate('raw_jewelry', item)}
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
              <h3 style={{ fontSize: 16, fontWeight: 700 }}>Add Raw Casting Item</h3>
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
                    Design / Item Code <span className="required">*</span>
                  </label>
                  <input
                    type="text"
                    className="input mono"
                    placeholder="e.g. RAW-BANG-102"
                    value={formItemId}
                    onChange={(e) => setFormItemId(e.target.value)}
                    required
                  />
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                  <div className="form-group">
                    <label className="form-label">
                      Initial Quantity <span className="required">*</span>
                    </label>
                    <input
                      type="number"
                      step="1"
                      min="0"
                      className="input mono"
                      placeholder="e.g. 100"
                      value={formQty}
                      onChange={(e) => setFormQty(e.target.value === '' ? '' : Number(e.target.value))}
                      required
                    />
                  </div>

                  <div className="form-group">
                    <label className="form-label">Unit</label>
                    <select
                      className="select"
                      value={formUnit}
                      onChange={(e) => setFormUnit(e.target.value as InventoryUnit)}
                    >
                      <option value="PC">PC</option>
                      <option value="KGS">KGS</option>
                      <option value="SET">SET</option>
                      <option value="JODI">JODI</option>
                      <option value="GRMS">GRMS</option>
                    </select>
                  </div>
                </div>

                <div className="form-group">
                  <label className="form-label">
                    Low Stock Threshold <span className="required">*</span>
                  </label>
                  <input
                    type="number"
                    step="1"
                    min="0"
                    className="input mono"
                    placeholder="e.g. 20"
                    value={formThreshold}
                    onChange={(e) => setFormThreshold(e.target.value === '' ? '' : Number(e.target.value))}
                    required
                  />
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
                  {isSubmitting ? <Loader2 size={14} className="animate-spin" /> : 'Create Raw Item'}
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
                  <label className="form-label">Design / Item Code</label>
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
                    <label className="form-label">Unit</label>
                    <select
                      className="select"
                      value={formUnit}
                      onChange={(e) => setFormUnit(e.target.value as InventoryUnit)}
                    >
                      <option value="PC">PC</option>
                      <option value="KGS">KGS</option>
                      <option value="SET">SET</option>
                      <option value="JODI">JODI</option>
                      <option value="GRMS">GRMS</option>
                    </select>
                  </div>

                  <div className="form-group">
                    <label className="form-label">Low Stock Threshold</label>
                    <input
                      type="number"
                      step="1"
                      min="0"
                      className="input mono"
                      value={formThreshold}
                      onChange={(e) => setFormThreshold(e.target.value === '' ? '' : Number(e.target.value))}
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
