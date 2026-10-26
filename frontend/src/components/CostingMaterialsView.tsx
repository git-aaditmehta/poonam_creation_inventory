import React, { useState, useEffect, useCallback } from 'react';
import {
  FolderPlus,
  Plus,
  Search,
  Edit2,
  Trash2,
  AlertTriangle,
  AlertCircle,
  Layers,
  Sparkles,
  IndianRupee,
  ChevronRight,
  ArrowLeft,
  X,
} from 'lucide-react';
import {
  getCostingCategories,
  createCostingCategory,
  updateCostingCategory,
  canDeleteCostingCategory,
  deleteCostingCategory,
  getCostingMaterialsByCategory,
  addCostingMaterial,
  updateCostingMaterial,
  canDeleteCostingMaterial,
  deleteCostingMaterial,
  propagateMaterialCostPrice,
  type CostingCategory,
  type CostingMaterial,
} from '../lib/costingDb';
import { formatRupees, roundTo2 } from '../lib/costingEngine';
import { useToast } from '../context/ToastContext';

interface CostingMaterialsViewProps {
  onBack?: () => void;
  onMaterialsChanged?: () => void;
}

export const CostingMaterialsView: React.FC<CostingMaterialsViewProps> = ({
  onBack,
  onMaterialsChanged,
}) => {
  const { showToast } = useToast();

  const [categories, setCategories] = useState<CostingCategory[]>([]);
  const [selectedCategory, setSelectedCategory] = useState<CostingCategory | null>(null);
  const [materials, setMaterials] = useState<CostingMaterial[]>([]);
  const [searchQuery, setSearchQuery] = useState('');

  // Category Modals
  const [isAddCategoryOpen, setIsAddCategoryOpen] = useState(false);
  const [categoryNameInput, setCategoryNameInput] = useState('');
  const [editingCategory, setEditingCategory] = useState<CostingCategory | null>(null);

  // Material Modals
  const [isAddMaterialOpen, setIsAddMaterialOpen] = useState(false);
  const [materialNameInput, setMaterialNameInput] = useState('');
  const [materialWeightInput, setMaterialWeightInput] = useState('');
  const [materialPriceInput, setMaterialPriceInput] = useState('');

  // Editing Material / Price Change Modal
  const [editingMaterial, setEditingMaterial] = useState<CostingMaterial | null>(null);
  const [editPriceInput, setEditPriceInput] = useState('');
  const [editNameInput, setEditNameInput] = useState('');
  const [editWeightInput, setEditWeightInput] = useState('');
  const [showPriceConfirmModal, setShowPriceConfirmModal] = useState(false);
  const [pendingPriceChange, setPendingPriceChange] = useState<{
    material: CostingMaterial;
    newName: string;
    newWeight: number | null;
    newPrice: number;
  } | null>(null);

  // Load Categories
  const fetchCategories = useCallback(async () => {
    try {
      const cats = await getCostingCategories();
      setCategories(cats);
      // Keep selected category updated with new stats
      if (selectedCategory) {
        const updated = cats.find((c) => c.id === selectedCategory.id);
        if (updated) setSelectedCategory(updated);
      }
    } catch (err: any) {
      showToast('error', 'Error loading categories', err.message);
    }
  }, [selectedCategory, showToast]);

  // Load Materials for Selected Category
  const fetchMaterials = useCallback(async () => {
    if (!selectedCategory) {
      setMaterials([]);
      return;
    }
    try {
      const list = await getCostingMaterialsByCategory(selectedCategory.id, searchQuery);
      setMaterials(list);
    } catch (err: any) {
      showToast('error', 'Error loading materials', err.message);
    }
  }, [selectedCategory, searchQuery, showToast]);

  useEffect(() => {
    fetchCategories();
  }, []);

  useEffect(() => {
    fetchMaterials();
  }, [fetchMaterials]);

  // ── Category Handlers ──────────────────────────────────────────

  const handleCreateCategory = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!categoryNameInput.trim()) return;

    try {
      const newCat = await createCostingCategory(categoryNameInput.trim());
      showToast('success', 'Category Created', `Created category "${newCat.name}"`);
      setCategoryNameInput('');
      setIsAddCategoryOpen(false);
      await fetchCategories();
      setSelectedCategory(newCat);
    } catch (err: any) {
      showToast('error', 'Failed to create category', err.message);
    }
  };

  const handleUpdateCategory = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingCategory || !categoryNameInput.trim()) return;

    try {
      await updateCostingCategory(editingCategory.id, categoryNameInput.trim());
      showToast('success', 'Category Renamed', `Renamed to "${categoryNameInput.trim()}"`);
      setEditingCategory(null);
      setCategoryNameInput('');
      await fetchCategories();
    } catch (err: any) {
      showToast('error', 'Failed to rename category', err.message);
    }
  };

  const handleDeleteCategory = async (cat: CostingCategory) => {
    const check = await canDeleteCostingCategory(cat.id);
    if (!check.canDelete) {
      showToast('error', 'Cannot Delete Category', check.reason || 'This category cannot be deleted.');
      return;
    }

    if (!confirm(`Are you sure you want to delete category "${cat.name}"?`)) return;

    try {
      await deleteCostingCategory(cat.id);
      showToast('success', 'Category Deleted', `Category "${cat.name}" has been removed.`);
      if (selectedCategory?.id === cat.id) {
        setSelectedCategory(null);
      }
      await fetchCategories();
    } catch (err: any) {
      showToast('error', 'Failed to delete category', err.message);
    }
  };

  // ── Material Handlers ──────────────────────────────────────────

  const handleAddMaterial = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedCategory) return;

    const isHepoxy = selectedCategory.id === 'hepoxy';
    const name = isHepoxy ? materialWeightInput.trim() : materialNameInput.trim();
    if (!name) {
      showToast('error', 'Validation Error', isHepoxy ? 'Hepoxy weight is required.' : 'Material name/ID is required.');
      return;
    }

    const weight = isHepoxy
      ? parseFloat(materialWeightInput)
      : materialWeightInput ? parseFloat(materialWeightInput) : null;

    if (isHepoxy && (isNaN(weight!) || weight! <= 0)) {
      showToast('error', 'Validation Error', 'Hepoxy weight must be greater than zero.');
      return;
    }

    const costPrice = materialPriceInput.trim() !== '' ? parseFloat(materialPriceInput) : null;
    if (costPrice !== null && (isNaN(costPrice) || costPrice < 0)) {
      showToast('error', 'Validation Error', 'Cost price must be a valid positive number.');
      return;
    }

    try {
      await addCostingMaterial({
        category_id: selectedCategory.id,
        name,
        weight: weight !== null && !isNaN(weight) ? roundTo2(weight) : null,
        cost_price: costPrice !== null ? roundTo2(costPrice) : null,
      });

      showToast('success', 'Material Added', `${name} added to ${selectedCategory.name}`);
      setMaterialNameInput('');
      setMaterialWeightInput('');
      setMaterialPriceInput('');
      setIsAddMaterialOpen(false);
      await fetchMaterials();
      await fetchCategories();
      onMaterialsChanged?.();
    } catch (err: any) {
      showToast('error', 'Failed to add material', err.message);
    }
  };

  const openEditMaterialModal = (mat: CostingMaterial) => {
    setEditingMaterial(mat);
    setEditNameInput(mat.name);
    setEditWeightInput(mat.weight !== null ? String(mat.weight) : '');
    setEditPriceInput(mat.cost_price !== null ? String(mat.cost_price) : '');
  };

  const handleSaveMaterialEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingMaterial || !selectedCategory) return;

    const isHepoxy = selectedCategory.id === 'hepoxy';
    const newName = isHepoxy ? editWeightInput.trim() : editNameInput.trim();
    if (!newName) {
      showToast('error', 'Validation Error', 'Name/identifier cannot be empty.');
      return;
    }

    const newWeight = isHepoxy
      ? parseFloat(editWeightInput)
      : editWeightInput.trim() !== '' ? parseFloat(editWeightInput) : null;

    const newPrice = editPriceInput.trim() !== '' ? parseFloat(editPriceInput) : null;
    if (newPrice !== null && (isNaN(newPrice) || newPrice < 0)) {
      showToast('error', 'Validation Error', 'Cost price must be positive.');
      return;
    }

    const priceChanged = editingMaterial.cost_price !== newPrice && newPrice !== null;

    if (priceChanged) {
      // Prompt confirmation dialog for price propagation
      setPendingPriceChange({
        material: editingMaterial,
        newName,
        newWeight: newWeight !== null && !isNaN(newWeight) ? roundTo2(newWeight) : null,
        newPrice: roundTo2(newPrice),
      });
      setShowPriceConfirmModal(true);
      return;
    }

    // Direct update without price change
    try {
      await updateCostingMaterial(editingMaterial.id, {
        name: newName,
        weight: newWeight !== null && !isNaN(newWeight) ? roundTo2(newWeight) : null,
        cost_price: newPrice !== null ? roundTo2(newPrice) : null,
      });
      showToast('success', 'Material Updated', `Updated ${newName}`);
      setEditingMaterial(null);
      await fetchMaterials();
      await fetchCategories();
      onMaterialsChanged?.();
    } catch (err: any) {
      showToast('error', 'Failed to update material', err.message);
    }
  };

  const handleConfirmPricePropagation = async () => {
    if (!pendingPriceChange) return;
    try {
      // Update name/weight first if changed
      await updateCostingMaterial(pendingPriceChange.material.id, {
        name: pendingPriceChange.newName,
        weight: pendingPriceChange.newWeight,
      });

      // Propagate price atomically
      const res = await propagateMaterialCostPrice(
        pendingPriceChange.material.id,
        pendingPriceChange.newPrice
      );

      showToast(
        'success',
        'Price Propagated',
        `New price ₹${pendingPriceChange.newPrice.toFixed(2)} applied across ${res.affectedJewelryCount} jewelry design(s).`
      );

      setShowPriceConfirmModal(false);
      setPendingPriceChange(null);
      setEditingMaterial(null);
      await fetchMaterials();
      await fetchCategories();
      onMaterialsChanged?.();
    } catch (err: any) {
      showToast('error', 'Failed to propagate price', err.message);
    }
  };

  const handleDeleteMaterial = async (mat: CostingMaterial) => {
    if (mat.is_inventory_stone) {
      showToast('info', 'Inventory Stone', 'Kundan Stones are managed through the Kundan Stone inventory screen.');
      return;
    }

    const check = await canDeleteCostingMaterial(mat.id);
    if (!check.canDelete) {
      showToast('error', 'Cannot Delete Material', check.reason || 'This material is referenced in jewelry designs.');
      return;
    }

    if (!confirm(`Delete raw material "${mat.name}"?`)) return;

    try {
      await deleteCostingMaterial(mat.id);
      showToast('success', 'Material Deleted', `${mat.name} has been removed.`);
      await fetchMaterials();
      await fetchCategories();
      onMaterialsChanged?.();
    } catch (err: any) {
      showToast('error', 'Failed to delete material', err.message);
    }
  };

  const isHepoxy = selectedCategory?.id === 'hepoxy';
  const isKundanStone = selectedCategory?.id === 'kundan_stone';

  return (
    <div className="view-container">
      {/* Top Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          {onBack && (
            <button
              onClick={onBack}
              className="action-btn"
              style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 12px' }}
            >
              <ArrowLeft size={16} /> Back to Costing
            </button>
          )}
          <div>
            <h2 style={{ fontSize: 22, fontWeight: 700, margin: 0 }}>Material & Category Management</h2>
            <p style={{ fontSize: 13, color: 'var(--text-secondary)', margin: '4px 0 0 0' }}>
              Manage raw materials, weights, and unit cost prices used for jewelry manufacturing costing.
            </p>
          </div>
        </div>

        <button
          onClick={() => {
            setCategoryNameInput('');
            setIsAddCategoryOpen(true);
          }}
          className="btn btn-primary"
          style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 16px' }}
        >
          <FolderPlus size={16} /> Add Category
        </button>
      </div>

      {/* Main Grid: Left Category Sidebar / Right Material Details */}
      <div style={{ display: 'grid', gridTemplateColumns: '320px 1fr', gap: 20, alignItems: 'start' }}>
        {/* Categories Panel */}
        <div className="card" style={{ padding: 16, border: '1px solid var(--border-medium)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--teal-deep)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
              Categories
            </span>
            <span style={{ fontSize: 12, color: 'var(--text-secondary)', fontWeight: 600 }}>{categories.length} total</span>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {categories.map((cat) => {
              const isSelected = selectedCategory?.id === cat.id;
              return (
                <div
                  key={cat.id}
                  onClick={() => {
                    setSelectedCategory(cat);
                    setSearchQuery('');
                  }}
                  style={{
                    padding: '12px 14px',
                    borderRadius: 'var(--radius-md)',
                    cursor: 'pointer',
                    background: isSelected ? 'var(--teal-faint)' : 'var(--bg-surface-1)',
                    border: isSelected ? '1.5px solid var(--teal-deep)' : '1px solid var(--border-subtle)',
                    boxShadow: isSelected ? 'var(--shadow-sm)' : 'none',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 6,
                    transition: 'all var(--transition-fast)',
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div style={{ fontWeight: 700, fontSize: 14, color: isSelected ? 'var(--teal-deep)' : 'var(--text-primary)' }}>
                      {cat.name}
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      {!cat.is_system && (
                        <>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setEditingCategory(cat);
                              setCategoryNameInput(cat.name);
                            }}
                            className="btn-icon"
                            style={{ padding: 4 }}
                            title="Rename category"
                          >
                            <Edit2 size={13} />
                          </button>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              handleDeleteCategory(cat);
                            }}
                            className="btn-icon danger"
                            style={{ padding: 4 }}
                            title="Delete category"
                          >
                            <Trash2 size={13} />
                          </button>
                        </>
                      )}
                      <ChevronRight size={15} color={isSelected ? 'var(--teal-deep)' : 'var(--text-secondary)'} />
                    </div>
                  </div>

                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: 'var(--text-secondary)' }}>
                    <span>{cat.material_count || 0} materials</span>
                    <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>Total: {formatRupees(cat.aggregate_cost)}</span>
                  </div>

                  {(cat.missing_price_count || 0) > 0 && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: '#D97706', fontWeight: 600 }}>
                      <AlertTriangle size={13} />
                      <span>{cat.missing_price_count} missing prices</span>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* Selected Category Materials Panel */}
        <div className="card" style={{ padding: 20, border: '1px solid var(--border-medium)', background: 'var(--bg-surface-1)' }}>
          {selectedCategory ? (
            <>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12, marginBottom: 16 }}>
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <h3 style={{ fontSize: 18, fontWeight: 700, margin: 0, color: 'var(--teal-deep)' }}>{selectedCategory.name}</h3>
                    {selectedCategory.is_system ? (
                      <span style={{ fontSize: 11, background: 'var(--bg-surface-2)', border: '1px solid var(--border-medium)', color: 'var(--text-secondary)', padding: '2px 8px', borderRadius: 12, fontWeight: 600 }}>
                        System Category
                      </span>
                    ) : null}
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 4 }}>
                    {materials.length} material(s) · Total cost: <strong style={{ color: 'var(--teal-deep)' }}>{formatRupees(selectedCategory.aggregate_cost)}</strong>
                  </div>
                </div>

                <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                  <div style={{ position: 'relative', width: 220 }}>
                    <Search size={14} style={{ position: 'absolute', left: 10, top: 10, color: 'var(--text-muted)' }} />
                    <input
                      type="text"
                      placeholder={`Search ${selectedCategory.name}...`}
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      className="input"
                      style={{ paddingLeft: 32, height: 36, fontSize: 13 }}
                    />
                  </div>

                  {!isKundanStone && (
                    <button
                      onClick={() => {
                        setMaterialNameInput('');
                        setMaterialWeightInput('');
                        setMaterialPriceInput('');
                        setIsAddMaterialOpen(true);
                      }}
                      className="btn btn-primary"
                      style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '7px 14px', fontSize: 13 }}
                    >
                      <Plus size={15} /> Add Material
                    </button>
                  )}
                </div>
              </div>

              {/* Informational banner for special categories */}
              {isKundanStone && (
                <div
                  style={{
                    padding: 12,
                    borderRadius: 'var(--radius-md)',
                    background: 'var(--teal-faint)',
                    border: '1px solid var(--teal-border)',
                    fontSize: 13,
                    marginBottom: 16,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    color: 'var(--teal-deep)',
                  }}
                >
                  <Sparkles size={16} color="var(--teal-deep)" />
                  <span>
                    Kundan Stone materials are synchronized with your inventory <strong>Stones</strong> master list.
                    Updating prices here propagates to jewelry designs and updates the inventory stone rate.
                  </span>
                </div>
              )}

              {isHepoxy && (
                <div
                  style={{
                    padding: 12,
                    borderRadius: 'var(--radius-md)',
                    background: 'var(--teal-faint)',
                    border: '1px solid var(--teal-border)',
                    fontSize: 13,
                    marginBottom: 16,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    color: 'var(--teal-deep)',
                  }}
                >
                  <Layers size={16} color="var(--teal-deep)" />
                  <span>
                    For Hepoxy, the material's weight is its identifying value (e.g. 0.45). Weight is stored and displayed to two decimal places.
                  </span>
                </div>
              )}

              {/* Materials Table */}
              <div style={{ overflowX: 'auto', border: '1px solid var(--border-medium)', borderRadius: 'var(--radius-md)' }}>
                <table className="data-table" style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr style={{ textAlign: 'left', background: 'var(--bg-surface-2)', borderBottom: '2px solid var(--border-medium)' }}>
                      <th style={{ padding: '10px 14px', fontSize: 12, fontWeight: 700, color: 'var(--teal-deep)' }}>
                        {isHepoxy ? 'HEPOXY WEIGHT' : 'MATERIAL NAME / ID'}
                      </th>
                      {isHepoxy && (
                        <th style={{ padding: '10px 14px', fontSize: 12, fontWeight: 700, color: 'var(--teal-deep)' }}>WEIGHT (GMS)</th>
                      )}
                      <th style={{ padding: '10px 14px', fontSize: 12, fontWeight: 700, color: 'var(--teal-deep)' }}>COST PRICE (₹)</th>
                      <th style={{ padding: '10px 14px', fontSize: 12, fontWeight: 700, color: 'var(--teal-deep)', textAlign: 'right' }}>ACTIONS</th>
                    </tr>
                  </thead>
                  <tbody>
                    {materials.length === 0 ? (
                      <tr>
                        <td colSpan={4} style={{ padding: 32, textAlign: 'center', color: 'var(--text-secondary)' }}>
                          No materials found in {selectedCategory.name}. Click "Add Material" to create one.
                        </td>
                      </tr>
                    ) : (
                      materials.map((mat) => {
                        const hasMissingPrice = mat.cost_price === null || mat.cost_price === undefined;
                        return (
                          <tr
                            key={mat.id}
                            style={{ borderBottom: '1px solid var(--border-subtle)', background: 'var(--bg-surface-1)' }}
                          >
                            <td style={{ padding: '12px 14px', fontWeight: 600, fontSize: 14, color: 'var(--text-primary)' }}>
                              {isHepoxy ? (mat.weight !== null ? mat.weight.toFixed(2) : mat.name) : mat.name}
                            </td>
                            {isHepoxy && (
                              <td style={{ padding: '12px 14px', fontSize: 13, color: 'var(--text-primary)' }}>
                                {mat.weight !== null ? mat.weight.toFixed(2) : '—'}
                              </td>
                            )}
                            <td style={{ padding: '12px 14px' }}>
                              {hasMissingPrice ? (
                                <span
                                  style={{
                                    display: 'inline-flex',
                                    alignItems: 'center',
                                    gap: 4,
                                    fontSize: 12,
                                    padding: '3px 8px',
                                    borderRadius: 6,
                                    background: 'rgba(217,119,6,0.12)',
                                    color: '#D97706',
                                    border: '1px solid rgba(217,119,6,0.25)',
                                    fontWeight: 600,
                                  }}
                                >
                                  <AlertCircle size={12} /> Price Missing
                                </span>
                              ) : (
                                <span style={{ fontWeight: 700, color: 'var(--teal-deep)' }} className="mono">
                                  {formatRupees(mat.cost_price)}
                                </span>
                              )}
                            </td>
                            <td style={{ padding: '12px 14px', textAlign: 'right' }}>
                              <div style={{ display: 'inline-flex', gap: 6 }}>
                                <button
                                  onClick={() => openEditMaterialModal(mat)}
                                  className="btn-icon"
                                  title="Edit material or cost price"
                                  style={{ padding: 6 }}
                                >
                                  <Edit2 size={14} />
                                </button>
                                {!mat.is_inventory_stone && (
                                  <button
                                    onClick={() => handleDeleteMaterial(mat)}
                                    className="btn-icon danger"
                                    title="Delete material"
                                    style={{ padding: 6 }}
                                  >
                                    <Trash2 size={14} />
                                  </button>
                                )}
                              </div>
                            </td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>
            </>
          ) : (
            <div style={{ padding: 48, textAlign: 'center', color: 'var(--text-secondary)' }}>
              Select a category on the left to view and manage its raw materials.
            </div>
          )}
        </div>
      </div>

      {/* Modal: Add Category */}
      {isAddCategoryOpen && (
        <div className="modal-backdrop">
          <div className="modal-content" style={{ maxWidth: 440 }}>
            <div className="modal-header">
              <h3 style={{ fontSize: 17, fontWeight: 700, margin: 0, color: 'var(--teal-deep)' }}>Add New Category</h3>
              <button type="button" onClick={() => setIsAddCategoryOpen(false)} className="btn-icon" title="Close">
                <X size={18} />
              </button>
            </div>
            <form onSubmit={handleCreateCategory}>
              <div className="modal-body">
                <div className="form-group">
                  <label className="form-label" style={{ color: 'var(--text-primary)', fontWeight: 600 }}>
                    Category Name <span className="required">*</span>
                  </label>
                  <input
                    type="text"
                    placeholder="e.g. Enamel, Glass Beads"
                    value={categoryNameInput}
                    onChange={(e) => setCategoryNameInput(e.target.value)}
                    className="input"
                    style={{ height: 38 }}
                    required
                    autoFocus
                  />
                </div>
              </div>
              <div className="modal-footer">
                <button type="button" onClick={() => setIsAddCategoryOpen(false)} className="btn btn-secondary">
                  Cancel
                </button>
                <button type="submit" className="btn btn-primary">
                  Create Category
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Modal: Rename Category */}
      {editingCategory && (
        <div className="modal-backdrop">
          <div className="modal-content" style={{ maxWidth: 440 }}>
            <div className="modal-header">
              <h3 style={{ fontSize: 17, fontWeight: 700, margin: 0, color: 'var(--teal-deep)' }}>Rename Category</h3>
              <button type="button" onClick={() => setEditingCategory(null)} className="btn-icon" title="Close">
                <X size={18} />
              </button>
            </div>
            <form onSubmit={handleUpdateCategory}>
              <div className="modal-body">
                <div className="form-group">
                  <label className="form-label" style={{ color: 'var(--text-primary)', fontWeight: 600 }}>
                    New Category Name <span className="required">*</span>
                  </label>
                  <input
                    type="text"
                    value={categoryNameInput}
                    onChange={(e) => setCategoryNameInput(e.target.value)}
                    className="input"
                    style={{ height: 38 }}
                    required
                    autoFocus
                  />
                </div>
              </div>
              <div className="modal-footer">
                <button type="button" onClick={() => setEditingCategory(null)} className="btn btn-secondary">
                  Cancel
                </button>
                <button type="submit" className="btn btn-primary">
                  Save Changes
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Modal: Add Material */}
      {isAddMaterialOpen && selectedCategory && (
        <div className="modal-backdrop">
          <div className="modal-content" style={{ maxWidth: 480 }}>
            <div className="modal-header">
              <h3 style={{ fontSize: 17, fontWeight: 700, margin: 0, color: 'var(--teal-deep)' }}>
                Add Material to {selectedCategory.name}
              </h3>
              <button type="button" onClick={() => setIsAddMaterialOpen(false)} className="btn-icon" title="Close">
                <X size={18} />
              </button>
            </div>
            <form onSubmit={handleAddMaterial}>
              <div className="modal-body">
                {isHepoxy ? (
                  <div className="form-group" style={{ marginBottom: 14 }}>
                    <label className="form-label" style={{ color: 'var(--text-primary)', fontWeight: 600 }}>
                      Hepoxy Weight (identifier) <span className="required">*</span>
                    </label>
                    <input
                      type="number"
                      step="0.01"
                      placeholder="e.g. 0.45"
                      value={materialWeightInput}
                      onChange={(e) => setMaterialWeightInput(e.target.value)}
                      className="input mono"
                      style={{ height: 38 }}
                      required
                      autoFocus
                    />
                    <span style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 4 }}>
                      Weight serves as the identifier for Hepoxy. Stored to 2 decimal places.
                    </span>
                  </div>
                ) : (
                  <div className="form-group" style={{ marginBottom: 14 }}>
                    <label className="form-label" style={{ color: 'var(--text-primary)', fontWeight: 600 }}>
                      Material Name / ID <span className="required">*</span>
                    </label>
                    <input
                      type="text"
                      placeholder="e.g. AD Stone 3mm, MOP Oval 10x8"
                      value={materialNameInput}
                      onChange={(e) => setMaterialNameInput(e.target.value)}
                      className="input"
                      style={{ height: 38 }}
                      required
                      autoFocus
                    />
                  </div>
                )}

                <div className="form-group" style={{ marginBottom: 8 }}>
                  <label className="form-label" style={{ color: 'var(--text-primary)', fontWeight: 600 }}>
                    Cost Price per Unit (₹) <span style={{ color: 'var(--text-secondary)', fontWeight: 400 }}>(Optional initially)</span>
                  </label>
                  <input
                    type="number"
                    step="0.01"
                    placeholder="e.g. 2.50"
                    value={materialPriceInput}
                    onChange={(e) => setMaterialPriceInput(e.target.value)}
                    className="input mono"
                    style={{ height: 38 }}
                  />
                  <span style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 4 }}>
                    You may leave this blank and enter prices later. Note: Jewelry cannot be costed until price is set.
                  </span>
                </div>
              </div>

              <div className="modal-footer">
                <button type="button" onClick={() => setIsAddMaterialOpen(false)} className="btn btn-secondary">
                  Cancel
                </button>
                <button type="submit" className="btn btn-primary">
                  Save Material
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Modal: Edit Material */}
      {editingMaterial && selectedCategory && (
        <div className="modal-backdrop">
          <div className="modal-content" style={{ maxWidth: 480 }}>
            <div className="modal-header">
              <h3 style={{ fontSize: 17, fontWeight: 700, margin: 0, color: 'var(--teal-deep)' }}>
                Edit {editingMaterial.name}
              </h3>
              <button type="button" onClick={() => setEditingMaterial(null)} className="btn-icon" title="Close">
                <X size={18} />
              </button>
            </div>
            <form onSubmit={handleSaveMaterialEdit}>
              <div className="modal-body">
                {!editingMaterial.is_inventory_stone && !isHepoxy && (
                  <div className="form-group" style={{ marginBottom: 14 }}>
                    <label className="form-label" style={{ color: 'var(--text-primary)', fontWeight: 600 }}>
                      Material Name / ID <span className="required">*</span>
                    </label>
                    <input
                      type="text"
                      value={editNameInput}
                      onChange={(e) => setEditNameInput(e.target.value)}
                      className="input"
                      style={{ height: 38 }}
                      required
                    />
                  </div>
                )}

                {isHepoxy && (
                  <div className="form-group" style={{ marginBottom: 14 }}>
                    <label className="form-label" style={{ color: 'var(--text-primary)', fontWeight: 600 }}>
                      Hepoxy Weight <span className="required">*</span>
                    </label>
                    <input
                      type="number"
                      step="0.01"
                      value={editWeightInput}
                      onChange={(e) => setEditWeightInput(e.target.value)}
                      className="input mono"
                      style={{ height: 38 }}
                      required
                    />
                  </div>
                )}

                <div className="form-group" style={{ marginBottom: 8 }}>
                  <label className="form-label" style={{ color: 'var(--text-primary)', fontWeight: 600 }}>
                    Cost Price per Unit (₹)
                  </label>
                  <input
                    type="number"
                    step="0.01"
                    placeholder="0.00"
                    value={editPriceInput}
                    onChange={(e) => setEditPriceInput(e.target.value)}
                    className="input mono"
                    style={{ height: 38 }}
                    autoFocus
                  />
                </div>
              </div>

              <div className="modal-footer">
                <button type="button" onClick={() => setEditingMaterial(null)} className="btn btn-secondary">
                  Cancel
                </button>
                <button type="submit" className="btn btn-primary">
                  Save Changes
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Confirmation Dialog: Global Price Propagation (Section 5) */}
      {showPriceConfirmModal && pendingPriceChange && (
        <div className="modal-backdrop" style={{ zIndex: 1100 }}>
          <div className="modal-content" style={{ maxWidth: 500, border: '2px solid var(--teal-deep)' }}>
            <div className="modal-header">
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <div
                  style={{
                    width: 38,
                    height: 38,
                    borderRadius: '50%',
                    background: 'var(--teal-faint)',
                    border: '1px solid var(--teal-border)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    color: 'var(--teal-deep)',
                  }}
                >
                  <IndianRupee size={20} />
                </div>
                <div>
                  <h3 style={{ fontSize: 17, fontWeight: 700, margin: 0, color: 'var(--teal-deep)' }}>Confirm Price Update</h3>
                  <p style={{ fontSize: 12, color: 'var(--text-secondary)', margin: 0 }}>
                    Material: <strong style={{ color: 'var(--text-primary)' }}>{pendingPriceChange.material.name}</strong>
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => {
                  setShowPriceConfirmModal(false);
                  setPendingPriceChange(null);
                }}
                className="btn-icon"
                title="Close"
              >
                <X size={18} />
              </button>
            </div>

            <div className="modal-body">
              <p style={{ fontSize: 14, lineHeight: 1.5, color: 'var(--text-primary)', marginBottom: 16 }}>
                Do you want to apply this new cost price (<strong style={{ color: 'var(--teal-deep)' }}>{formatRupees(pendingPriceChange.newPrice)}</strong>) to every jewelry design using this material?
              </p>

              <div
                style={{
                  background: 'var(--bg-surface-2)',
                  border: '1px solid var(--border-medium)',
                  padding: 12,
                  borderRadius: 'var(--radius-md)',
                  fontSize: 12,
                  color: 'var(--text-secondary)',
                  lineHeight: 1.4,
                }}
              >
                All affected jewelry designs will immediately be recalculated with the new price in your private local database.
              </div>
            </div>

            <div className="modal-footer">
              <button
                type="button"
                onClick={() => {
                  setShowPriceConfirmModal(false);
                  setPendingPriceChange(null);
                }}
                className="btn btn-secondary"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleConfirmPricePropagation}
                className="btn btn-primary"
              >
                Apply New Price Everywhere
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
