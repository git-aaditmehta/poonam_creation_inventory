import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  Search,
  Plus,
  Edit3,
  Trash2,
  ChevronDown,
  ChevronUp,
  Download,
  Upload,
  AlertTriangle,
  Layers,
  X,
  AlertCircle,
} from 'lucide-react';
import {
  getCostingMultiplierX,
  recalculateAllJewelryWithX,
  getCostingCategories,
  getCostingMaterialsByCategory,
  getAllJewelryCostings,
  saveJewelryCosting,
  deleteJewelryCosting,
  getAvailablePlatedJewelry,
  type CostingCategory,
  type CostingMaterial,
  type CostingJewelryRecord,
} from '../lib/costingDb';
import {
  calculateJewelryCost,
  calculateTableSummary,
  resolveCategoryId,
  formatRupees,
  roundTo2,
  normalizeQuantity,
  type CostingMaterialEntry,
} from '../lib/costingEngine';
import { CostingMaterialsView } from './CostingMaterialsView';
import { CostingExcelRestoreModal } from './CostingExcelRestoreModal';
import {
  exportJewelryCostingWorkbook,
  exportRawMaterialsWorkbook,
} from '../lib/costingExcel';
import { useToast } from '../context/ToastContext';

interface CostingViewProps {
  onExportJewelryExcel?: () => void;
  onExportMaterialsExcel?: () => void;
}

