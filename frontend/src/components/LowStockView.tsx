import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { AlertTriangle, ArrowRight, Loader2, CheckCircle2, FileText, Filter } from 'lucide-react';
import { api } from '../api';
import { localDb } from '../lib/localDb';
import type { LowStockItem, InventoryCategory } from '../types';
import { useToast } from '../context/ToastContext';
import { errorText } from '../utils/friendlyErrors';
import { StockPdfModal } from './StockPdfModal';
import type { GeneratedPdfResult } from '../utils/pdfGenerator';
import { useJewelryTypes, typeOfItemId, typeLabel } from '../utils/jewelryCategory';

const CATEGORY_LABEL: Record<string, string> = {
  plated_jewelry: 'Plated Jewelry',
  raw_jewelry: 'Raw Jewelry',
  stones: 'Kundan Stone',
  foil: 'Foil',
};
const num = (n: number) => (Number.isInteger(n) ? String(n) : String(Math.round(n * 1000) / 1000));

interface LowStockViewProps {
  onQuickRestock: (category: InventoryCategory, item: any) => void;
}

export const LowStockView: React.FC<LowStockViewProps> = ({ onQuickRestock }) => {
  const { showToast } = useToast();
  const [items, setItems] = useState<LowStockItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  // Filters (owner and staff): category, and for Plated / Raw the jewelry type
  const [category, setCategory] = useState('');
  const [jewelryType, setJewelryType] = useState('');
  const jewelryTypes = useJewelryTypes();
  const [pdfResult, setPdfResult] = useState<GeneratedPdfResult | null>(null);
  const [makingPdf, setMakingPdf] = useState(false);

  const fetchLowStock = useCallback(async () => {
    try {
      const lowStockItems = await localDb.getLowStockItems();
      setItems(lowStockItems as LowStockItem[]);
    } catch {
      try {
        const res = await api.inventory.getLowStock();
        setItems(res.items);
      } catch (err: any) {
        showToast('error', 'Failed to fetch low stock alerts', errorText(err));
      }
    } finally {
      setIsLoading(false);
    }
  }, [showToast]);

  useEffect(() => {
    fetchLowStock();
  }, [fetchLowStock]);

  useEffect(() => {
    const handler = () => fetchLowStock();
    window.addEventListener('localdb-change', handler);
    return () => window.removeEventListener('localdb-change', handler);
  }, [fetchLowStock]);

  const hasTypes = category === 'plated_jewelry' || category === 'raw_jewelry';
  const shown = useMemo(
    () =>
      items.filter((it) => {
        if (category && it.category !== category) return false;
        if (hasTypes && jewelryType) {
          const t = typeOfItemId(it.item_id, jewelryTypes);
          if (jewelryType === 'other' ? t !== null : t?.prefix !== jewelryType) return false;
        }
        return true;
      }),
    [items, category, jewelryType, hasTypes, jewelryTypes],
  );
  const filterText = () => {
    const parts = [`Category: ${category ? CATEGORY_LABEL[category] : 'All'}`];
    if (hasTypes && jewelryType) {
      const t = jewelryTypes.find((x) => x.prefix === jewelryType);
      parts.push(`Type: ${jewelryType === 'other' ? 'Other' : t ? typeLabel(t) : jewelryType}`);
    }
    return parts.join('   |   ');
  };

  const handleGeneratePdf = async () => {
    if (shown.length === 0) {
      showToast('info', 'Nothing to put in the PDF', 'No items are below their minimum for the selected filter.');
      return;
    }
    setMakingPdf(true);
    try {
      const { generateLowStockPdf } = await import('../utils/lowStockPdf');
      setPdfResult(generateLowStockPdf(shown, filterText()));
    } catch (err) {
      showToast('error', 'PDF could not be made', errorText(err));
    } finally {
      setMakingPdf(false);
    }
  };

  return (
    <div className="view-container">
      {/* Header */}
      <div style={{ marginBottom: 24 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <AlertTriangle size={24} color="var(--amber-text)" />
          <h2 style={{ fontSize: 22, fontWeight: 700 }}>Low Stock Alert Center</h2>
        </div>
        <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 4 }}>
          Items currently below safe threshold across all 4 manufacturing categories.
        </p>
      </div>

      {/* Filters + PDF */}
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10, marginBottom: 16, background: 'var(--bg-surface-1)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-lg)', padding: 12 }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: 'var(--text-secondary)' }}>
          <Filter size={15} /> Filter:
        </span>
        <select
          className="select"
          style={{ width: 'auto', minWidth: 160 }}
          value={category}
          onChange={(e) => {
            setCategory(e.target.value);
            setJewelryType('');
          }}
          aria-label="Category"
        >
          <option value="">All categories</option>
          {Object.entries(CATEGORY_LABEL).map(([k, v]) => (
            <option key={k} value={k}>{v}</option>
          ))}
        </select>
        {hasTypes && (
          <select className="select" style={{ width: 'auto', minWidth: 160 }} value={jewelryType} onChange={(e) => setJewelryType(e.target.value)} aria-label="Jewelry type">
            <option value="">All types</option>
            {jewelryTypes.map((t) => (
              <option key={t.prefix} value={t.prefix}>{typeLabel(t)}</option>
            ))}
            <option value="other">Other</option>
          </select>
        )}
        <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
          Showing {shown.length} of {items.length}
        </span>
        <button type="button" className="btn btn-secondary" style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 6 }} onClick={handleGeneratePdf} disabled={makingPdf || isLoading}>
          {makingPdf ? <Loader2 size={15} className="animate-spin" /> : <FileText size={15} />} {makingPdf ? 'Generating...' : 'Generate PDF'}
        </button>
      </div>

      {isLoading ? (
        <div style={{ textAlign: 'center', padding: '60px 0', color: 'var(--text-muted)' }}>
          <Loader2 size={32} className="animate-spin" style={{ margin: '0 auto 12px' }} />
          <div>Checking inventory thresholds...</div>
        </div>
      ) : items.length > 0 && shown.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '40px 20px', color: 'var(--text-secondary)', background: 'var(--bg-surface-1)', borderRadius: 'var(--radius-lg)', border: '1px dashed var(--border-medium)' }}>
          Nothing below its minimum in {filterText().replace(/Category: |Type: /g, '').replace('   |   ', ' · ')}. {items.length} item{items.length === 1 ? '' : 's'} in other categories are low.
        </div>
      ) : items.length === 0 ? (
        <div
          style={{
            textAlign: 'center',
            padding: '60px 20px',
            background: 'var(--bg-surface-1)',
            borderRadius: 'var(--radius-lg)',
            border: '1px solid var(--emerald-border)',
          }}
        >
          <CheckCircle2 size={48} color="var(--emerald-text)" style={{ margin: '0 auto 16px' }} />
          <h3 style={{ fontSize: 18, color: 'var(--emerald-text)' }}>All Inventories Healthy</h3>
          <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 6 }}>
            Every item across Plated, Raw, Kundan Stone, and Foil meets or exceeds its low stock threshold.
          </p>
        </div>
      ) : (
        <div className="table-container">
          <table className="data-table">
            <thead>
              <tr>
                <th>Category</th>
                <th>Item Code</th>
                <th>Current Stock</th>
                <th>Required Min</th>
                <th>Shortage Deficit</th>
                <th style={{ textAlign: 'right' }}>Action</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((item) => {
                const deficit = item.low_stock_threshold - item.quantity;
                return (
                  <tr key={`${item.category}_${item.id}`} className="row-low-stock">
                    <td>
                      <span className="badge badge-gold">{item.category_name}</span>
                    </td>
                    <td>
                      <div style={{ fontWeight: 700, fontSize: 14 }} className="mono">
                        {item.item_id}
                      </div>
                    </td>
                    <td>
                      <span style={{ fontSize: 16, fontWeight: 700, color: 'var(--rose-text)' }} className="mono">
                        {item.quantity} {item.unit}
                      </span>
                    </td>
                    <td className="mono" style={{ color: 'var(--text-secondary)' }}>
                      {item.low_stock_threshold} {item.unit}
                    </td>
                    <td>
                      <span className="badge badge-rose mono">
                        -{num(deficit)} {item.unit}
                      </span>
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <button
                        onClick={() => onQuickRestock(item.category, item)}
                        className="btn btn-primary"
                        style={{ padding: '6px 12px', fontSize: 12 }}
                      >
                        Restock Now <ArrowRight size={14} />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {pdfResult && (
        <StockPdfModal
          pdfResult={pdfResult}
          categoryTitle="Low Stock"
          heading="Low Stock List"
          subtitle={`${pdfResult.totalItems} item${pdfResult.totalItems === 1 ? '' : 's'} below minimum • no prices`}
          shareText={`Low stock list: ${pdfResult.totalItems} item${pdfResult.totalItems === 1 ? '' : 's'} below minimum.`}
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
