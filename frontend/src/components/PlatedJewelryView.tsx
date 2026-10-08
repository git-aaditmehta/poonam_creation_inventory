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
  ArrowUpDown,
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
  const [activeItem, setActiveItem] = useState<PlatedJewelryItem | null>(null);
  const [detailItem, setDetailItem] = useState<PlatedJewelryItem | null>(null);

  // Form states
  const [formItemId, setFormItemId] = useState('');
  const [formQty, setFormQty] = useState<number | ''>('');
  const [formUnit, setFormUnit] = useState<InventoryUnit>('PC');
  const [formThreshold, setFormThreshold] = useState<number | ''>('');
  const [formCost, setFormCost] = useState<number | ''>('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Image upload state — used in both create and standalone upload
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [previewThumb, setPreviewThumb] = useState<string | null>(null);
  const [isUploading, setIsUploading] = useState(false);

  // Standalone image upload modal (for existing items)
  const [isUploadOpen, setIsUploadOpen] = useState(false);

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

  useEffect(() => { fetchItems(); }, [fetchItems]);
  useEffect(() => { fetchValuation(); }, [fetchValuation]);

  const handleCreateSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formItemId.trim() || formQty === '' || formThreshold === '' || formCost === '') {
      showToast('error', 'Validation Error', 'All fields are strictly required');
      return;
    }

    setIsSubmitting(true);
    try {
      // Step 1: Create the item
      const result = await api.inventory.createItem('plated-jewelry', {
        item_id: formItemId.trim(),
        quantity: Number(formQty),
        unit: formUnit,
        low_stock_threshold: Number(formThreshold),
        cost_price: Number(formCost),
      });

      // Step 2: If an image was selected, upload it immediately
      if (selectedFile && result?.id) {
        try {
          const processed = await processJewelryImage(selectedFile);
          const ext = processed.fullBlob.type === 'image/jpeg' ? 'jpg' : 'webp';
          const formData = new FormData();
          formData.append('item_id', result.id);
          formData.append('full_image', processed.fullBlob, `full.${ext}`);
          formData.append('thumb_image', processed.thumbBlob, `thumb.${ext}`);
          await api.images.upload(formData);
        } catch (imgErr: any) {
          showToast('warning', 'Item created, image failed', imgErr.message);
        }
      }

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
      setDetailItem(null);
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
    } finally {
      // Clear input value so selecting or capturing another photo with identical filename triggers onChange reliably on mobile
      e.target.value = '';
    }
  };

  const handleUploadSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedFile || !activeItem) return;

    setIsUploading(true);
    try {
      const processed = await processJewelryImage(selectedFile);
      const ext = processed.fullBlob.type === 'image/jpeg' ? 'jpg' : 'webp';
      const formData = new FormData();
      formData.append('item_id', activeItem.id);
      formData.append('full_image', processed.fullBlob, `full.${ext}`);
      formData.append('thumb_image', processed.thumbBlob, `thumb.${ext}`);
      const uploadRes = await api.images.upload(formData);
      showToast('success', 'Image Uploaded', `Image saved for ${activeItem.item_id}`);
      if (detailItem && detailItem.id === activeItem.id) {
        setDetailItem({
          ...detailItem,
          image_key: uploadRes.image_key,
          thumb_key: uploadRes.thumb_key,
          updated_at: new Date().toISOString(),
        });
      }
      setIsUploadOpen(false);
      setSelectedFile(null);
      setPreviewThumb(null);
      const fileInput = document.getElementById('image-file-input') as HTMLInputElement | null;
      if (fileInput) fileInput.value = '';
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
    setSelectedFile(null);
    setPreviewThumb(null);
    const createFileInput = document.getElementById('create-image-input') as HTMLInputElement | null;
    if (createFileInput) createFileInput.value = '';
    const standaloneFileInput = document.getElementById('image-file-input') as HTMLInputElement | null;
    if (standaloneFileInput) standaloneFileInput.value = '';
  };

  return (
    <div style={{ padding: '24px', maxWidth: '1400px', margin: '0 auto', width: '100%' }}>
      {/* Header Row */}
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
          <h2 style={{ fontSize: 20, fontWeight: 700 }}>Plated Jewelry</h2>
          <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 2 }}>
            {total} designs in catalog
          </p>
        </div>

        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          {isOwner && valuation !== null && (
            <div
              style={{
                background: 'var(--bg-surface-1)',
                border: '1px solid var(--border-subtle)',
                borderRadius: 'var(--radius-md)',
                padding: '8px 14px',
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                boxShadow: 'var(--shadow-sm)',
              }}
            >
              <IndianRupee size={15} color="var(--teal-deep)" />
              <div>
                <div style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                  Total Value
                </div>
                <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--teal-deep)' }} className="mono">
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
              <Plus size={15} /> Add Item
            </button>
          )}
        </div>
      </div>

      {/* Search Bar */}
      <div
        style={{
          display: 'flex',
          gap: 12,
          alignItems: 'center',
          marginBottom: 20,
        }}
      >
        <div style={{ position: 'relative', flex: 1, maxWidth: 420 }}>
          <Search size={16} color="var(--text-muted)" style={{ position: 'absolute', left: 12, top: 11 }} />
          <input
            type="text"
            className="input"
            style={{ paddingLeft: 38 }}
            placeholder="Search by design code..."
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
          />
        </div>
        <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
          {items.length} of {total}
        </div>
      </div>

      {/* Grid */}
      {isLoading ? (
        <div style={{ textAlign: 'center', padding: '60px 0', color: 'var(--text-muted)' }}>
          <Loader2 size={28} className="animate-spin" style={{ margin: '0 auto 12px' }} />
          <div style={{ fontSize: 13 }}>Loading catalog...</div>
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
          <Package size={36} color="var(--text-muted)" style={{ margin: '0 auto 12px' }} />
          <h3 style={{ fontSize: 15, color: 'var(--text-primary)' }}>No Items Found</h3>
          <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 4 }}>
            {search ? 'No designs match your search.' : 'Start by adding your first plated jewelry design.'}
          </p>
        </div>
      ) : (
        <div className="grid-cards">
          {items.map((item) => (
            <div
              key={item.id}
              className="card"
              style={{ display: 'flex', flexDirection: 'column', cursor: 'pointer' }}
              onClick={() => setDetailItem(item)}
            >
              {/* Image */}
              <div
                style={{
                  position: 'relative',
                  aspectRatio: '4 / 4',
                  background: '#F9F8F5',
                  borderRadius: 'var(--radius-md)',
                  overflow: 'hidden',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  marginBottom: 12,
                  border: '1px solid var(--border-subtle)',
                }}
              >
                {item.thumb_key ? (
                  <img
                    src={`/api/images/${item.thumb_key}?t=${encodeURIComponent(item.updated_at || '')}`}
                    alt={item.item_id}
                    style={{
                      width: '100%',
                      height: '100%',
                      objectFit: 'contain',
                      padding: 8,
                    }}
                    loading="lazy"
                  />
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', color: 'var(--text-muted)' }}>
                    <ImageIcon size={28} />
                    <span style={{ fontSize: 10, marginTop: 4 }}>No Photo</span>
                  </div>
                )}

                {/* Low stock badge */}
                {item.is_low_stock && (
                  <span
                    className="badge badge-amber"
                    style={{
                      position: 'absolute', top: 8, left: 8,
                      display: 'flex', gap: 3, alignItems: 'center', fontSize: 10,
                    }}
                  >
                    <AlertTriangle size={10} /> Low
                  </span>
                )}
              </div>

              {/* Info Row */}
              <div style={{ flex: 1 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }} className="mono">
                    {item.item_id}
                  </span>
                  <span className="badge badge-gold" style={{ fontSize: 10 }}>{item.unit}</span>
                </div>

                <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 8, alignItems: 'baseline' }}>
                  <div>
                    <div
                      style={{
                        fontSize: 16, fontWeight: 700,
                        color: item.is_low_stock ? 'var(--amber-text)' : 'var(--text-primary)',
                      }}
                      className="mono"
                    >
                      {item.quantity} <span style={{ fontSize: 11, fontWeight: 500, color: 'var(--text-muted)' }}>{item.unit}</span>
                    </div>
                  </div>
                  {isOwner && item.cost_price !== undefined && (
                    <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--teal-deep)' }} className="mono">
                      ₹{item.cost_price.toFixed(2)}
                    </div>
                  )}
                </div>
              </div>

              {/* Quick Actions */}
              <div
                style={{
                  display: 'flex',
                  gap: 6,
                  marginTop: 12,
                  paddingTop: 10,
                  borderTop: '1px solid var(--border-subtle)',
                }}
                onClick={(e) => e.stopPropagation()}
              >
                {onQuickOperate && (
                  <button
                    onClick={() => onQuickOperate('plated_jewelry', item)}
                    className="btn btn-secondary"
                    style={{ flex: 1, padding: '5px', fontSize: 11 }}
                  >
                    <ArrowUpDown size={12} /> Stock
                  </button>
                )}
                {isOwner && (
                  <>
                    <button
                      onClick={() => openUploadModal(item)}
                      className="btn btn-secondary"
                      style={{ padding: '5px 7px' }}
                      title="Upload image"
                    >
                      <Upload size={12} />
                    </button>
                    <button
                      onClick={() => openEditModal(item)}
                      className="btn btn-secondary"
                      style={{ padding: '5px 7px' }}
                      title="Edit details"
                    >
                      <Edit2 size={12} />
                    </button>
                    <button
                      onClick={() => handleDelete(item)}
                      className="btn btn-danger"
                      style={{ padding: '5px 7px' }}
                      title="Delete"
                    >
                      <Trash2 size={12} />
                    </button>
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Pagination */}
      {totalPages > 1 && (
        <div style={{ display: 'flex', justifyContent: 'center', gap: 10, marginTop: 28, alignItems: 'center' }}>
          <button className="btn btn-secondary" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>
            Previous
          </button>
          <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
            Page <strong>{page}</strong> of <strong>{totalPages}</strong>
          </span>
          <button className="btn btn-secondary" disabled={page >= totalPages} onClick={() => setPage((p) => Math.min(totalPages, p + 1))}>
            Next
          </button>
        </div>
      )}

      {/* ==================== DETAIL PANEL ==================== */}
      {detailItem && (
        <div className="detail-overlay" onClick={() => setDetailItem(null)}>
          <div className="detail-panel" onClick={(e) => e.stopPropagation()}>
            {/* Image Side */}
            <div className="detail-panel-image">
              {detailItem.image_key || detailItem.thumb_key ? (
                <img
                  src={`/api/images/${detailItem.image_key || detailItem.thumb_key}?t=${encodeURIComponent(detailItem.updated_at || '')}`}
                  alt={detailItem.item_id}
                />
              ) : (
                <div style={{ textAlign: 'center', color: 'var(--text-muted)' }}>
                  <ImageIcon size={48} />
                  <div style={{ marginTop: 8, fontSize: 13 }}>No image uploaded</div>
                </div>
              )}
            </div>

            {/* Info Side */}
            <div className="detail-panel-info">
              <button
                onClick={() => setDetailItem(null)}
                style={{
                  alignSelf: 'flex-end',
                  background: 'var(--bg-surface-2)',
                  border: '1px solid var(--border-subtle)',
                  borderRadius: 'var(--radius-sm)',
                  width: 30, height: 30,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  cursor: 'pointer', color: 'var(--text-secondary)',
                  marginBottom: 12,
                }}
              >
                <X size={16} />
              </button>

              <h2 className="mono" style={{ fontSize: 22, fontWeight: 700, marginBottom: 4 }}>
                {detailItem.item_id}
              </h2>

              <div style={{ display: 'flex', gap: 8, marginBottom: 24 }}>
                <span className="badge badge-gold">{detailItem.unit}</span>
                {detailItem.is_low_stock ? (
                  <span className="badge badge-amber" style={{ display: 'flex', gap: 3, alignItems: 'center' }}>
                    <AlertTriangle size={10} /> Low Stock
                  </span>
                ) : (
                  <span className="badge badge-emerald" style={{ display: 'flex', gap: 3, alignItems: 'center' }}>
                    <CheckCircle2 size={10} /> In Stock
                  </span>
                )}
              </div>

              {/* Stats */}
              <div style={{
                display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12,
                marginBottom: 24,
              }}>
                <div style={{
                  background: 'var(--bg-surface-2)', borderRadius: 'var(--radius-md)',
                  padding: '14px 16px',
                }}>
                  <div style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 }}>
                    Quantity
                  </div>
                  <div className="mono" style={{
                    fontSize: 20, fontWeight: 700,
                    color: detailItem.is_low_stock ? 'var(--amber-text)' : 'var(--text-primary)',
                  }}>
                    {detailItem.quantity}
                  </div>
                </div>

                <div style={{
                  background: 'var(--bg-surface-2)', borderRadius: 'var(--radius-md)',
                  padding: '14px 16px',
                }}>
                  <div style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 }}>
                    Threshold
                  </div>
                  <div className="mono" style={{ fontSize: 20, fontWeight: 700, color: 'var(--text-primary)' }}>
                    {detailItem.low_stock_threshold}
                  </div>
                </div>

                {isOwner && detailItem.cost_price !== undefined && (
                  <div style={{
                    background: 'var(--bg-surface-2)', borderRadius: 'var(--radius-md)',
                    padding: '14px 16px', gridColumn: '1 / -1',
                  }}>
                    <div style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 }}>
                      Cost Price
                    </div>
                    <div className="mono" style={{ fontSize: 20, fontWeight: 700, color: 'var(--teal-deep)' }}>
                      ₹{detailItem.cost_price.toFixed(2)}
                    </div>
                  </div>
                )}
              </div>

              {/* Actions */}
              <div style={{ marginTop: 'auto', display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {onQuickOperate && (
                  <button
                    onClick={() => {
                      setDetailItem(null);
                      onQuickOperate('plated_jewelry', detailItem);
                    }}
                    className="btn btn-primary"
                    style={{ flex: 1 }}
                  >
                    <ArrowUpDown size={14} /> Adjust Stock
                  </button>
                )}
                {isOwner && (
                  <>
                    <button
                      onClick={() => {
                        setDetailItem(null);
                        openUploadModal(detailItem);
                      }}
                      className="btn btn-secondary"
                    >
                      <Upload size={14} />
                    </button>
                    <button
                      onClick={() => {
                        setDetailItem(null);
                        openEditModal(detailItem);
                      }}
                      className="btn btn-secondary"
                    >
                      <Edit2 size={14} />
                    </button>
                    <button
                      onClick={() => handleDelete(detailItem)}
                      className="btn btn-danger"
                    >
                      <Trash2 size={14} />
                    </button>
                  </>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ==================== CREATE MODAL (combined with image) ==================== */}
      {isCreateOpen && (
        <div className="modal-backdrop">
          <div className="modal-content" style={{ maxWidth: 580 }}>
            <div className="modal-header">
              <h3 style={{ fontSize: 16, fontWeight: 700 }}>Add Plated Jewelry</h3>
              <button
                onClick={() => setIsCreateOpen(false)}
                style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer' }}
              >
                <X size={18} />
              </button>
            </div>
            <form onSubmit={handleCreateSubmit}>
              <div className="modal-body">
                {/* Image Upload Zone — integrated */}
                <div style={{ marginBottom: 18 }}>
                  <label className="form-label" style={{ marginBottom: 8, display: 'block' }}>
                    Product Image <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>(optional)</span>
                  </label>
                  <div
                    style={{
                      border: '2px dashed var(--border-medium)',
                      borderRadius: 'var(--radius-md)',
                      padding: previewThumb ? '12px' : '28px 16px',
                      textAlign: 'center',
                      cursor: 'pointer',
                      background: 'var(--bg-surface-2)',
                      transition: 'border-color 0.15s',
                    }}
                    onClick={() => document.getElementById('create-image-input')?.click()}
                    onDragOver={(e) => { e.preventDefault(); e.currentTarget.style.borderColor = 'var(--teal-mid)'; }}
                    onDragLeave={(e) => { e.currentTarget.style.borderColor = 'var(--border-medium)'; }}
                    onDrop={async (e) => {
                      e.preventDefault();
                      e.currentTarget.style.borderColor = 'var(--border-medium)';
                      const file = e.dataTransfer.files?.[0];
                      if (file && file.type.startsWith('image/')) {
                        try {
                          setSelectedFile(file);
                          const processed = await processJewelryImage(file);
                          setPreviewThumb(processed.thumbDataUrl);
                        } catch (err: any) {
                          showToast('error', 'Image Processing Failed', err.message);
                        }
                      }
                    }}
                  >
                    {previewThumb ? (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
                        <img
                          src={previewThumb}
                          alt="Preview"
                          style={{
                            width: 80, height: 80,
                            objectFit: 'contain',
                            borderRadius: 'var(--radius-sm)',
                            background: '#fff',
                            border: '1px solid var(--border-subtle)',
                          }}
                        />
                        <div style={{ textAlign: 'left', flex: 1 }}>
                          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--emerald-text)' }}>
                            Image ready
                          </div>
                          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
                            {selectedFile?.name} — Click to change
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setSelectedFile(null);
                            setPreviewThumb(null);
                          }}
                          style={{
                            background: 'none', border: 'none',
                            color: 'var(--text-muted)', cursor: 'pointer', padding: 4,
                          }}
                        >
                          <X size={16} />
                        </button>
                      </div>
                    ) : (
                      <>
                        <Upload size={24} color="var(--text-muted)" style={{ margin: '0 auto 6px' }} />
                        <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-secondary)' }}>
                          Click or drag to add a photo
                        </div>
                        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
                          Auto-compressed to WebP
                        </div>
                      </>
                    )}
                    <input
                      id="create-image-input"
                      type="file"
                      accept="image/*"
                      style={{ display: 'none' }}
                      onChange={handleImageFileChange}
                    />
                  </div>
                </div>

                {/* Fields */}
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
                      Quantity <span className="required">*</span>
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
                <button type="button" className="btn btn-secondary" onClick={() => setIsCreateOpen(false)}>
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

      {/* ==================== EDIT MODAL ==================== */}
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
                    <select className="select" value={formUnit} onChange={(e) => setFormUnit(e.target.value as InventoryUnit)}>
                      <option value="PC">PC</option>
                      <option value="KGS">KGS</option>
                      <option value="SET">SET</option>
                      <option value="JODI">JODI</option>
                    </select>
                  </div>
                  <div className="form-group">
                    <label className="form-label">Threshold</label>
                    <input
                      type="number" step="any" min="0" className="input mono"
                      value={formThreshold}
                      onChange={(e) => setFormThreshold(e.target.value === '' ? '' : Number(e.target.value))}
                      required
                    />
                  </div>
                </div>

                <div className="form-group">
                  <label className="form-label">Cost Price (₹)</label>
                  <input
                    type="number" step="0.01" min="0" className="input mono"
                    value={formCost}
                    onChange={(e) => setFormCost(e.target.value === '' ? '' : Number(e.target.value))}
                    required
                  />
                  <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                    Quantity adjustments must be done via Stock Operations.
                  </span>
                </div>
              </div>
              <div className="modal-footer">
                <button type="button" className="btn btn-secondary" onClick={() => setIsEditOpen(false)}>Cancel</button>
                <button type="submit" className="btn btn-primary" disabled={isSubmitting}>
                  {isSubmitting ? <Loader2 size={14} className="animate-spin" /> : 'Save Changes'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ==================== UPLOAD IMAGE MODAL ==================== */}
      {isUploadOpen && activeItem && (
        <div className="modal-backdrop">
          <div className="modal-content">
            <div className="modal-header">
              <h3 style={{ fontSize: 16, fontWeight: 700 }}>Upload Image — {activeItem.item_id}</h3>
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
                    transition: 'border-color 0.15s',
                  }}
                  onClick={() => document.getElementById('image-file-input')?.click()}
                  onDragOver={(e) => { e.preventDefault(); e.currentTarget.style.borderColor = 'var(--teal-mid)'; }}
                  onDragLeave={(e) => { e.currentTarget.style.borderColor = 'var(--border-medium)'; }}
                  onDrop={async (e) => {
                    e.preventDefault();
                    e.currentTarget.style.borderColor = 'var(--border-medium)';
                    const file = e.dataTransfer.files?.[0];
                    if (file && file.type.startsWith('image/')) {
                      try {
                        setSelectedFile(file);
                        const processed = await processJewelryImage(file);
                        setPreviewThumb(processed.thumbDataUrl);
                      } catch (err: any) {
                        showToast('error', 'Image Processing Failed', err.message);
                      }
                    }
                  }}
                >
                  {previewThumb ? (
                    <div>
                      <img
                        src={previewThumb}
                        alt="Preview"
                        style={{
                          width: 120, height: 120,
                          objectFit: 'contain',
                          borderRadius: 'var(--radius-md)',
                          margin: '0 auto',
                          background: '#fff',
                          border: '1px solid var(--border-subtle)',
                        }}
                      />
                      <div style={{ fontSize: 12, color: 'var(--emerald-text)', marginTop: 8 }}>
                        Ready to upload — {selectedFile?.name}
                      </div>
                    </div>
                  ) : (
                    <div>
                      <Upload size={28} color="var(--text-muted)" style={{ margin: '0 auto 8px' }} />
                      <div style={{ fontSize: 13, fontWeight: 500 }}>Click to choose image</div>
                      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
                        Auto-compressed to WebP
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
                <button type="button" className="btn btn-secondary" onClick={() => setIsUploadOpen(false)}>Cancel</button>
                <button type="submit" className="btn btn-primary" disabled={!selectedFile || isUploading}>
                  {isUploading ? <Loader2 size={14} className="animate-spin" /> : 'Upload Image'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
