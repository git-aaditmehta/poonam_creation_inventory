import React, { useState, useEffect } from 'react';
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
} from 'lucide-react';
import { api } from '../api';
import type { InventoryCategory, BaseInventoryItem, User } from '../types';
import { useToast } from '../context/ToastContext';

interface StockOperationsViewProps {
  user?: User;
  initialCategory?: InventoryCategory;
  initialItem?: BaseInventoryItem | null;
  onOperationSuccess?: () => void;
}

export const StockOperationsView: React.FC<StockOperationsViewProps> = ({
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

  // Search items as user types
  useEffect(() => {
    if (!searchTerm.trim() || (selectedItem && selectedItem.item_id === searchTerm)) {
      setSearchResults([]);
      return;
    }

    const timer = setTimeout(async () => {
      setIsSearching(true);
      try {
        let res: any;
        if (category === 'plated_jewelry') res = await api.inventory.listPlated({ search: searchTerm.trim(), limit: 10 });
        else if (category === 'raw_jewelry') res = await api.inventory.listRaw({ search: searchTerm.trim(), limit: 10 });
        else if (category === 'stones') res = await api.inventory.listStones({ search: searchTerm.trim(), limit: 10 });
        else res = await api.inventory.listFoil({ search: searchTerm.trim(), limit: 10 });

        setSearchResults(res.items || []);
      } catch {
        setSearchResults([]);
      } finally {
        setIsSearching(false);
      }
    }, 250);

    return () => clearTimeout(timer);
  }, [searchTerm, category, selectedItem]);

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
  const projectedBalance = operation === 'add' ? currentQty + numQty : currentQty - numQty;
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
    // Generate crypto idempotency key
    const idempotencyKey = `op_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;

    try {
      const res = await api.stock.operate({
        category,
        item_id: selectedItem.id,
        operation,
        quantity: Number(quantity),
        idempotency_key: idempotencyKey,
      });

      showToast(
        'success',
        `${operation === 'add' ? 'Added' : 'Subtracted'} ${quantity} ${selectedItem.unit}`,
        `New Balance: ${res.new_balance} ${res.unit}`
      );

      setLastReceipt({
        ...res,
        item_id: selectedItem.item_id,
        category,
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
      showToast('error', 'Stock Operation Failed', err.message);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div style={{ padding: '24px', maxWidth: '800px', margin: '0 auto', width: '100%' }}>
      {/* Title */}
      <div style={{ marginBottom: 24, textAlign: 'center' }}>
        <h2 style={{ fontSize: 24, fontWeight: 800 }}>⚡ Stock Operations Center</h2>
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
          <Gem size={15} /> Stones
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
                <div style={{ fontSize: 18, fontWeight: 800, color: 'var(--text-primary)' }} className="mono">
                  {selectedItem.item_id}
                </div>
              </div>

              <div style={{ textAlign: 'right' }}>
                <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Balance</span>
                <div
                  style={{
                    fontSize: 22,
                    fontWeight: 800,
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
              <div style={{ fontSize: 16, fontWeight: 800 }} className="mono">
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
              background: 'var(--emerald-bg)',
              border: '1px solid var(--emerald-border)',
              borderRadius: 'var(--radius-md)',
              animation: 'fadeIn 200ms ease-out',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
              <CheckCircle2 size={18} color="var(--emerald-text)" />
              <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--emerald-text)' }}>
                Transaction Verified & Logged
              </div>
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
              Item <strong>{lastReceipt.item_id}</strong> updated by <strong>{lastReceipt.performed_by}</strong>.
            </div>
            <div style={{ fontSize: 13, fontWeight: 700, marginTop: 4, color: 'var(--text-primary)' }} className="mono">
              Balance: {lastReceipt.previous_balance} → {lastReceipt.new_balance} {lastReceipt.unit}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
