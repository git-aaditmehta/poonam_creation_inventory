import React, { useState, useEffect } from 'react';
import { AlertTriangle, ArrowRight, Loader2, CheckCircle2 } from 'lucide-react';
import { api } from '../api';
import type { LowStockItem, InventoryCategory } from '../types';
import { useToast } from '../context/ToastContext';

interface LowStockViewProps {
  onQuickRestock: (category: InventoryCategory, item: any) => void;
}

export const LowStockView: React.FC<LowStockViewProps> = ({ onQuickRestock }) => {
  const { showToast } = useToast();
  const [items, setItems] = useState<LowStockItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const fetchLowStock = async () => {
      try {
        const res = await api.inventory.getLowStock();
        setItems(res.items);
      } catch (err: any) {
        showToast('error', 'Failed to fetch low stock alerts', err.message);
      } finally {
        setIsLoading(false);
      }
    };
    fetchLowStock();
  }, [showToast]);

  return (
    <div style={{ padding: '24px', maxWidth: '1200px', margin: '0 auto', width: '100%' }}>
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

      {isLoading ? (
        <div style={{ textAlign: 'center', padding: '60px 0', color: 'var(--text-muted)' }}>
          <Loader2 size={32} className="animate-spin" style={{ margin: '0 auto 12px' }} />
          <div>Checking inventory thresholds...</div>
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
            Every item across Plated, Raw, Stones, and Foil meets or exceeds its low stock threshold.
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
              {items.map((item) => {
                const deficit = item.low_stock_threshold - item.quantity;
                return (
                  <tr key={`${item.category}_${item.id}`}>
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
                        -{deficit.toFixed(2)} {item.unit}
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
    </div>
  );
};
