import React, { useState, useEffect, useCallback } from 'react';
import {
  PlusCircle,
  MinusCircle,
  CheckCircle2,
  Loader2,
  Search,
  Package,
  Layers,
  Gem,
  Scroll,
  Clock,
} from 'lucide-react';
import { api } from '../api';
import { localDb } from '../lib/localDb';
import { enqueuePendingOp, getAllPendingOps, type PendingOp } from '../lib/pendingOps';
import type { InventoryCategory, BaseInventoryItem, User } from '../types';
import { useToast } from '../context/ToastContext';
import { parseFriendlyError } from '../utils/friendlyErrors';

interface StockOperationsViewProps {
  user?: User;
  initialCategory?: InventoryCategory;
  initialItem?: BaseInventoryItem | null;
  onOperationSuccess?: () => void;
}

export const StockOperationsView: React.FC<StockOperationsViewProps> = ({
  user,
  initialCategory = 'plated_jewelry',
  initialItem = null,
  onOperationSuccess,
}) => {
  const { showToast } = useToast();

  const [category, setCategory] = useState<InventoryCategory>(initialCategory);
  const [searchTerm, setSearchTerm] = useState(initialItem ? initialItem.item_id : '');
  const [searchResults, setSearchResults] = useState<BaseInventoryItem[]>([]);
  const [selectedItem, setSelectedItem] = useState<BaseInventoryItem | null>(initialItem);
  const [isSearching, setIsSearching] = useState(false);

  const [operation, setOperation] = useState<'add' | 'subtract'>('add');
  const [quantity, setQuantity] = useState<number | ''>('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [lastReceipt, setLastReceipt] = useState<any | null>(null);

  // Search items as user types — from local DB (instant) with API fallback
  useEffect(() => {
    if (!searchTerm.trim() || (selectedItem && selectedItem.item_id === searchTerm)) {
      setSearchResults([]);
      return;
    }

    const timer = setTimeout(async () => {
      setIsSearching(true);
      try {
        // Local DB search first (sub-millisecond)
        const table = category === 'plated_jewelry' ? 'plated_jewelry'
          : category === 'raw_jewelry' ? 'raw_jewelry'
          : category === 'stones' ? 'stones' : 'foil';
        const items = await localDb.query<BaseInventoryItem>(
          `SELECT * FROM ${table} WHERE is_deleted = 0 AND item_id LIKE ? ORDER BY item_id ASC LIMIT 10`,
          [`%${searchTerm.trim()}%`]
        );
        setSearchResults(items);
      } catch {
        // Fallback to API
        try {
          let res: any;
          if (category === 'plated_jewelry') res = await api.inventory.listPlated({ search: searchTerm.trim(), limit: 10 });
          else if (category === 'raw_jewelry') res = await api.inventory.listRaw({ search: searchTerm.trim(), limit: 10 });
          else if (category === 'stones') res = await api.inventory.listStones({ search: searchTerm.trim(), limit: 10 });
          else res = await api.inventory.listFoil({ search: searchTerm.trim(), limit: 10 });
          setSearchResults(res.items || []);
        } catch {
          setSearchResults([]);
        }
      } finally {
        setIsSearching(false);
      }
    }, 150);

    return () => clearTimeout(timer);
  }, [searchTerm, category, selectedItem]);

  // Keep state synchronized if initialCategory or initialItem changes from external actions
  useEffect(() => {
    if (initialCategory) setCategory(initialCategory);
    if (initialItem) {
      setSelectedItem(initialItem);
      setSearchTerm(initialItem.item_id);
    }
  }, [initialCategory, initialItem]);

  // Track pending offline operations for real-time visibility in this view
  const [pendingOps, setPendingOps] = useState<PendingOp[]>([]);

  const loadPendingOps = useCallback(async () => {
    try {
      const ops = await getAllPendingOps();
      setPendingOps(ops.filter(o => o.status === 'PENDING' || o.status === 'SYNCING'));
    } catch {
      setPendingOps([]);
    }
  }, []);

  useEffect(() => {
    loadPendingOps();
    const handler = () => loadPendingOps();
    window.addEventListener('pending-ops-changed', handler);
    return () => window.removeEventListener('pending-ops-changed', handler);
  }, [loadPendingOps]);

  const handleCategoryChange = (newCat: InventoryCategory) => {
    setCategory(newCat);
    setSelectedItem(null);
    setSearchTerm('');
    setSearchResults([]);
    setLastReceipt(null);
  };

  const handleSelectItem = (item: BaseInventoryItem) => {
    setSelectedItem(item);
    setSearchTerm(item.item_id);
    setSearchResults([]);
  };

  // Projected stock balance
  const currentQty = selectedItem ? selectedItem.quantity : 0;
  const numQty = typeof quantity === 'number' ? quantity : 0;
  const isFoil = category === 'foil';
  const rawProjected = operation === 'add' ? currentQty + numQty : currentQty - numQty;
  const projectedBalance = isFoil ? Math.round(rawProjected * 1000) / 1000 : Math.round(rawProjected);
  const isInsufficient = operation === 'subtract' && typeof quantity === 'number' && numQty > currentQty;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedItem) {
      showToast('error', 'Select Item', 'Please search and select an item first');
      return;
    }
    if (quantity === '' || quantity <= 0) {
      showToast('error', 'Invalid Quantity', 'Please enter a positive quantity');
      return;
    }
    if (isInsufficient) {
      showToast('error', 'Insufficient Stock', `Cannot subtract ${quantity}. Only ${currentQty} in stock.`);
      return;
    }

    setIsSubmitting(true);
    // Generate crypto idempotency key & IDs
    const idempotencyKey = `op_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    const changeQty = isFoil ? Math.round(Number(quantity) * 1000) / 1000 : Math.round(Number(quantity));
    const rawNewBalance = operation === 'add' ? currentQty + changeQty : currentQty - changeQty;
    const newBalance = isFoil ? Math.round(rawNewBalance * 1000) / 1000 : Math.round(rawNewBalance);
    const isOffline = typeof navigator !== 'undefined' && !navigator.onLine;
    const nowIso = new Date().toISOString();
    const txId = `tx_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;

    // Reusable offline executor: records mutation locally & queues for cloud background sync
    const executeOffline = async () => {
      // 1. Enqueue to pending_ops table
      await enqueuePendingOp({
        idempotency_key: idempotencyKey,
        entity_type: category,
        operation: operation === 'add' ? 'Add Stock' : 'Subtract Stock',
        endpoint: '/api/stock/operate',
        method: 'POST',
        payload: JSON.stringify({
          category,
          item_id: selectedItem.id,
          operation,
          quantity: changeQty,
          idempotency_key: idempotencyKey,
          display_item_id: selectedItem.item_id,
          unit: selectedItem.unit,
        }),
      });

      // 2. Optimistic local update in SQLite
      try {
        await localDb.exec(
          `UPDATE ${category} SET quantity = ?, updated_at = ? WHERE id = ?`,
          [newBalance, nowIso, selectedItem.id]
        );
        await localDb.exec(
          `INSERT INTO transactions
            (id, category, item_id, item_display_id, operation, quantity_before,
             quantity_change, quantity_after, unit, performed_by, performer_name, idempotency_key, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            txId, category, selectedItem.id, selectedItem.item_id, operation,
            currentQty, changeQty, newBalance, selectedItem.unit,
            user?.id || 'offline_user', user?.username || 'You (Offline)', idempotencyKey, nowIso
          ]
        );
        window.dispatchEvent(new CustomEvent('localdb-change', { detail: { store: category } }));
      } catch (dbErr) {
        console.error('[StockOperations] Local DB update error:', dbErr);
      }

      showToast(
        'success',
        `${operation === 'add' ? 'Added' : 'Subtracted'} ${changeQty} ${selectedItem.unit} (Offline Queued)`,
        `New Balance: ${newBalance} ${selectedItem.unit} • Queued in Sync Queue`
      );

      setLastReceipt({
        success: true,
        transaction_id: txId,
        item_id: selectedItem.item_id,
        category,
        operation,
        quantity_before: currentQty,
        quantity_change: changeQty,
        new_balance: newBalance,
        unit: selectedItem.unit,
        performed_by: user?.username || 'You (Offline)',
        offline: true,
      });

      setSelectedItem({
        ...selectedItem,
        quantity: newBalance,
      });
      setQuantity('');

      if (onOperationSuccess) {
        onOperationSuccess();
      }
    };

    if (isOffline) {
      await executeOffline();
      setIsSubmitting(false);
      return;
    }

    try {
      const res = await api.stock.operate({
        category,
        item_id: selectedItem.id,
        operation,
        quantity: changeQty,
        idempotency_key: idempotencyKey,
      });

      // Synchronously update local SQLite so local reads stay in sync immediately
      try {
        await localDb.exec(
          `UPDATE ${category} SET quantity = ?, updated_at = ? WHERE id = ?`,
          [res.new_balance, nowIso, selectedItem.id]
        );
        await localDb.exec(
          `INSERT INTO transactions
            (id, category, item_id, item_display_id, operation, quantity_before,
             quantity_change, quantity_after, unit, performed_by, performer_name, idempotency_key, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            res.transaction_id || txId, category, selectedItem.id, selectedItem.item_id, operation,
            res.previous_balance ?? currentQty, res.quantity_change ?? changeQty, res.new_balance, res.unit ?? selectedItem.unit,
            user?.id || '', user?.username || 'Staff', idempotencyKey, nowIso
          ]
        );
        window.dispatchEvent(new CustomEvent('localdb-change', { detail: { store: category } }));
      } catch (dbErr) {
        console.error('[StockOperations] Local DB sync error:', dbErr);
      }

      showToast(
        'success',
        `${operation === 'add' ? 'Added' : 'Subtracted'} ${changeQty} ${selectedItem.unit}`,
        `New Balance: ${res.new_balance} ${res.unit}`
      );

      setLastReceipt({
        ...res,
        item_id: selectedItem.item_id,
        category,
        performed_by: user?.username || 'Staff',
      });

      // Update local item balance
      setSelectedItem({
        ...selectedItem,
        quantity: res.new_balance,
      });
      setQuantity('');

      if (onOperationSuccess) {
        onOperationSuccess();
      }
    } catch (err: any) {
      const isNetworkErr =
        !navigator.onLine ||
        err.message === 'Failed to fetch' ||
        err.message === 'Load failed' ||
        err.message?.toLowerCase().includes('network') ||
        err.message?.toLowerCase().includes('fetch') ||
        err.status === 0;

      if (isNetworkErr) {
        // Network failed during request — fall back to offline queue!
        await executeOffline();
      } else {
        const friendly = parseFriendlyError(err, { categoryName: category, itemId: selectedItem.item_id });
        showToast('error', friendly.title, `${friendly.message} ${friendly.solution}`);
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="view-container">
      {/* Title */}
      <div style={{ marginBottom: 24, textAlign: 'center' }}>
        <h2 style={{ fontSize: 24, fontWeight: 700 }}>⚡ Stock Operations Center</h2>
        <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 4 }}>
          Atomic add & subtract transactions with real-time balance validation.
        </p>
      </div>

      {/* Category Pills */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(4, 1fr)',
          gap: 8,
          marginBottom: 24,
          background: 'var(--bg-surface-1)',
          padding: 6,
          borderRadius: 'var(--radius-lg)',
          border: '1px solid var(--border-subtle)',
        }}
      >
        <button
          type="button"
          onClick={() => handleCategoryChange('plated_jewelry')}
          className={`btn ${category === 'plated_jewelry' ? 'btn-primary' : 'btn-secondary'}`}
          style={{ padding: '10px 8px', fontSize: 12 }}
        >
          <Package size={15} /> Plated
        </button>
        <button
          type="button"
          onClick={() => handleCategoryChange('raw_jewelry')}
          className={`btn ${category === 'raw_jewelry' ? 'btn-primary' : 'btn-secondary'}`}
          style={{ padding: '10px 8px', fontSize: 12 }}
        >
          <Layers size={15} /> Raw
        </button>
        <button
          type="button"
          onClick={() => handleCategoryChange('stones')}
          className={`btn ${category === 'stones' ? 'btn-primary' : 'btn-secondary'}`}
          style={{ padding: '10px 8px', fontSize: 12 }}
        >
          <Gem size={15} /> Kundan Stone
        </button>
        <button
          type="button"
          onClick={() => handleCategoryChange('foil')}
          className={`btn ${category === 'foil' ? 'btn-primary' : 'btn-secondary'}`}
          style={{ padding: '10px 8px', fontSize: 12 }}
        >
          <Scroll size={15} /> Foil
        </button>
      </div>

      {/* Main Operations Card */}
      <div
        style={{
          background: 'var(--bg-surface-1)',
          border: '1px solid var(--border-medium)',
          borderRadius: 'var(--radius-lg)',
          padding: '24px',
          boxShadow: 'var(--shadow-md)',
        }}
      >
        <form onSubmit={handleSubmit}>
          {/* Item Autocomplete Search */}
          <div className="form-group" style={{ position: 'relative' }}>
            <label className="form-label" htmlFor="stock-item-search">
              Select {category.replace('_', ' ')} item
            </label>
            <div style={{ position: 'relative' }}>
              <Search size={16} color="var(--text-muted)" style={{ position: 'absolute', left: 12, top: 12 }} />
              <input
                id="stock-item-search"
                type="text"
                className="input mono"
                style={{ paddingLeft: 38 }}
                placeholder="Type design code or item ID to search..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                autoComplete="off"
              />
              {isSearching && (
                <Loader2
                  size={16}
                  className="animate-spin"
                  style={{ position: 'absolute', right: 12, top: 12, color: 'var(--text-muted)' }}
                />
              )}
            </div>

            {/* Dropdown Menu Results */}
            {searchResults.length > 0 && (
              <div
                style={{
                  position: 'absolute',
                  top: '100%',
                  left: 0,
                  right: 0,
                  background: 'var(--bg-surface-2)',
                  border: '1px solid var(--border-strong)',
                  borderRadius: 'var(--radius-md)',
                  boxShadow: 'var(--shadow-lg)',
                  zIndex: 20,
                  maxHeight: 220,
                  overflowY: 'auto',
                  marginTop: 4,
                }}
              >
                {searchResults.map((item) => (
                  <div
                    key={item.id}
                    onClick={() => handleSelectItem(item)}
                    style={{
                      padding: '10px 14px',
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      cursor: 'pointer',
                      borderBottom: '1px solid var(--border-subtle)',
                      transition: 'background var(--transition-fast)',
                    }}
                    onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--bg-surface-3)')}
                    onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                  >
                    <div style={{ fontWeight: 700 }} className="mono">
                      {item.item_id}
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                      In Stock: <strong className="mono">{item.quantity} {item.unit}</strong>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Selected Item Detail Banner */}
          {selectedItem && (
            <div
              style={{
                background: 'var(--bg-surface-2)',
                border: '1px solid var(--border-subtle)',
                borderRadius: 'var(--radius-md)',
                padding: '14px 18px',
                marginBottom: 20,
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
              }}
            >
              <div>
                <span style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase' }}>
                  Current Autoritative Stock
                </span>
                <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--text-primary)' }} className="mono">
                  {selectedItem.item_id}
                </div>
              </div>

              <div style={{ textAlign: 'right' }}>
                <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Balance</span>
                <div
                  style={{
                    fontSize: 22,
                    fontWeight: 700,
                    color: selectedItem.quantity < selectedItem.low_stock_threshold ? 'var(--amber-text)' : 'var(--emerald-text)',
                  }}
                  className="mono"
                >
                  {selectedItem.quantity} {selectedItem.unit}
                </div>
              </div>
            </div>
          )}

          {/* Operation Direction Buttons (Add vs Subtract) */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 20 }}>
            <button
              type="button"
              onClick={() => setOperation('add')}
              style={{
                padding: '14px',
                borderRadius: 'var(--radius-md)',
                border: operation === 'add' ? '2px solid var(--emerald-text)' : '1px solid var(--border-medium)',
                background: operation === 'add' ? 'var(--emerald-bg)' : 'var(--bg-surface-2)',
                color: operation === 'add' ? 'var(--emerald-text)' : 'var(--text-secondary)',
                fontWeight: 700,
                fontSize: 14,
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 8,
                transition: 'all var(--transition-fast)',
              }}
            >
              <PlusCircle size={18} /> Add Stock (+)
            </button>

            <button
              type="button"
              onClick={() => setOperation('subtract')}
              style={{
                padding: '14px',
                borderRadius: 'var(--radius-md)',
                border: operation === 'subtract' ? '2px solid var(--rose-text)' : '1px solid var(--border-medium)',
                background: operation === 'subtract' ? 'var(--rose-bg)' : 'var(--bg-surface-2)',
                color: operation === 'subtract' ? 'var(--rose-text)' : 'var(--text-secondary)',
                fontWeight: 700,
                fontSize: 14,
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 8,
                transition: 'all var(--transition-fast)',
              }}
            >
              <MinusCircle size={18} /> Subtract Stock (-)
            </button>
          </div>

          {/* Quantity Input */}
          <div className="form-group">
            <label className="form-label" htmlFor="stock-quantity">
              Quantity to {operation === 'add' ? 'Add' : 'Deduct'} {selectedItem ? `(${selectedItem.unit})` : ''}
            </label>
            <input
              id="stock-quantity"
              type="number"
              step="any"
              min="0.001"
              className={`input mono ${isInsufficient ? 'error' : ''}`}
              placeholder="Enter amount..."
              value={quantity}
              onChange={(e) => setQuantity(e.target.value === '' ? '' : Number(e.target.value))}
              required
            />
            {isInsufficient && (
              <span className="form-error">
                Cannot subtract {quantity}. Current balance is only {currentQty} {selectedItem?.unit}.
              </span>
            )}
          </div>

          {/* Projected Balance Preview Card */}
          {selectedItem && typeof quantity === 'number' && quantity > 0 && !isInsufficient && (
            <div
              style={{
                background: 'var(--bg-surface-3)',
                borderRadius: 'var(--radius-md)',
                padding: '12px 16px',
                marginBottom: 20,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
              }}
            >
              <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>Projected Balance:</div>
              <div style={{ fontSize: 16, fontWeight: 700 }} className="mono">
                <span style={{ color: 'var(--text-muted)' }}>{currentQty}</span>
                <span style={{ color: operation === 'add' ? 'var(--emerald-text)' : 'var(--rose-text)', margin: '0 6px' }}>
                  {operation === 'add' ? '+' : '-'} {quantity}
                </span>
                <span style={{ color: 'var(--gold-primary)' }}>= {projectedBalance} {selectedItem.unit}</span>
              </div>
            </div>
          )}

          {/* Submit Button */}
          <button
            type="submit"
            className="btn btn-primary"
            style={{ width: '100%', padding: '14px', fontSize: 15 }}
            disabled={!selectedItem || quantity === '' || isInsufficient || isSubmitting}
          >
            {isSubmitting ? (
              <>
                <Loader2 size={16} className="animate-spin" /> Committing Transaction...
              </>
            ) : (
              <>
                Confirm {operation === 'add' ? 'Stock Addition' : 'Stock Deduction'}
              </>
            )}
          </button>
        </form>

        {/* Transaction Receipt Card */}
        {lastReceipt && (
          <div
            style={{
              marginTop: 24,
              padding: '16px 20px',
              background: lastReceipt.offline ? 'rgba(245, 158, 11, 0.1)' : 'var(--emerald-bg)',
              border: `1px solid ${lastReceipt.offline ? 'rgba(245, 158, 11, 0.3)' : 'var(--emerald-border)'}`,
              borderRadius: 'var(--radius-md)',
              animation: 'fadeIn 200ms ease-out',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                {lastReceipt.offline ? (
                  <Clock size={18} color="#f59e0b" />
                ) : (
                  <CheckCircle2 size={18} color="var(--emerald-text)" />
                )}
                <div style={{ fontSize: 14, fontWeight: 700, color: lastReceipt.offline ? '#f59e0b' : 'var(--emerald-text)' }}>
                  {lastReceipt.offline ? 'Transaction Queued Offline' : 'Transaction Verified & Logged'}
                </div>
              </div>
              {lastReceipt.offline && (
                <span style={{
                  fontSize: 11, padding: '2px 8px', borderRadius: 9999,
                  background: 'rgba(245, 158, 11, 0.2)', color: '#f59e0b', fontWeight: 600
                }}>
                  Sync Pending
                </span>
              )}
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
              Item <strong>{lastReceipt.item_id}</strong> updated by <strong>{lastReceipt.performed_by || user?.username || 'You'}</strong>.
              {lastReceipt.offline && ' Will auto-sync to cloud when online.'}
            </div>
            <div style={{ fontSize: 13, fontWeight: 700, marginTop: 4, color: 'var(--text-primary)' }} className="mono">
              Balance: {lastReceipt.quantity_before ?? lastReceipt.previous_balance} → {lastReceipt.new_balance} {lastReceipt.unit}
            </div>
          </div>
        )}

        {/* Offline Operations Waiting for Sync Card */}
        {pendingOps.length > 0 && (
          <div
            style={{
              marginTop: 24,
              padding: '16px 20px',
              background: 'rgba(245, 158, 11, 0.06)',
              border: '1px solid rgba(245, 158, 11, 0.22)',
              borderRadius: 'var(--radius-md)',
              animation: 'fadeIn 200ms ease-out',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Clock size={16} color="#f59e0b" />
                <span style={{ fontSize: 13, fontWeight: 600, color: '#f59e0b' }}>
                  Offline Operations Queue ({pendingOps.length})
                </span>
              </div>
              <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
                Syncs automatically on reconnect
              </span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {pendingOps.map((op) => {
                let detail = '';
                try {
                  const p = typeof op.payload === 'string' ? JSON.parse(op.payload) : op.payload;
                  if (p.operation && p.quantity && p.display_item_id) {
                    detail = `${p.operation === 'add' ? '+' : '-'}${p.quantity} ${p.unit || ''} • Item ${p.display_item_id}`;
                  }
                } catch { /* ignore */ }
                return (
                  <div
                    key={op.id}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      padding: '8px 12px',
                      background: 'var(--bg-surface-2)',
                      borderRadius: 6,
                      fontSize: 12,
                      border: '1px solid var(--border-subtle)',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{op.operation}</span>
                      <span style={{
                        fontSize: 10, padding: '1px 5px', borderRadius: 4,
                        background: 'rgba(255, 255, 255, 0.06)', color: 'var(--text-secondary)',
                        textTransform: 'capitalize'
                      }}>
                        {op.entity_type.replace(/_/g, ' ')}
                      </span>
                      {detail && <span style={{ color: 'var(--gold-primary)', fontWeight: 500 }} className="mono">({detail})</span>}
                    </div>
                    <span style={{ color: op.status === 'SYNCING' ? 'var(--teal-deep)' : '#f59e0b', fontSize: 11, fontWeight: 600 }}>
                      {op.status === 'SYNCING' ? 'Syncing...' : 'Pending'}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