export const CostingView: React.FC<CostingViewProps> = ({
  onExportJewelryExcel,
  onExportMaterialsExcel,
}) => {
  const { showToast } = useToast();

  // Navigation Sub-tab
  const [subTab, setSubTab] = useState<'costing' | 'materials'>('costing');

  // Excel Restoration Modal
  const [isRestoreModalOpen, setIsRestoreModalOpen] = useState(false);

  // Multiplier X
  const [multiplierX, setMultiplierX] = useState<number>(18.0);
  const [isEditingX, setIsEditingX] = useState(false);
  const [inputX, setInputX] = useState('18.00');

  // View Mode: 'minimized' vs 'expanded'
  const [viewMode, setViewMode] = useState<'minimized' | 'expanded'>('expanded');

  // Expanded individual row IDs in minimized view
  const [expandedRowIds, setExpandedRowIds] = useState<Set<string>>(new Set());

  // Data
  const [costings, setCostings] = useState<CostingJewelryRecord[]>([]);
  const [categories, setCategories] = useState<CostingCategory[]>([]);
  const [searchQuery, setSearchQuery] = useState('');

  // Modals & Editors
  const [isAddJewelryModalOpen, setIsAddJewelryModalOpen] = useState(false);
  const [availableJewelry, setAvailableJewelry] = useState<Array<{ id: string; item_id: string; image_key?: string; thumb_key?: string; is_costed: boolean }>>([]);
  const [jewelrySearch, setJewelrySearch] = useState('');
  const [selectedPlatedItem, setSelectedPlatedItem] = useState<{ id: string; item_id: string } | null>(null);
  const [newJewelryWeight, setNewJewelryWeight] = useState('');
  const [newJewelryMaterials, setNewJewelryMaterials] = useState<CostingMaterialEntry[]>([]);

  // Category Cell Popover Editor
  const [editingCell, setEditingCell] = useState<{
    costingId: string;
    platedItemId: string;
    categoryId: string;
    categoryName: string;
  } | null>(null);
  const [cellMaterials, setCellMaterials] = useState<CostingMaterialEntry[]>([]);
  const [availableCategoryMaterials, setAvailableCategoryMaterials] = useState<CostingMaterial[]>([]);
  const [selectedAddMaterialId, setSelectedAddMaterialId] = useState('');
  const [materialQtyInput, setMaterialQtyInput] = useState('');
  const [inlinePriceInput, setInlinePriceInput] = useState('');

  // Inline Weight Editing
  const [editingWeightId, setEditingWeightId] = useState<string | null>(null);
  const [inlineWeightVal, setInlineWeightVal] = useState<string>('');

  // ── Load Master Data ──────────────────────────────────────────

  const loadData = useCallback(async () => {
    try {
      const [xVal, cats, records] = await Promise.all([
        getCostingMultiplierX(),
        getCostingCategories(),
        getAllJewelryCostings(searchQuery),
      ]);
      setMultiplierX(xVal);
      setInputX(xVal.toFixed(2));
      setCategories(cats);
      setCostings(records);
    } catch (err: any) {
      showToast('error', 'Failed to load costing data', err.message);
    }
  }, [searchQuery, showToast]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // ── Multiplier X Handler ───────────────────────────────────────

  const handleSaveX = async () => {
    const val = parseFloat(inputX);
    if (isNaN(val) || val < 0) {
      showToast('error', 'Invalid Multiplier', 'Multiplier X must be a positive number');
      return;
    }

    try {
      const rounded = roundTo2(val);
      await recalculateAllJewelryWithX(rounded);
      setMultiplierX(rounded);
      setIsEditingX(false);
      showToast('success', 'Multiplier X Updated', `Recalculated all jewelry designs with X = ₹${rounded.toFixed(2)}`);
      await loadData();
    } catch (err: any) {
      showToast('error', 'Failed to update X', err.message);
    }
  };

  // ── Add Jewelry Costing Flow ───────────────────────────────────

  const openAddJewelryModal = async () => {
    try {
      const items = await getAvailablePlatedJewelry();
      setAvailableJewelry(items);
      setSelectedPlatedItem(null);
      setNewJewelryWeight('');
      setNewJewelryMaterials([]);
      setIsAddJewelryModalOpen(true);
    } catch (err: any) {
      showToast('error', 'Error loading jewelry list', err.message);
    }
  };

  const handleSearchAvailableJewelry = async (q: string) => {
    setJewelrySearch(q);
    try {
      const items = await getAvailablePlatedJewelry(q);
      setAvailableJewelry(items);
    } catch { /* ignore */ }
  };

  const handleSaveNewJewelryCosting = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedPlatedItem) {
      showToast('error', 'Validation Error', 'Please select a plated jewelry item');
      return;
    }

    const weight = parseFloat(newJewelryWeight);
    if (isNaN(weight) || weight <= 0) {
      showToast('error', 'Validation Error', 'Jewelry weight must be greater than zero');
      return;
    }

    try {
      const saved = await saveJewelryCosting({
        plated_jewelry_id: selectedPlatedItem.id,
        weight: roundTo2(weight),
        materials: newJewelryMaterials,
      });

      showToast(
        saved.is_complete ? 'success' : 'info',
        saved.is_complete ? 'Jewelry Costed' : 'Saved as Draft',
        saved.is_complete
          ? `Cost calculated: ${formatRupees(saved.cached_total_cost)}`
          : 'Saved, but some material prices are missing.'
      );

      setIsAddJewelryModalOpen(false);
      await loadData();
    } catch (err: any) {
      showToast('error', 'Failed to save costing', err.message);
    }
  };

  // ── Inline Weight Edit ─────────────────────────────────────────

  const handleSaveInlineWeight = async (costing: CostingJewelryRecord) => {
    const w = parseFloat(inlineWeightVal);
    if (isNaN(w) || w <= 0) {
      showToast('error', 'Validation Error', 'Weight must be greater than zero');
      return;
    }

    try {
      await saveJewelryCosting({
        id: costing.id,
        plated_jewelry_id: costing.plated_jewelry_id,
        weight: roundTo2(w),
        materials: costing.materials,
      });
      setEditingWeightId(null);
      await loadData();
      showToast('success', 'Weight Updated', `Recalculated ${costing.item_id}`);
    } catch (err: any) {
      showToast('error', 'Failed to update weight', err.message);
    }
  };

  // ── Category Cell Editor Popover ───────────────────────────────

  const openCategoryCellEditor = async (
    costing: CostingJewelryRecord,
    category: CostingCategory
  ) => {
    setEditingCell({
      costingId: costing.id,
      platedItemId: costing.item_id,
      categoryId: category.id,
      categoryName: category.name,
    });

    // Extract materials already assigned to this category for this jewelry item
    const categoryIds = categories.map((c) => c.id);
    const existing = costing.materials.filter((m) => (resolveCategoryId(m.categoryId, categoryIds) || m.categoryId) === category.id);
    setCellMaterials([...existing]);

    // Load available materials in this category
    try {
      const avail = await getCostingMaterialsByCategory(category.id);
      setAvailableCategoryMaterials(avail);
    } catch (err: any) {
      showToast('error', 'Error loading category materials', err.message);
    }

    setSelectedAddMaterialId('');
    setMaterialQtyInput('');
    setInlinePriceInput('');
  };

  const handleAddMaterialToCell = () => {
    if (!editingCell || !selectedAddMaterialId) return;

    const mat = availableCategoryMaterials.find((m) => m.id === selectedAddMaterialId);
    if (!mat) return;

    // Check quantity rule: empty defaults to 1, otherwise whole number > 0
    const qtyNorm = normalizeQuantity(materialQtyInput);
    if (!qtyNorm.valid) {
      showToast('error', 'Quantity Error', qtyNorm.error || 'Invalid quantity');
      return;
    }

    let unitCost = mat.cost_price;
    if (unitCost === null && inlinePriceInput.trim() !== '') {
      const p = parseFloat(inlinePriceInput);
      if (!isNaN(p) && p >= 0) {
        unitCost = roundTo2(p);
      }
    }

    const newEntry: CostingMaterialEntry = {
      categoryId: editingCell.categoryId,
      materialId: mat.id,
      materialName: mat.name,
      quantity: qtyNorm.quantity,
      unitCost,
      weight: mat.weight,
    };

    setCellMaterials((prev) => [...prev, newEntry]);
    setSelectedAddMaterialId('');
    setMaterialQtyInput('');
    setInlinePriceInput('');
  };

  const handleRemoveMaterialFromCell = (index: number) => {
    setCellMaterials((prev) => prev.filter((_, i) => i !== index));
  };

  const handleUpdateCellMaterialQty = (index: number, val: string) => {
    setCellMaterials((prev) =>
      prev.map((item, i) => {
        if (i !== index) return item;
        return { ...item, quantity: val };
      })
    );
  };

  const handleUpdateCellMaterialPrice = (index: number, val: string) => {
    setCellMaterials((prev) =>
      prev.map((item, i) => {
        if (i !== index) return item;
        const p = parseFloat(val);
        return { ...item, unitCost: !isNaN(p) && p >= 0 ? roundTo2(p) : null };
      })
    );
  };

  const handleSaveCellEdits = async () => {
    if (!editingCell) return;

    const costing = costings.find((c) => c.id === editingCell.costingId);
    if (!costing) return;

    // Replace materials of this category with updated cellMaterials
    const categoryIds = categories.map((c) => c.id);
    const otherMaterials = costing.materials.filter((m) => (resolveCategoryId(m.categoryId, categoryIds) || m.categoryId) !== editingCell.categoryId);
    const updatedAllMaterials = [...otherMaterials, ...cellMaterials];

    // Check for missing prices
    const calc = calculateJewelryCost(costing.weight, multiplierX, updatedAllMaterials);
    if (!calc.isComplete && calc.missingPriceMaterials.length > 0) {
      // Prompt user clearly
      showToast(
        'info',
        'Incomplete Costing',
        `Saved, but missing prices for: ${calc.missingPriceMaterials.join(', ')}`
      );
    }

    try {
      await saveJewelryCosting({
        id: costing.id,
        plated_jewelry_id: costing.plated_jewelry_id,
        weight: costing.weight,
        materials: updatedAllMaterials,
      });

      setEditingCell(null);
      await loadData();
      showToast('success', 'Cell Updated', `Updated ${editingCell.categoryName} on ${costing.item_id}`);
    } catch (err: any) {
      showToast('error', 'Failed to save cell', err.message);
    }
  };

  // ── Delete Costing Handler ─────────────────────────────────────

  const handleDeleteCosting = async (costing: CostingJewelryRecord) => {
    if (!confirm(`Remove costing record for ${costing.item_id}? (This will not delete the inventory item).`)) return;

    try {
      await deleteJewelryCosting(costing.id);
      showToast('success', 'Costing Removed', `Costing for ${costing.item_id} deleted.`);
      await loadData();
    } catch (err: any) {
      showToast('error', 'Delete failed', err.message);
    }
  };

  // ── Excel Export Handlers ──────────────────────────────────────

  const handleExportJewelryExcel = () => {
    try {
      exportJewelryCostingWorkbook(costings, categories, multiplierX);
      showToast('success', 'Costing Exported', 'Jewelry Costing Excel backup generated locally.');
    } catch (err: any) {
      showToast('error', 'Export Failed', err.message);
    }
  };

  const handleExportMaterialsExcel = async () => {
    try {
      const materialsByCat: Record<string, CostingMaterial[]> = {};
      for (const cat of categories) {
        materialsByCat[cat.id] = await getCostingMaterialsByCategory(cat.id);
      }
      exportRawMaterialsWorkbook(categories, materialsByCat);
      showToast('success', 'Materials Exported', 'Raw Materials Excel backup generated locally.');
    } catch (err: any) {
      showToast('error', 'Export Failed', err.message);
    }
  };

  // ── Aggregates & Calculations ──────────────────────────────────

  const summary = useMemo(() => {
    const categoryIds = categories.map((c) => c.id);
    const items = costings.map((c) => ({
      weightCost: c.calculated?.weightCost ?? 0,
      materials: (c.calculated?.materials || []).map((m) => ({
        categoryId: resolveCategoryId(m.categoryId, categoryIds) || m.categoryId,
        extendedCost: m.extendedCost,
      })),
      totalCost: c.calculated?.totalCost ?? 0,
      isComplete: c.calculated?.isComplete ?? Boolean(c.is_complete),
    }));
    return calculateTableSummary(items, categoryIds);
  }, [costings, categories]);

  // Render SubTab Switch
  if (subTab === 'materials') {
    return (
      <CostingMaterialsView
        onBack={() => setSubTab('costing')}
        onMaterialsChanged={loadData}
      />
    );
  }

  return (
    <div className="view-container">
      {/* Top Header & Global Actions */}
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 16,
          marginBottom: 20,
        }}
      >
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <h2 style={{ fontSize: 22, fontWeight: 700, margin: 0 }}>Jewelry Costing System</h2>
            <span
              style={{
                fontSize: 11,
                fontWeight: 600,
                background: 'rgba(13,148,136,0.15)',
                color: 'var(--teal-deep)',
                padding: '2px 8px',
                borderRadius: 9999,
                border: '1px solid rgba(13,148,136,0.3)',
              }}
            >
              Private Local-Only
            </span>
          </div>
          <p style={{ fontSize: 13, color: 'var(--text-secondary)', margin: '4px 0 0 0' }}>
            Desktop spreadsheet costing: (Jewelry Weight × X) + Raw Materials. Completely isolated from cloud sync.
          </p>
        </div>

        {/* Global Toolbar */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          {/* Configurable Multiplier X */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              background: 'var(--bg-surface-1)',
              padding: '6px 14px',
              borderRadius: 'var(--radius-md)',
              border: '1px solid var(--border-medium)',
              boxShadow: 'var(--shadow-sm)',
            }}
          >
            <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
              Multiplier X:
            </span>
            {isEditingX ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>₹</span>
                <input
                  type="number"
                  step="0.01"
                  value={inputX}
                  onChange={(e) => setInputX(e.target.value)}
                  style={{ width: 70, height: 28, fontSize: 13, padding: '2px 6px' }}
                  className="input mono"
                  autoFocus
                />
                <button onClick={handleSaveX} className="btn btn-primary" style={{ padding: '4px 10px', fontSize: 12 }}>
                  Save
                </button>
                <button onClick={() => setIsEditingX(false)} className="btn btn-secondary" style={{ padding: '4px 8px', fontSize: 12 }}>
                  <X size={13} />
                </button>
              </div>
            ) : (
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ fontSize: 15, fontWeight: 800, color: 'var(--teal-deep)' }} className="mono">
                  {formatRupees(multiplierX)}
                </span>
                <button
                  onClick={() => {
                    setInputX(multiplierX.toFixed(2));
                    setIsEditingX(true);
                  }}
                  className="btn-icon"
                  style={{ padding: 4 }}
                  title="Change multiplier X"
                >
                  <Edit3 size={14} />
                </button>
              </div>
            )}
          </div>

          {/* View Mode Toggle */}
          <div
            style={{
              display: 'flex',
              background: 'var(--bg-surface-2)',
              borderRadius: 'var(--radius-md)',
              padding: 3,
              border: '1px solid var(--border-medium)',
            }}
          >
            <button
              onClick={() => setViewMode('minimized')}
              style={{
                padding: '6px 14px',
                fontSize: 12,
                fontWeight: 600,
                borderRadius: 'var(--radius-sm)',
                border: 'none',
                background: viewMode === 'minimized' ? 'var(--teal-deep)' : 'transparent',
                color: viewMode === 'minimized' ? '#FFFFFF' : 'var(--text-secondary)',
                cursor: 'pointer',
                transition: 'all var(--transition-fast)',
              }}
            >
              Minimized
            </button>
            <button
              onClick={() => setViewMode('expanded')}
              style={{
                padding: '6px 14px',
                fontSize: 12,
                fontWeight: 600,
                borderRadius: 'var(--radius-sm)',
                border: 'none',
                background: viewMode === 'expanded' ? 'var(--teal-deep)' : 'transparent',
                color: viewMode === 'expanded' ? '#FFFFFF' : 'var(--text-secondary)',
                cursor: 'pointer',
                transition: 'all var(--transition-fast)',
              }}
            >
              Spreadsheet View
            </button>
          </div>

          {/* SubTab Switch to Raw Materials */}
          <button
            onClick={() => setSubTab('materials')}
            className="btn btn-secondary"
            style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '7px 12px', fontSize: 13 }}
          >
            <Layers size={15} /> Raw Materials & Categories
          </button>

          {/* Excel Export & Restore Buttons */}
          <div style={{ display: 'flex', gap: 6 }}>
            <button
              onClick={onExportJewelryExcel || handleExportJewelryExcel}
              className="btn btn-secondary"
              title="Export Jewelry Costing Excel"
              style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '7px 12px', fontSize: 13 }}
            >
              <Download size={14} /> Costing Excel
            </button>
            <button
              onClick={onExportMaterialsExcel || handleExportMaterialsExcel}
              className="btn btn-secondary"
              title="Export Raw Materials Excel"
              style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '7px 12px', fontSize: 13 }}
            >
              <Download size={14} /> Materials Excel
            </button>
            <button
              onClick={() => setIsRestoreModalOpen(true)}
              className="btn btn-secondary"
              title="Restore / Onboard Costing Data from Excel"
              style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '7px 12px', fontSize: 13 }}
            >
              <Upload size={14} /> Restore Excel
            </button>
          </div>

          {/* Add Jewelry Button */}
          <button
            onClick={openAddJewelryModal}
            className="btn btn-primary"
            style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 18px', fontSize: 13 }}
          >
            <Plus size={16} /> Cost Jewelry
          </button>
        </div>
      </div>

      {/* Search Bar & Summary Stats Bar */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: 16,
          marginBottom: 16,
          flexWrap: 'wrap',
        }}
      >
        <div style={{ position: 'relative', width: 300 }}>
          <Search size={15} style={{ position: 'absolute', left: 12, top: 11, color: 'var(--text-muted)' }} />
          <input
            type="text"
            placeholder="Search jewelry design ID..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="input"
            style={{ paddingLeft: 36, height: 38, fontSize: 13 }}
          />
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 18, fontSize: 13, color: 'var(--text-secondary)' }}>
          <div>
            Total Designs: <strong style={{ color: 'var(--text-primary)', fontWeight: 700 }}>{summary.totalJewelryCount}</strong>
          </div>
          <div>
            Total Manufacturing Cost: <strong style={{ color: 'var(--teal-deep)', fontWeight: 800 }}>{formatRupees(summary.grandTotalCost)}</strong>
          </div>
          {summary.incompleteCount > 0 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 5, color: '#D97706', fontWeight: 600 }}>
              <AlertTriangle size={15} />
              <span>{summary.incompleteCount} incomplete (missing prices)</span>
            </div>
          )}
        </div>
      </div>

      {/* ── MODE 1: MINIMIZED VIEW ───────────────────────────────── */}
      {viewMode === 'minimized' && (
        <div className="card" style={{ padding: 0, overflow: 'hidden', border: '1px solid var(--border-medium)' }}>
          <table className="data-table" style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ background: 'var(--bg-surface-2)', borderBottom: '2px solid var(--border-medium)' }}>
                <th style={{ padding: '12px 16px', textAlign: 'left', fontSize: 12, fontWeight: 700, color: 'var(--teal-deep)' }}>Jewelry ID / Design</th>
                <th style={{ padding: '12px 16px', textAlign: 'left', fontSize: 12, fontWeight: 700, color: 'var(--teal-deep)', minWidth: 170 }}>Jewelry Weight</th>
                <th style={{ padding: '12px 16px', textAlign: 'right', fontSize: 12, fontWeight: 700, color: 'var(--teal-deep)' }}>Total Cost (₹)</th>
                <th style={{ padding: '12px 16px', textAlign: 'center', fontSize: 12, fontWeight: 700, color: 'var(--teal-deep)', width: 80 }}>Inspect</th>
              </tr>
            </thead>
            <tbody>
              {costings.length === 0 ? (
                <tr>
                  <td colSpan={4} style={{ padding: 48, textAlign: 'center', color: 'var(--text-secondary)' }}>
                    No jewelry costing records found. Click "+ Cost Jewelry" to add one.
                  </td>
                </tr>
              ) : (
                costings.map((c) => {
                  const isExpanded = expandedRowIds.has(c.id);
                  const calc = c.calculated;

                  return (
                    <React.Fragment key={c.id}>
                      <tr
                        style={{
                          borderBottom: '1px solid var(--border-subtle)',
                          background: isExpanded ? 'var(--teal-faint)' : 'var(--bg-surface-1)',
                        }}
                      >
                        <td style={{ padding: '12px 16px' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                            {c.image_key || c.thumb_key ? (
                              <img
                                src={`/api/images/${c.image_key || c.thumb_key}`}
                                alt={c.item_id}
                                style={{ width: 36, height: 36, borderRadius: 6, objectFit: 'cover', border: '1px solid var(--border-medium)' }}
                              />
                            ) : null}
                            <div>
                              <div style={{ fontWeight: 700, fontSize: 14, color: 'var(--teal-deep)' }}>{c.item_id}</div>
                              {!c.is_complete && (
                                <span style={{ fontSize: 11, color: '#D97706', display: 'flex', alignItems: 'center', gap: 3, fontWeight: 600 }}>
                                  <AlertCircle size={11} /> Missing Prices
                                </span>
                              )}
                            </div>
                          </div>
                        </td>
                        <td style={{ padding: '12px 16px' }}>
                          <div
                            style={{
                              display: 'inline-flex',
                              justifyContent: 'space-between',
                              alignItems: 'center',
                              fontSize: 12,
                              background: 'var(--teal-faint)',
                              border: '1px solid var(--teal-border)',
                              padding: '4px 10px',
                              borderRadius: 4,
                              minWidth: 160,
                            }}
                          >
                            <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>
                              {c.weight.toFixed(2)} gms
                            </span>
                            <span style={{ fontWeight: 700, color: 'var(--teal-deep)', marginLeft: 12 }} className="mono">
                              {formatRupees(calc?.weightCost)}
                            </span>
                          </div>
                        </td>
                        <td style={{ padding: '12px 16px', textAlign: 'right' }}>
                          <span style={{ fontSize: 15, fontWeight: 800, color: 'var(--teal-deep)' }} className="mono">
                            {formatRupees(calc?.totalCost)}
                          </span>
                        </td>
                        <td style={{ padding: '12px 16px', textAlign: 'center' }}>
                          <button
                            onClick={() => {
                              setExpandedRowIds((prev) => {
                                const next = new Set(prev);
                                if (next.has(c.id)) next.delete(c.id);
                                else next.add(c.id);
                                return next;
                              });
                            }}
                            className="btn-icon"
                            title={isExpanded ? 'Collapse row' : 'Expand details'}
                          >
                            {isExpanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                          </button>
                        </td>
                      </tr>

                      {/* Expanded Row Breakdown (Section 6.2) */}
                      {isExpanded && (
                        <tr style={{ background: 'var(--bg-surface-2)', borderBottom: '1px solid var(--border-medium)' }}>
                          <td colSpan={4} style={{ padding: '16px 24px' }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                              <h4 style={{ fontSize: 14, fontWeight: 700, margin: 0, color: 'var(--teal-deep)' }}>
                                Costing Composition: {c.item_id}
                              </h4>
                              <div style={{ display: 'flex', gap: 16, fontSize: 13, color: 'var(--text-primary)' }}>
                                <span>Weight: <strong>{c.weight.toFixed(2)} gms</strong></span>
                                <span>Current X: <strong>{formatRupees(multiplierX)}</strong></span>
                                <span>Weight Cost: <strong>{formatRupees(calc?.weightCost)}</strong></span>
                                <span>Materials Cost: <strong>{formatRupees(calc?.materialsCost)}</strong></span>
                                <span style={{ color: 'var(--teal-deep)', fontWeight: 800 }}>Total: {formatRupees(calc?.totalCost)}</span>
                              </div>
                            </div>

                            {/* Materials Sub-table */}
                            <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse', background: 'var(--bg-surface-1)', borderRadius: 'var(--radius-md)', overflow: 'hidden', border: '1px solid var(--border-subtle)' }}>
                              <thead>
                                <tr style={{ background: 'var(--bg-surface-3)', borderBottom: '1px solid var(--border-medium)', color: 'var(--text-primary)' }}>
                                  <th style={{ textAlign: 'left', padding: '8px 12px', fontWeight: 700 }}>Category</th>
                                  <th style={{ textAlign: 'left', padding: '8px 12px', fontWeight: 700 }}>Material</th>
                                  <th style={{ textAlign: 'right', padding: '8px 12px', fontWeight: 700 }}>Qty / Weight</th>
                                  <th style={{ textAlign: 'right', padding: '8px 12px', fontWeight: 700 }}>Unit Cost (₹)</th>
                                  <th style={{ textAlign: 'right', padding: '8px 12px', fontWeight: 700 }}>Extended Cost (₹)</th>
                                </tr>
                              </thead>
                              <tbody>
                                {calc?.materials.length === 0 ? (
                                  <tr>
                                    <td colSpan={5} style={{ padding: 14, textAlign: 'center', color: 'var(--text-secondary)' }}>
                                      No raw materials added yet.
                                    </td>
                                  </tr>
                                ) : (
                                  calc?.materials.map((m, idx) => (
                                    <tr key={idx} style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                                      <td style={{ padding: '8px 12px', color: 'var(--text-secondary)' }}>
                                        {categories.find((cat) => cat.id === m.categoryId)?.name || m.categoryId}
                                      </td>
                                      <td style={{ padding: '8px 12px', fontWeight: 600, color: 'var(--text-primary)' }}>{m.materialName}</td>
                                      <td style={{ padding: '8px 12px', textAlign: 'right', color: 'var(--text-primary)' }}>
                                        {m.weight != null ? `${m.weight.toFixed(2)} gms` : m.quantity}
                                      </td>
                                      <td style={{ padding: '8px 12px', textAlign: 'right', color: 'var(--text-primary)' }}>
                                        {m.hasMissingPrice ? (
                                          <span style={{ color: '#D97706', fontWeight: 600 }}>Missing</span>
                                        ) : (
                                          formatRupees(m.unitCost)
                                        )}
                                      </td>
                                      <td style={{ padding: '8px 12px', textAlign: 'right', fontWeight: 700, color: 'var(--teal-deep)' }}>
                                        {m.hasMissingPrice ? (
                                          <span style={{ color: '#D97706' }}>—</span>
                                        ) : (
                                          formatRupees(m.extendedCost)
                                        )}
                                      </td>
                                    </tr>
                                  ))
                                )}
                              </tbody>
                            </table>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* ── MODE 2: EXPANDED TABLE VIEW (SPREADSHEET) ─────────────── */}
      {viewMode === 'expanded' && (
        <div
          className="card"
          style={{
            padding: 0,
            overflowX: 'auto',
            border: '1px solid var(--border-medium)',
            borderRadius: 'var(--radius-lg)',
            boxShadow: 'var(--shadow-sm)',
            background: 'var(--bg-surface-1)',
          }}
        >
          <table
            className="data-table"
            style={{
              width: '100%',
              minWidth: 1000,
              borderCollapse: 'collapse',
              position: 'relative',
            }}
          >
            <thead>
              <tr style={{ background: 'var(--bg-surface-2)', borderBottom: '2px solid var(--border-medium)' }}>
                {/* Sticky Jewelry Column */}
                <th
                  className="costing-sticky-left-header"
                  style={{
                    padding: '12px 14px',
                    textAlign: 'left',
                    fontSize: 12,
                    fontWeight: 700,
                    color: 'var(--teal-deep)',
                    width: 190,
                  }}
                >
                  JEWELRY ID / DESIGN
                </th>

                {/* Jewelry Weight */}
                <th
                  style={{
                    padding: '12px 14px',
                    textAlign: 'left',
                    fontSize: 12,
                    fontWeight: 700,
                    color: 'var(--teal-deep)',
                    minWidth: 165,
                    borderLeft: '1px solid var(--border-medium)',
                  }}
                >
                  JEWELRY WEIGHT
                </th>

                {/* Dynamic Category Columns */}
                {categories.map((cat) => (
                  <th
                    key={cat.id}
                    style={{
                      padding: '12px 14px',
                      textAlign: 'left',
                      fontSize: 12,
                      fontWeight: 700,
                      color: 'var(--teal-deep)',
                      minWidth: 150,
                      borderLeft: '1px solid var(--border-medium)',
                    }}
                  >
                    {cat.name.toUpperCase()}
                  </th>
                ))}

                {/* Total Cost Column */}
                <th
                  className="costing-sticky-right-header"
                  style={{
                    padding: '12px 14px',
                    textAlign: 'right',
                    fontSize: 12,
                    fontWeight: 700,
                    color: 'var(--teal-deep)',
                    width: 140,
                  }}
                >
                  TOTAL COST (₹)
                </th>
              </tr>
            </thead>
            <tbody>
              {costings.length === 0 ? (
                <tr>
                  <td colSpan={3 + categories.length} style={{ padding: 48, textAlign: 'center', color: 'var(--text-secondary)' }}>
                    No jewelry costing records found. Click "+ Cost Jewelry" to add one.
                  </td>
                </tr>
              ) : (
                costings.map((c) => {
                  const calc = c.calculated;

                  return (
                    <tr
                      key={c.id}
                      style={{
                        borderBottom: '1px solid var(--border-subtle)',
                        background: 'var(--bg-surface-1)',
                        transition: 'background 0.15s ease',
                      }}
                    >
                      {/* Sticky Jewelry Column */}
                      <td
                        className="costing-sticky-left"
                        style={{
                          padding: '12px 14px',
                        }}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                          <div>
                            <div style={{ fontWeight: 700, fontSize: 14, color: 'var(--teal-deep)' }}>{c.item_id}</div>
                            {!c.is_complete && (
                              <span style={{ fontSize: 11, color: '#D97706', display: 'flex', alignItems: 'center', gap: 3, fontWeight: 600 }}>
                                <AlertCircle size={11} /> Missing Prices
                              </span>
                            )}
                          </div>
                          <button
                            onClick={() => handleDeleteCosting(c)}
                            className="btn-icon danger"
                            title="Delete costing"
                            style={{ padding: 4 }}
                          >
                            <Trash2 size={14} />
                          </button>
                        </div>
                      </td>

                      {/* Jewelry Weight (Unified chip layout matching materials) */}
                      <td
                        style={{
                          padding: '8px 12px',
                          borderLeft: '1px solid var(--border-subtle)',
                          verticalAlign: 'middle',
                        }}
                      >
                        {editingWeightId === c.id ? (
                          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                            <input
                              type="number"
                              step="0.01"
                              value={inlineWeightVal}
                              onChange={(e) => setInlineWeightVal(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') handleSaveInlineWeight(c);
                                if (e.key === 'Escape') setEditingWeightId(null);
                              }}
                              style={{ width: 68, height: 26, fontSize: 12, padding: '2px 4px' }}
                              className="input mono"
                              autoFocus
                            />
                            <button
                              onClick={() => handleSaveInlineWeight(c)}
                              className="btn btn-primary"
                              style={{ padding: '3px 8px', fontSize: 11 }}
                              title="Save weight"
                            >
                              OK
                            </button>
                            <button
                              onClick={() => setEditingWeightId(null)}
                              className="btn btn-secondary"
                              style={{ padding: '3px 6px', fontSize: 11 }}
                              title="Cancel"
                            >
                              ✕
                            </button>
                          </div>
                        ) : (
                          <div
                            onClick={() => {
                              setEditingWeightId(c.id);
                              setInlineWeightVal(c.weight.toFixed(2));
                            }}
                            style={{
                              display: 'flex',
                              justifyContent: 'space-between',
                              alignItems: 'center',
                              fontSize: 12,
                              background: 'var(--teal-faint)',
                              border: '1px solid var(--teal-border)',
                              padding: '3px 8px',
                              borderRadius: 4,
                              cursor: 'pointer',
                              transition: 'all 0.15s ease',
                            }}
                            title="Click to edit weight"
                          >
                            <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>
                              {c.weight.toFixed(2)} gms
                            </span>
                            <span style={{ fontWeight: 700, color: 'var(--teal-deep)', marginLeft: 8 }} className="mono">
                              {formatRupees(calc?.weightCost)}
                            </span>
                          </div>
                        )}
                      </td>

                      {/* Dynamic Material Category Cells */}
                      {categories.map((cat) => {
                        const catIds = categories.map((catItem) => catItem.id);
                        const cellMats = calc?.materials.filter((m) => (resolveCategoryId(m.categoryId, catIds) || m.categoryId) === cat.id) || [];
                        const isEmpty = cellMats.length === 0;

                        return (
                          <td
                            key={cat.id}
                            onClick={() => openCategoryCellEditor(c, cat)}
                            style={{
                              padding: '8px 12px',
                              cursor: 'pointer',
                              borderLeft: '1px solid var(--border-subtle)',
                              verticalAlign: 'top',
                            }}
                            title={`Click to edit ${cat.name} entries`}
                          >
                            {isEmpty ? (
                              <span style={{ color: 'var(--text-muted)', fontSize: 14 }}>—</span>
                            ) : (
                              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                                {cellMats.map((m, idx) => (
                                  <div
                                    key={idx}
                                    style={{
                                      display: 'flex',
                                      justifyContent: 'space-between',
                                      alignItems: 'center',
                                      fontSize: 12,
                                      background: 'var(--teal-faint)',
                                      border: '1px solid var(--teal-border)',
                                      padding: '3px 8px',
                                      borderRadius: 4,
                                    }}
                                  >
                                    <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>
                                      {m.materialName} ({m.quantity})
                                    </span>
                                    <span style={{ fontWeight: 600, color: m.hasMissingPrice ? '#D97706' : 'var(--teal-deep)', marginLeft: 8 }}>
                                      {m.hasMissingPrice ? 'Missing' : formatRupees(m.extendedCost)}
                                    </span>
                                  </div>
                                ))}
                              </div>
                            )}
                          </td>
                        );
                      })}

                      {/* Total Cost Column */}
                      <td
                        className="costing-sticky-right"
                        style={{
                          padding: '12px 14px',
                          textAlign: 'right',
                        }}
                      >
                        <span style={{ fontSize: 15, fontWeight: 800, color: 'var(--teal-deep)' }} className="mono">
                          {formatRupees(calc?.totalCost)}
                        </span>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>

            {/* Bottom Summary Row (Section 7) */}
            <tfoot>
              <tr
                style={{
                  background: 'var(--bg-surface-2)',
                  borderTop: '2px solid var(--border-medium)',
                  fontWeight: 700,
                }}
              >
                <td
                  className="costing-sticky-left-header"
                  style={{
                    padding: '12px 14px',
                    fontSize: 13,
                    fontWeight: 700,
                    color: 'var(--teal-deep)',
                  }}
                >
                  Summary ({summary.totalJewelryCount} Designs)
                </td>
                <td
                  style={{
                    padding: '12px 14px',
                    textAlign: 'right',
                    fontSize: 13,
                    fontWeight: 700,
                    color: 'var(--text-primary)',
                    borderLeft: '1px solid var(--border-medium)',
                  }}
                >
                  {formatRupees(summary.totalWeightCost)}
                </td>

                {categories.map((cat) => (
                  <td
                    key={cat.id}
                    style={{
                      padding: '12px 14px',
                      textAlign: 'right',
                      fontSize: 13,
                      fontWeight: 700,
                      color: 'var(--text-primary)',
                      borderLeft: '1px solid var(--border-medium)',
                    }}
                  >
                    {formatRupees(summary.categoryTotals[cat.id])}
                  </td>
                ))}

                <td
                  className="costing-sticky-right-header"
                  style={{
                    padding: '12px 14px',
                    textAlign: 'right',
                    fontSize: 16,
                    fontWeight: 800,
                    color: 'var(--teal-deep)',
                  }}
                >
                  {formatRupees(summary.grandTotalCost)}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      {/* ── MODAL: ADD JEWELRY TO COSTING (Section 6.1) ─────────── */}
      {isAddJewelryModalOpen && (
        <div className="modal-backdrop">
          <div className="modal-content" style={{ maxWidth: 540 }}>
            <div className="modal-header">
              <h3 style={{ fontSize: 17, fontWeight: 700, margin: 0, color: 'var(--teal-deep)' }}>
                Add Jewelry Design to Costing
              </h3>
              <button
                type="button"
                onClick={() => setIsAddJewelryModalOpen(false)}
                className="btn-icon"
                title="Close"
              >
                <X size={18} />
              </button>
            </div>

            <form onSubmit={handleSaveNewJewelryCosting}>
              <div className="modal-body">
                {/* Select Plated Jewelry Design */}
                <div className="form-group" style={{ marginBottom: 16 }}>
                  <label className="form-label" style={{ color: 'var(--text-primary)', fontWeight: 600 }}>
                    Select Existing Plated Jewelry Design <span className="required">*</span>
                  </label>
                  <div style={{ position: 'relative', marginBottom: 8 }}>
                    <Search size={15} style={{ position: 'absolute', left: 12, top: 11, color: 'var(--text-muted)' }} />
                    <input
                      type="text"
                      placeholder="Search by ID (e.g. 10101)..."
                      value={jewelrySearch}
                      onChange={(e) => handleSearchAvailableJewelry(e.target.value)}
                      className="input"
                      style={{ paddingLeft: 36, height: 38, fontSize: 13 }}
                    />
                  </div>

                  <div
                    style={{
                      maxHeight: 190,
                      overflowY: 'auto',
                      border: '1px solid var(--border-medium)',
                      borderRadius: 'var(--radius-md)',
                      background: 'var(--bg-surface-2)',
                      padding: 6,
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 5,
                    }}
                  >
                    {availableJewelry.length === 0 ? (
                      <div style={{ padding: 18, textAlign: 'center', fontSize: 13, color: 'var(--text-secondary)' }}>
                        No plated jewelry found matching your search.
                      </div>
                    ) : (
                      availableJewelry.map((item) => {
                        const isSelected = selectedPlatedItem?.id === item.id;
                        return (
                          <div
                            key={item.id}
                            onClick={() => setSelectedPlatedItem({ id: item.id, item_id: item.item_id })}
                            style={{
                              padding: '10px 14px',
                              borderRadius: 'var(--radius-sm)',
                              cursor: 'pointer',
                              display: 'flex',
                              justifyContent: 'space-between',
                              alignItems: 'center',
                              background: isSelected ? 'var(--teal-deep)' : 'var(--bg-surface-1)',
                              color: isSelected ? '#FFFFFF' : 'var(--text-primary)',
                              border: isSelected ? '1.5px solid var(--teal-deep)' : '1px solid var(--border-subtle)',
                              boxShadow: isSelected ? 'var(--shadow-sm)' : 'none',
                              transition: 'all var(--transition-fast)',
                            }}
                          >
                            <span style={{ fontWeight: isSelected ? 700 : 600, fontSize: 13 }}>{item.item_id}</span>
                            {item.is_costed && (
                              <span style={{ fontSize: 11, color: isSelected ? 'rgba(255,255,255,0.85)' : 'var(--teal-mid)', fontWeight: 600 }}>
                                Already costed
                              </span>
                            )}
                          </div>
                        );
                      })
                    )}
                  </div>
                </div>

                {/* Jewelry Weight */}
                <div className="form-group" style={{ marginBottom: 8 }}>
                  <label className="form-label" style={{ color: 'var(--text-primary)', fontWeight: 600 }}>
                    Jewelry Weight (gms, 2 decimal places) <span className="required">*</span>
                  </label>
                  <input
                    type="number"
                    step="0.01"
                    min="0.01"
                    placeholder="e.g. 23.00"
                    value={newJewelryWeight}
                    onChange={(e) => setNewJewelryWeight(e.target.value)}
                    className="input mono"
                    style={{ height: 38 }}
                    required
                  />
                  <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 5 }}>
                    Weight cost will be calculated as: <strong style={{ color: 'var(--teal-deep)' }}>Weight × Current X ({formatRupees(multiplierX)})</strong>
                  </div>
                </div>
              </div>

              <div className="modal-footer">
                <button type="button" onClick={() => setIsAddJewelryModalOpen(false)} className="btn btn-secondary">
                  Cancel
                </button>
                <button type="submit" className="btn btn-primary" disabled={!selectedPlatedItem}>
                  Save & Begin Costing
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ── MODAL: CATEGORY CELL EDITOR (Section 6.4) ──────────── */}
      {editingCell && (
        <div className="modal-backdrop">
          <div className="modal-content" style={{ maxWidth: 560 }}>
            <div className="modal-header">
              <div>
                <h3 style={{ fontSize: 17, fontWeight: 700, margin: 0, color: 'var(--teal-deep)' }}>
                  {editingCell.categoryName} — {editingCell.platedItemId}
                </h3>
                <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                  Add or edit raw materials for this design in {editingCell.categoryName}
                </span>
              </div>
              <button type="button" onClick={() => setEditingCell(null)} className="btn-icon" title="Close">
                <X size={18} />
              </button>
            </div>

            <div className="modal-body">
              {/* Existing Materials in this Cell */}
              <div style={{ marginBottom: 18 }}>
                <label className="form-label" style={{ color: 'var(--text-primary)', fontWeight: 600, marginBottom: 8 }}>
                  Selected Materials in {editingCell.categoryName}
                </label>
                {cellMaterials.length === 0 ? (
                  <div
                    style={{
                      padding: 16,
                      borderRadius: 'var(--radius-md)',
                      background: 'var(--bg-surface-2)',
                      border: '1px dashed var(--border-medium)',
                      textAlign: 'center',
                      fontSize: 13,
                      color: 'var(--text-secondary)',
                    }}
                  >
                    No materials currently selected. Use the selector below to add materials.
                  </div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {cellMaterials.map((mat, idx) => {
                      const hasMissingPrice = mat.unitCost === null || mat.unitCost === undefined;
                      return (
                        <div
                          key={idx}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            gap: 10,
                            padding: '10px 14px',
                            background: 'var(--bg-surface-2)',
                            borderRadius: 'var(--radius-md)',
                            border: '1px solid var(--border-subtle)',
                          }}
                        >
                          <div style={{ flex: 1 }}>
                            <div style={{ fontWeight: 600, fontSize: 13, color: 'var(--text-primary)' }}>{mat.materialName}</div>
                            {hasMissingPrice ? (
                              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4 }}>
                                <span style={{ fontSize: 11, color: '#D97706', fontWeight: 600 }}>Price missing: ₹</span>
                                <input
                                  type="number"
                                  step="0.01"
                                  placeholder="Enter price"
                                  style={{ width: 80, height: 26, fontSize: 12, padding: '2px 6px' }}
                                  className="input mono"
                                  onChange={(e) => handleUpdateCellMaterialPrice(idx, e.target.value)}
                                />
                              </div>
                            ) : (
                              <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                                Unit: <strong style={{ color: 'var(--teal-deep)' }}>{formatRupees(mat.unitCost)}</strong>
                              </span>
                            )}
                          </div>

                          {/* Quantity Input */}
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                            <span style={{ fontSize: 12, color: 'var(--text-secondary)', fontWeight: 500 }}>Qty:</span>
                            <input
                              type="number"
                              min="1"
                              step="1"
                              value={mat.quantity !== undefined ? String(mat.quantity) : '1'}
                              onChange={(e) => handleUpdateCellMaterialQty(idx, e.target.value)}
                              style={{ width: 60, height: 30, fontSize: 12, textAlign: 'center' }}
                              className="input mono"
                            />
                          </div>

                          <button
                            type="button"
                            onClick={() => handleRemoveMaterialFromCell(idx)}
                            className="btn-icon danger"
                            title="Remove material"
                            style={{ padding: 6 }}
                          >
                            <Trash2 size={15} />
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* Add New Material Section */}
              <div
                style={{
                  padding: 14,
                  borderRadius: 'var(--radius-md)',
                  background: 'var(--bg-surface-2)',
                  border: '1px solid var(--border-medium)',
                }}
              >
                <label className="form-label" style={{ marginBottom: 10, color: 'var(--teal-deep)', fontWeight: 700 }}>
                  + Add Material from {editingCell.categoryName}
                </label>

                <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
                  <select
                    value={selectedAddMaterialId}
                    onChange={(e) => {
                      setSelectedAddMaterialId(e.target.value);
                      const found = availableCategoryMaterials.find((m) => m.id === e.target.value);
                      if (found && found.cost_price !== null) {
                        setInlinePriceInput(String(found.cost_price));
                      } else {
                        setInlinePriceInput('');
                      }
                    }}
                    className="select"
                    style={{ flex: 1, height: 36, fontSize: 13 }}
                  >
                    <option value="">-- Choose Material --</option>
                    {availableCategoryMaterials.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name} {m.weight ? `(${m.weight.toFixed(2)} gms)` : ''} {m.cost_price !== null ? `— ₹${m.cost_price.toFixed(2)}` : '(No price)'}
                      </option>
                    ))}
                  </select>

                  <input
                    type="number"
                    min="1"
                    step="1"
                    placeholder="Qty (1)"
                    value={materialQtyInput}
                    onChange={(e) => setMaterialQtyInput(e.target.value)}
                    style={{ width: 80, height: 36, fontSize: 13, textAlign: 'center' }}
                    className="input mono"
                    title="Quantity (defaults to 1 if left empty)"
                  />

                  <button
                    type="button"
                    onClick={handleAddMaterialToCell}
                    className="btn btn-primary"
                    disabled={!selectedAddMaterialId}
                    style={{ padding: '6px 14px', fontSize: 13 }}
                  >
                    Add
                  </button>
                </div>

                {/* If selected material has missing price, offer inline price input */}
                {selectedAddMaterialId && (
                  (() => {
                    const sel = availableCategoryMaterials.find((m) => m.id === selectedAddMaterialId);
                    if (sel && sel.cost_price === null) {
                      return (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#D97706', marginTop: 8, fontWeight: 500 }}>
                          <AlertCircle size={14} />
                          <span>Price missing in master list. Set price for this design: ₹</span>
                          <input
                            type="number"
                            step="0.01"
                            placeholder="e.g. 5.00"
                            value={inlinePriceInput}
                            onChange={(e) => setInlinePriceInput(e.target.value)}
                            style={{ width: 80, height: 26, fontSize: 12, padding: '2px 6px' }}
                            className="input mono"
                          />
                        </div>
                      );
                    }
                    return null;
                  })()
                )}
              </div>
            </div>

            <div className="modal-footer">
              <button type="button" onClick={() => setEditingCell(null)} className="btn btn-secondary">
                Cancel
              </button>
              <button type="button" onClick={handleSaveCellEdits} className="btn btn-primary">
                Save & Recalculate
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Excel Restoration Modal */}
      {isRestoreModalOpen && (
        <CostingExcelRestoreModal
          isOpen={isRestoreModalOpen}
          onClose={() => setIsRestoreModalOpen(false)}
          onRestoreSuccess={loadData}
        />
      )}
    </div>
  );
};
