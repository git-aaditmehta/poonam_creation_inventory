export type UserRole = 'owner' | 'staff';

export interface User {
  id: string;
  username: string;
  email?: string | null;
  role: UserRole;
  is_active: number | boolean;
  created_at?: string;
}

export type InventoryCategory = 'plated_jewelry' | 'raw_jewelry' | 'stones' | 'foil';

export type InventoryUnit = 'PC' | 'KGS' | 'SET' | 'JODI';

export interface BaseInventoryItem {
  id: string;
  item_id: string;
  quantity: number;
  unit: InventoryUnit;
  low_stock_threshold: number;
  is_low_stock?: boolean;
  cost_price?: number; // Present only for owner
  created_at: string;
  updated_at: string;
}

export interface PlatedJewelryItem extends BaseInventoryItem {
  image_key?: string | null;
  thumb_key?: string | null;
}

export interface RawJewelryItem extends BaseInventoryItem {}

export interface StoneItem extends BaseInventoryItem {
  unit: 'PC';
}

export interface FoilItem extends BaseInventoryItem {
  unit: 'KGS';
}

export interface InventoryListResponse<T> {
  items: T[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export interface ValuationResponse {
  total_value: number;
}

export interface LowStockItem extends BaseInventoryItem {
  category: InventoryCategory;
  category_name: string;
  thumb_key?: string | null;
}

export interface Transaction {
  id: string;
  category: InventoryCategory;
  item_id: string;
  item_display_id: string;
  operation: 'add' | 'subtract';
  quantity_before: number;
  quantity_change: number;
  quantity_after: number;
  unit: string;
  performed_by: string;
  performer_name: string;
  idempotency_key?: string;
  created_at: string;
}

export interface HistoryResponse {
  transactions: Transaction[];
  totals: {
    total_added: number;
    total_subtracted: number;
  };
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export interface StockOperationPayload {
  category: InventoryCategory;
  item_id: string; // Internal UUID
  operation: 'add' | 'subtract';
  quantity: number;
  idempotency_key: string;
}

export interface StockOperationResponse {
  success: boolean;
  duplicate?: boolean;
  message?: string;
  transaction_id: string;
  item_id: string;
  operation: string;
  previous_balance: number;
  quantity_change: number;
  new_balance: number;
  unit: string;
  performed_by: string;
  timestamp: string;
}

export interface StagingRow {
  rowNumber: number;
  rawData: Record<string, any>;
  item_id: string;
  quantity: number | '';
  unit: InventoryUnit | '';
  low_stock_threshold: number | '';
  cost_price: number | '';
  status: 'pending' | 'valid' | 'invalid' | 'committed' | 'error';
  validationErrors: string[];
}

export interface AutoMapResponse {
  mapping: Record<string, string | null>;
  unmapped: string[];
  requires_manual_mapping: boolean;
}

export interface PrepareDeleteResponse {
  date_from: string;
  date_to: string;
  count: number;
  boundary_rowid: number;
  earliest_transaction: string;
  latest_transaction: string;
}

export interface StorageUsageResponse {
  d1: {
    table_counts: Record<string, number>;
    total_rows: number;
    total_size_bytes?: number;
    total_size_kb?: number;
    total_size_mb?: number;
  };
  r2: {
    object_count: number;
    total_size_bytes: number;
    total_size_mb: number;
  };
}

export interface StaffUser {
  id: string;
  username: string;
  role: 'staff';
  is_active: number;
  created_at: string;
}

export interface ToastMessage {
  id: string;
  type: 'success' | 'error' | 'info' | 'warning';
  title: string;
  message?: string;
}
