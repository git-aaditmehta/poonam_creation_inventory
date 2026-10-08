import React, { useState, useEffect, useCallback } from 'react';
import {
  Search,
  Plus,
  Image as ImageIcon,
  Upload,
  Edit2,
  Trash2,
  AlertTriangle,
  CheckCircle2,
  Loader2,
  X,
  IndianRupee,
  Package,
} from 'lucide-react';
import { api } from '../api';
import type { PlatedJewelryItem, InventoryUnit, User } from '../types';
import { useToast } from '../context/ToastContext';
import { processJewelryImage } from '../utils/imageProcessor';

interface PlatedJewelryViewProps {
  user: User;
  onQuickOperate?: (category: 'plated_jewelry', item: PlatedJewelryItem) => void;
}

export const PlatedJewelryView: React.FC<PlatedJewelryViewProps> = ({ user, onQuickOperate }) => {
  const isOwner = user.role === 'owner';
  const { showToast } = useToast();

  const [items, setItems] = useState<PlatedJewelryItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [search, setSearch] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [valuation, setValuation] = useState<number | null>(null);

  // Modals state
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [isEditOpen, setIsEditOpen] = useState(false);
  const [isUploadOpen, setIsUploadOpen] = useState(false);
  const [activeItem, setActiveItem] = useState<PlatedJewelryItem | null>(null);
  const [lightboxImage, setLightboxImage] = useState<string | null>(null);

  // Form states
  const [formItemId, setFormItemId] = useState('');
  const [formQty, setFormQty] = useState<number | ''>('');
  const [formUnit, setFormUnit] = useState<InventoryUnit>('PC');
  const [formThreshold, setFormThreshold] = useState<number | ''>('');
  const [formCost, setFormCost] = useState<number | ''>('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Image upload state
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [previewThumb, setPreviewThumb] = useState<string | null>(null);
  const [isUploading, setIsUploading] = useState(false);

  const fetchItems = useCallback(async () => {
    setIsLoading(true);
    try {
      const res = await api.inventory.listPlated({ page, limit: 30, search: search.trim() || undefined });
      setItems(res.items);
      setTotal(res.total);
      setTotalPages(res.totalPages || 1);
    } catch (err: any) {
      showToast('error', 'Failed to load items', err.message);
    } finally {
      setIsLoading(false);
    }
  }, [page, search, showToast]);

  const fetchValuation = useCallback(async () => {
    if (!isOwner) return;
    try {
      const res = await api.inventory.getValuation('plated-jewelry');
      setValuation(res.total_value);
    } catch {
      // ignore
    }
  }, [isOwner]);

  useEffect(() => {
    fetchItems();
  }, [fetchItems]);

  useEffect(() => {
    fetchValuation();
  }, [fetchValuation]);

  const handleCreateSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formItemId.trim() || formQty === '' || formThreshold === '' || formCost === '') {
      showToast('error', 'Validation Error', 'All fields are strictly required');
      return;
    }

    setIsSubmitting(true);
    try {
      await api.inventory.createItem('plated-jewelry', {
        item_id: formItemId.trim(),
        quantity: Number(formQty),
        unit: formUnit,
        low_stock_threshold: Number(formThreshold),
        cost_price: Number(formCost),
      });
      showToast('success', 'Item Created', `Added ${formItemId} to Plated Jewelry`);
      setIsCreateOpen(false);
      resetForm();
      fetchItems();
      fetchValuation();
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
      await api.inventory.updateItem('plated-jewelry', activeItem.id, {
        item_id: formItemId.trim(),
        unit: formUnit,
        low_stock_threshold: Number(formThreshold),
        cost_price: Number(formCost),
      });
      showToast('success', 'Item Updated', `Updated metadata for ${formItemId}`);
      setIsEditOpen(false);
      fetchItems();
      fetchValuation();
    } catch (err: any) {
      showToast('error', 'Update Failed', err.message);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDelete = async (item: PlatedJewelryItem) => {
    if (!confirm(`Are you sure you want to delete ${item.item_id}?`)) return;

    try {
      await api.inventory.deleteItem('plated-jewelry', item.id);
      showToast('success', 'Item Removed', `${item.item_id} deleted successfully`);
      fetchItems();
      fetchValuation();
    } catch (err: any) {
      showToast('error', 'Delete Failed', err.message);
    }
  };

  const handleImageFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    try {
      setSelectedFile(file);
      const processed = await processJewelryImage(file);
      setPreviewThumb(processed.thumbDataUrl);
    } catch (err: any) {
      showToast('error', 'Image Processing Failed', err.message);
    }
  };

  const handleUploadSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedFile || !activeItem) return;

    setIsUploading(true);
    try {
      const processed = await processJewelryImage(selectedFile);
      const formData = new FormData();
      formData.append('item_id', activeItem.id);
      formData.append('full_image', processed.fullBlob, 'full.webp');
      formData.append('thumb_image', processed.thumbBlob, 'thumb.webp');

      await api.images.upload(formData);
      showToast('success', 'Image Uploaded', `Synced to R2 for ${activeItem.item_id}`);
      setIsUploadOpen(false);
      setSelectedFile(null);
      setPreviewThumb(null);
      fetchItems();
    } catch (err: any) {
      showToast('error', 'Upload Failed', err.message);
    } finally {
      setIsUploading(false);
    }
  };

  const openEditModal = (item: PlatedJewelryItem) => {
    setActiveItem(item);
    setFormItemId(item.item_id);
    setFormUnit(item.unit);
    setFormThreshold(item.low_stock_threshold);
    setFormCost(item.cost_price || 0);
    setIsEditOpen(true);
  };

  const openUploadModal = (item: PlatedJewelryItem) => {
    setActiveItem(item);
    setSelectedFile(null);
    setPreviewThumb(null);
    setIsUploadOpen(true);
  };

  const resetForm = () => {
    setFormItemId('');
    setFormQty('');
    setFormUnit('PC');
    setFormThreshold('');
    setFormCost('');
  };

  return (
    <div style={{ padding: '24px', maxWidth: '1400px', margin: '0 auto', width: '100%' }}>
      {/* Top Banner & Stats */}
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
          <h2 style={{ fontSize: 22, fontWeight: 800 }}>Plated Jewelry Atelier</h2>
          <p style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
            Finished gold/rhodium plated designs with visual catalog and live stock balances.
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
              <IndianRupee size={16} color="var(--gold-primary)" />
              <div>
                <div style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase' }}>
                  Valuation
                </div>
                <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--gold-primary)' }} className="mono">
                  ₹{valuation.toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                </div>
              </div>
            </div>
          )}

          {isOwner && (
            <button
              onClick={() => {
                resetForm();
                setIsCreateOpen(true);
              }}
              className="btn btn-primary"
            >
              <Plus size={16} /> New Plated Item
            </button>
          )}
        </div>
      </div>

      {/* Search & Filter Toolbar */}
      <div
        style={{
          display: 'flex',
          gap: 12,
          alignItems: 'center',
          marginBottom: 20,
        }}
      >
        <div style={{ position: 'relative', flex: 1, maxWidth: 400 }}>
          <Search size={16} color="var(--text-muted)" style={{ position: 'absolute', left: 12, top: 11 }} />
          <input
            type="text"
            className="input"
            style={{ paddingLeft: 38 }}
            placeholder="Search design code / item ID..."
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
          />
        </div>
        <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>
          Showing <strong>{items.length}</strong> of <strong>{total}</strong> designs
        </div>
      </div>

      {/* Grid of Plated Jewelry Cards */}
      {isLoading ? (
        <div style={{ textAlign: 'center', padding: '60px 0', color: 'var(--text-muted)' }}>
          <Loader2 size={32} className="animate-spin" style={{ margin: '0 auto 12px' }} />
          <div>Loading plated jewelry catalog...</div>
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
          <Package size={40} color="var(--text-muted)" style={{ margin: '0 auto 12px' }} />
          <h3 style={{ fontSize: 16, color: 'var(--text-primary)' }}>No Items Found</h3>
          <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 4 }}>
            {search ? 'No design codes match your search.' : 'Start by creating your first plated jewelry design.'}
          </p>
        </div>
      ) : (
        <div className="grid-cards">
          {items.map((item) => (
            <div key={item.id} className="card" style={{ display: 'flex', flexDirection: 'column' }}>
              {/* Image Preview Box */}
              <div
                style={{
                  position: 'relative',
                  height: 160,
                  background: 'var(--bg-surface-2)',
                  borderRadius: 'var(--radius-md)',
                  overflow: 'hidden',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  marginBottom: 12,
                }}
              >
                {item.thumb_key ? (
                  <img
                    src={`/api/images/${item.thumb_key}`}
                    alt={item.item_id}
                    style={{ width: '100%', height: '100%', objectFit: 'cover', cursor: 'pointer' }}
                    onClick={() => setLightboxImage(item.image_key ? `/api/images/${item.image_key}` : `/api/images/${item.thumb_key}`)}
                  />
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', color: 'var(--text-muted)' }}>
                    <ImageIcon size={32} />
                    <span style={{ fontSize: 11, marginTop: 4 }}>No Photo</span>
                  </div>
                )}

                {/* Status Badges Overlay */}
                <div style={{ position: 'absolute', top: 8, left: 8 }}>
                  {item.is_low_stock ? (
                    <span className="badge badge-amber" style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                      <AlertTriangle size={11} /> Low Stock
                    </span>
                  ) : (
                    <span className="badge badge-emerald" style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                      <CheckCircle2 size={11} /> In Stock
                    </span>
                  )}
                </div>

                {isOwner && (
                  <button
                    onClick={() => openUploadModal(item)}
                    style={{
                      position: 'absolute',
                      bottom: 8,
                      right: 8,
                      background: 'rgba(18, 22, 32, 0.85)',
                      border: '1px solid var(--border-medium)',
                      color: 'var(--text-primary)',
                      borderRadius: 'var(--radius-sm)',
                      padding: '4px 8px',
                      fontSize: 11,
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 4,
                    }}
                    title="Upload photo"
                  >
                    <Upload size={12} /> {item.thumb_key ? 'Change' : 'Upload'}
                  </button>
                )}
              </div>

              {/* Item Info */}
              <div style={{ flex: 1 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary)' }} className="mono">
                    {item.item_id}
                  </div>
                  <span className="badge badge-gold">{item.unit}</span>
                </div>

                <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 12, alignItems: 'baseline' }}>
                  <div>
                    <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Current Quantity</span>
                    <div style={{ fontSize: 18, fontWeight: 800, color: item.is_low_stock ? 'var(--amber-text)' : 'var(--text-primary)' }} className="mono">
                      {item.quantity} {item.unit}
                    </div>
                  </div>

                  {isOwner && item.cost_price !== undefined && (
                    <div style={{ textAlign: 'right' }}>
                      <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Cost Price</span>
                      <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--gold-primary)' }} className="mono">
                        ₹{item.cost_price.toFixed(2)}
                      </div>
                    </div>
                  )}
                </div>

                <div style={{ marginTop: 8, fontSize: 11, color: 'var(--text-muted)' }}>
                  Min threshold: <span className="mono">{item.low_stock_threshold} {item.unit}</span>
                </div>
              </div>

              {/* Actions */}
              <div
                style={{
                  display: 'flex',
                  gap: 8,
                  marginTop: 14,
                  paddingTop: 12,
                  borderTop: '1px solid var(--border-subtle)',
                }}
              >
                {onQuickOperate && (
                  <button
                    onClick={() => onQuickOperate('plated_jewelry', item)}
                    className="btn btn-secondary"
                    style={{ flex: 1, padding: '6px', fontSize: 12 }}
                  >
                    Adjust Stock
                  </button>
                )}

                {isOwner && (
                  <>
                    <button
                      onClick={() => openEditModal(item)}
                      className="btn btn-secondary"
                      style={{ padding: '6px 8px' }}
                      title="Edit master details"
                    >
                      <Edit2 size={13} />
                    </button>
                    <button
                      onClick={() => handleDelete(item)}
                      className="btn btn-danger"
                      style={{ padding: '6px 8px' }}
                      title="Delete design"
                    >
                      <Trash2 size={13} />
                    </button>
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Pagination Footer */}
      {totalPages > 1 && (
        <div style={{ display: 'flex', justifyContent: 'center', gap: 10, marginTop: 28, alignItems: 'center' }}>
          <button
            className="btn btn-secondary"
            disabled={page <= 1}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
          >
            Previous
          </button>
          <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
            Page <strong>{page}</strong> of <strong>{totalPages}</strong>
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
              <h3 style={{ fontSize: 16, fontWeight: 700 }}>Add New Plated Jewelry</h3>
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
                  <label className="form-label" htmlFor="create-plated-id">
                    Design Code / Item ID <span className="required">*</span>
                  </label>
                  <input
                    id="create-plated-id"
                    type="text"
                    className="input mono"
                    placeholder="e.g. PJ-RING-501"
                    value={formItemId}
                    onChange={(e) => setFormItemId(e.target.value)}
                    required
                  />
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                  <div className="form-group">
                    <label className="form-label" htmlFor="create-plated-qty">
                      Initial Quantity <span className="required">*</span>
                    </label>
                    <input
                      id="create-plated-qty"
                      type="number"
                      step="any"
                      min="0"
                      className="input mono"
                      placeholder="e.g. 50"
                      value={formQty}
                      onChange={(e) => setFormQty(e.target.value === '' ? '' : Number(e.target.value))}
                      required
                    />
                  </div>

                  <div className="form-group">
                    <label className="form-label" htmlFor="create-plated-unit">
                      Unit <span className="required">*</span>
                    </label>
                    <select
                      id="create-plated-unit"
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

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                  <div className="form-group">
                    <label className="form-label" htmlFor="create-plated-thresh">
                      Low Stock Threshold <span className="required">*</span>
                    </label>
                    <input
                      id="create-plated-thresh"
                      type="number"
                      step="any"
                      min="0"
                      className="input mono"
                      placeholder="e.g. 10"
                      value={formThreshold}
                      onChange={(e) => setFormThreshold(e.target.value === '' ? '' : Number(e.target.value))}
                      required
                    />
                  </div>

                  <div className="form-group">
                    <label className="form-label" htmlFor="create-plated-cost">
                      Cost Price (₹) <span className="required">*</span>
                    </label>
                    <input
                      id="create-plated-cost"
                      type="number"
                      step="0.01"
                      min="0"
                      className="input mono"
                      placeholder="e.g. 1250.00"
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
                  {isSubmitting ? <Loader2 size={14} className="animate-spin" /> : 'Create Item'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Edit Metadata Modal */}
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
                  <label className="form-label">Design Code / Item ID</label>
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
                    <label className="form-label">Threshold</label>
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

                <div className="form-group">
                  <label className="form-label">Cost Price (₹)</label>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    className="input mono"
                    value={formCost}
                    onChange={(e) => setFormCost(e.target.value === '' ? '' : Number(e.target.value))}
                    required
                  />
                  <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                    Note: Quantity adjustments must be done via Stock Operations.
                  </span>
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

      {/* Upload Image Modal */}
      {isUploadOpen && activeItem && (
        <div className="modal-backdrop">
          <div className="modal-content">
            <div className="modal-header">
              <h3 style={{ fontSize: 16, fontWeight: 700 }}>Upload Image for {activeItem.item_id}</h3>
              <button
                onClick={() => setIsUploadOpen(false)}
                style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer' }}
              >
                <X size={18} />
              </button>
            </div>
            <form onSubmit={handleUploadSubmit}>
              <div className="modal-body">
                <div
                  style={{
                    border: '2px dashed var(--border-medium)',
                    borderRadius: 'var(--radius-md)',
                    padding: '24px',
                    textAlign: 'center',
                    cursor: 'pointer',
                    background: 'var(--bg-surface-2)',
                  }}
                  onClick={() => document.getElementById('image-file-input')?.click()}
                >
                  {previewThumb ? (
                    <div>
                      <img
                        src={previewThumb}
                        alt="Preview"
                        style={{ width: 140, height: 140, objectFit: 'cover', borderRadius: 'var(--radius-md)', margin: '0 auto' }}
                      />
                      <div style={{ fontSize: 12, color: 'var(--emerald-text)', marginTop: 8 }}>
                        Optimized WebP ready for R2
                      </div>
                    </div>
                  ) : (
                    <div>
                      <Upload size={32} color="var(--gold-primary)" style={{ margin: '0 auto 8px' }} />
                      <div style={{ fontSize: 14, fontWeight: 600 }}>Click to choose image</div>
                      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
                        Auto-compressed into high-res and thumbnail via Canvas
                      </div>
                    </div>
                  )}
                  <input
                    id="image-file-input"
                    type="file"
                    accept="image/*"
                    style={{ display: 'none' }}
                    onChange={handleImageFileChange}
                  />
                </div>
              </div>
              <div className="modal-footer">
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => setIsUploadOpen(false)}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="btn btn-primary"
                  disabled={!selectedFile || isUploading}
                >
                  {isUploading ? <Loader2 size={14} className="animate-spin" /> : 'Save to Cloudflare R2'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Lightbox Modal */}
      {lightboxImage && (
        <div
          className="modal-backdrop"
          onClick={() => setLightboxImage(null)}
          style={{ cursor: 'zoom-out' }}
        >
          <div
            style={{ position: 'relative', maxWidth: '90vw', maxHeight: '90vh' }}
            onClick={(e) => e.stopPropagation()}
          >
            <img
              src={lightboxImage}
              alt="Full size jewelry"
              style={{
                maxWidth: '90vw',
                maxHeight: '90vh',
                borderRadius: 'var(--radius-lg)',
                boxShadow: 'var(--shadow-lg)',
                border: '1px solid var(--border-medium)',
              }}
            />
            <button
              onClick={() => setLightboxImage(null)}
              style={{
                position: 'absolute',
                top: 12,
                right: 12,
                background: 'rgba(0,0,0,0.7)',
                border: 'none',
                color: '#fff',
                borderRadius: '50%',
                width: 32,
                height: 32,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                cursor: 'pointer',
              }}
            >
              <X size={18} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
