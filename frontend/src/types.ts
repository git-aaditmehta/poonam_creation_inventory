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
  cost_price_cents?: number;
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

// Visual Search (AI Scanner) Types
export interface VisualSearchMatch {
  id: string;
  item_id: string;
  quantity: number;
  unit: InventoryUnit;
  low_stock_threshold: number;
  is_low_stock: boolean;
  image_key?: string | null;
  thumb_key?: string | null;
  score: number;
  created_at: string;
  updated_at: string;
  cost_price?: number; // Present only for owner
  // Test diagnostics (v2 pipeline)
  match_category?: string | null;
  match_prompt_version?: string;
  match_embedding_text?: string | null;
  match_attributes?: JewelryAttributes | null;
}

export type ScanCategory = 'earring' | 'stud' | 'jhumka' | 'bracelet' | 'pendant_set';

export interface JewelryAttributes {
  is_jewelry: boolean;
  category?: string;
  structure?: string;
  outline_shape?: string;
  metal_tone?: string;
  main_stone_type?: string;
  center_stone_color?: string;
  center_stone_shape?: string;
  accent_colors?: string[];
  enamel_color?: string;
  stone_layout?: string;
  motif?: string;
  jhumka_count?: number;
  has_pearls?: boolean;
  has_hanging_beads?: boolean;
  has_cz_border?: boolean;
}

export interface VisualSearchDescriptor {
  success: boolean;
  indexed: boolean;
  category?: string | null;
  prompt_version?: string;
  embedding_text?: string | null;
  attributes?: JewelryAttributes | null;
  values?: number[];
}

export interface SearchTelemetry {
  vision_ms: number;
  embedding_ms: number;
  total_ms: number;
  image_bytes: number;
  description_length: number;
  vector_dimensions: number;
  vision_model: string;
  embedding_model: string;
  vectorize_ms?: number;
  db_ms?: number;
  total_pipeline_ms?: number;
  matches_found?: number;
  matches_above_threshold?: number;
  matches_with_db_data?: number;
  score_threshold?: number;
  vision_attempts?: number;
  prompt_tokens?: number | null;
  completion_tokens?: number | null;
  prompt_version?: string;
}

export interface VisualSearchResponse {
  success: boolean;
  query_time_ms: number;
  matches: VisualSearchMatch[];
  ai_description?: string;
  telemetry?: SearchTelemetry;
  error?: string;
  message?: string;
  quota_exhausted?: boolean;
  prompt_version?: string;
  category_filter?: ScanCategory | null;
  ai_attributes?: JewelryAttributes | null;
  embedding_text?: string | null;
  raw_vision_output?: string | null;
  rejected?: boolean;
  rejection_reason?: string;
  filter_warning?: string | null;
  query_vector?: number[];
}

export interface VisualSearchBackfillResponse {
  success: boolean;
  batch_size: number;
  embedded: number;
  failed: number;
  skipped: number;
  remaining: number;
  quota_exhausted: boolean;
  errors: string[];
  message?: string;
  reset_at_utc?: string;
}

export interface VisualSearchStatusResponse {
  success: boolean;
  total_items: number;
  with_images: number;
  indexed: number;
  coverage_percent: number;
  remaining: number;
  pipeline?: {
    vision_model: string;
    embedding_model: string;
    vector_dimensions: number;
    max_items_free_tier: number;
    prompt_version?: string;
  };
}

