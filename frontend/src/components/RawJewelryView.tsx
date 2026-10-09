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
import type { RawJewelryItem, InventoryUnit, User } from '../types';
import { useToast } from '../context/ToastContext';
import { GeneratePdfButton } from './GeneratePdfButton';

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

  const fetchItems = useCallback(async () => {
    setIsLoading(true);
    try {
      const res = await api.inventory.listRaw({ page, limit: 30, search: search.trim() || undefined });
      setItems(res.items);
      setTotal(res.total);
      setTotalPages(res.totalPages || 1);
    } catch (err: any) {
      showToast('error', 'Failed to load raw jewelry items', err.message);
    } finally {
      setIsLoading(false);
    }
  }, [page, search, showToast]);

  useEffect(() => {
    fetchItems();
  }, [fetchItems]);

  const handleCreateSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formItemId.trim() || formQty === '' || formThreshold === '') {
      showToast('error', 'Validation Error', 'All fields are strictly required');
      return;
    }

    setIsSubmitting(true);
    try {
      await api.inventory.createItem('raw-jewelry', {
        item_id: formItemId.trim(),
        quantity: Number(formQty),
        unit: formUnit,
        low_stock_threshold: Number(formThreshold),
      });
      showToast('success', 'Raw Casting Item Added', `${formItemId} saved to inventory`);
      setIsCreateOpen(false);
      resetForm();
      fetchItems();
    } catch (err: any) {
      showToast('error', 'Creation Failed', err.message);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleEditSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
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
      showToast('error', 'Update Failed', err.message);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDelete = async (item: RawJewelryItem) => {
    if (!confirm(`Delete raw casting design ${item.item_id}?`)) return;

    try {
      await api.inventory.deleteItem('raw-jewelry', item.id);
      showToast('success', 'Item Deleted', `${item.item_id} removed`);
      fetchItems();
    } catch (err: any) {
      showToast('error', 'Delete Failed', err.message);
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

        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
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
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 20 }}>
        <div style={{ position: 'relative', flex: 1, maxWidth: 400 }}>
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
                      step="any"
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
                    </select>
                  </div>
                </div>

                <div className="form-group">
                  <label className="form-label">
                    Low Stock Threshold <span className="required">*</span>
                  </label>
                  <input
                    type="number"
                    step="any"
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
                    </select>
                  </div>

                  <div className="form-group">
                    <label className="form-label">Low Stock Threshold</label>
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
