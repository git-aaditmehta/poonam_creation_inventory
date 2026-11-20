import type {
  User,
  InventoryListResponse,
  PlatedJewelryItem,
  RawJewelryItem,
  StoneItem,
  FoilItem,
  ValuationResponse,
  LowStockItem,
  HistoryResponse,
  StockOperationPayload,
  StockOperationResponse,
  AutoMapResponse,
  PrepareDeleteResponse,
  StorageUsageResponse,
  StaffUser,
  VisualSearchResponse,
  VisualSearchBackfillResponse,
  VisualSearchStatusResponse,
  VisualSearchDescriptor,
  ScanCategory,
  JewelryAttributes,
  DinoStatusResponse,
  DinoPendingResponse,
  DinoEmbedResponse,
  DinoSearchResponse,
  DinoDescriptor,
} from './types';

class ApiError extends Error {
  status: number;
  data: any;

  constructor(message: string, status: number, data?: any) {
    super(message);
    this.status = status;
    this.data = data;
    this.name = 'ApiError';
  }
}

import { API_BASE_URL, cloudflareLimitBody } from './lib/apiBase';

/** Absolute URL for an API path (this site's /api in the live app; see lib/apiBase.ts). */
export function apiUrl(path: string): string {
  return path.startsWith('http') ? path : `${API_BASE_URL}${path}`;
}

async function request<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
  const url = endpoint.startsWith('http') ? endpoint : `${API_BASE_URL}${endpoint}`;
  const defaultHeaders: Record<string, string> = {
    'Accept': 'application/json',
  };

  const token = sessionStorage.getItem('session_token') || localStorage.getItem('session_token');
  if (token) {
    defaultHeaders['Authorization'] = `Bearer ${token}`;
  }

  // Only set Content-Type if not sending FormData
  if (!(options.body instanceof FormData)) {
    defaultHeaders['Content-Type'] = 'application/json';
  }

  const response = await fetch(url, {
    ...options,
    credentials: 'include',
    headers: {
      ...defaultHeaders,
      ...(options.headers as Record<string, string>),
    },
  });

  const contentType = response.headers.get('content-type');
  let data: any = null;

  if (contentType && contentType.includes('application/json')) {
    data = await response.json();
  } else {
    data = await response.text();
  }

  if (!response.ok) {
    const limit = cloudflareLimitBody(response.status, data);
    if (limit) throw new ApiError(String(limit.error), 503, limit);
    if (response.status === 401) {
      sessionStorage.removeItem('session_token');
      localStorage.removeItem('session_token');
      window.dispatchEvent(new CustomEvent('auth-unauthorized'));
    }
    const errorMsg = data?.error || (data?.errors && data.errors.map((e: any) => e.message).join(', ')) || response.statusText || 'Request failed';
    throw new ApiError(errorMsg, response.status, data);
  }

  return data as T;
}

export const api = {
  // Auth
  auth: {
    bootstrap: () => request<{ success: boolean; message: string }>('/api/auth/bootstrap', { method: 'POST' }),
    login: async (identifier: string, password: string) => {
      const res = await request<{ success: boolean; user: User; session_token?: string }>('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({
          [identifier.includes('@') ? 'email' : 'username']: identifier,
          password,
        }),
      });
      if (res.session_token) {
        sessionStorage.setItem('session_token', res.session_token);
        localStorage.setItem('session_token', res.session_token);
      }
      return res;
    },
    logout: async () => {
      try {
        return await request<{ success: boolean }>('/api/auth/logout', { method: 'POST' });
      } finally {
        sessionStorage.removeItem('session_token');
        localStorage.removeItem('session_token');
      }
    },
    me: () => request<{ user: User }>('/api/auth/me'),
    createStaff: (username: string, password: string) =>
      request<{ success: boolean; user: User }>('/api/auth/staff', {
        method: 'POST',
        body: JSON.stringify({ username, password }),
      }),
    listStaff: () => request<{ staff: StaffUser[] }>('/api/auth/staff'),
    toggleStaff: (userId: string, is_active: boolean) =>
      request<{ success: boolean }>(`/api/auth/staff/${userId}`, {
        method: 'PATCH',
        body: JSON.stringify({ is_active }),
      }),
    resetStaffPassword: (userId: string, new_password: string) =>
      request<{ success: boolean }>(`/api/auth/staff/${userId}/password`, {
        method: 'POST',
        body: JSON.stringify({ new_password }),
      }),
  },

  // Inventory
  inventory: {
    listPlated: (params: { page?: number; limit?: number; search?: string; category?: string } = {}) => {
      const q = new URLSearchParams();
      if (params.page) q.set('page', params.page.toString());
      if (params.limit) q.set('limit', params.limit.toString());
      if (params.search) q.set('search', params.search);
      if (params.category) q.set('category', params.category);
      return request<InventoryListResponse<PlatedJewelryItem>>(`/api/inventory/plated-jewelry?${q.toString()}`);
    },
    listRaw: (params: { page?: number; limit?: number; search?: string; category?: string } = {}) => {
      const q = new URLSearchParams();
      if (params.page) q.set('page', params.page.toString());
      if (params.limit) q.set('limit', params.limit.toString());
      if (params.search) q.set('search', params.search);
      if (params.category) q.set('category', params.category);
      return request<InventoryListResponse<RawJewelryItem>>(`/api/inventory/raw-jewelry?${q.toString()}`);
    },
    listStones: (params: { page?: number; limit?: number; search?: string } = {}) => {
      const q = new URLSearchParams();
      if (params.page) q.set('page', params.page.toString());
      if (params.limit) q.set('limit', params.limit.toString());
      if (params.search) q.set('search', params.search);
      return request<InventoryListResponse<StoneItem>>(`/api/inventory/stones?${q.toString()}`);
    },
    listFoil: (params: { page?: number; limit?: number; search?: string } = {}) => {
      const q = new URLSearchParams();
      if (params.page) q.set('page', params.page.toString());
      if (params.limit) q.set('limit', params.limit.toString());
      if (params.search) q.set('search', params.search);
      return request<InventoryListResponse<FoilItem>>(`/api/inventory/foil?${q.toString()}`);
    },
    getValuation: (category: 'plated-jewelry' | 'stones' | 'foil') =>
      request<ValuationResponse>(`/api/inventory/${category}/valuation`),
    createItem: (category: string, payload: any) =>
      request<{ success: boolean; id: string; item_id: string; item?: any }>(`/api/inventory/${category}`, {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    updateItem: (category: string, id: string, payload: any) =>
      request<{ success: boolean }>(`/api/inventory/${category}/${id}`, {
        method: 'PUT',
        body: JSON.stringify(payload),
      }),
    deleteItem: (category: string, id: string) =>
      request<{ success: boolean }>(`/api/inventory/${category}/${id}`, {
        method: 'DELETE',
      }),
    getLowStock: () => request<{ items: LowStockItem[]; total: number }>('/api/inventory/low-stock'),
    getExportAll: (category: 'plated-jewelry' | 'raw-jewelry' | 'stones' | 'foil') =>
      request<{
        items: {
          item_id: string;
          quantity: number;
          unit: string;
          low_stock_threshold: number;
          updated_at: string;
        }[];
        count: number;
        generated_at: string;
      }>(`/api/inventory/${category}/export-all`),
  },

  // Stock Operations
  stock: {
    operate: (payload: StockOperationPayload) =>
      request<StockOperationResponse>('/api/stock/operate', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
  },

  // Transaction History
  history: {
    list: (params: {
      page?: number;
      limit?: number;
      category?: string;
      date_from?: string;
      date_to?: string;
      item_search?: string;
    } = {}) => {
      const q = new URLSearchParams();
      if (params.page) q.set('page', params.page.toString());
      if (params.limit) q.set('limit', params.limit.toString());
      if (params.category) q.set('category', params.category);
      if (params.date_from) q.set('date_from', params.date_from);
      if (params.date_to) q.set('date_to', params.date_to);
      if (params.item_search) q.set('item_search', params.item_search);
      return request<HistoryResponse>(`/api/history?${q.toString()}`);
    },
    prepareDelete: (date_from: string, date_to: string) =>
      request<PrepareDeleteResponse>('/api/history/prepare-delete', {
        method: 'POST',
        body: JSON.stringify({ date_from, date_to }),
      }),
    confirmDelete: (payload: {
      date_from: string;
      date_to: string;
      boundary_rowid: number;
      confirmation_text: string;
      backup_verified: boolean;
    }) =>
      request<{ success: boolean; deleted_count: number }>('/api/history/confirm-delete', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
  },

  // Excel & Staging
  excel: {
    autoMap: (columns: string[], category: string) =>
      request<AutoMapResponse>('/api/excel/auto-map', {
        method: 'POST',
        body: JSON.stringify({ columns, category }),
      }),
    validateRow: (row: any) =>
      request<{ valid: boolean; errors?: { field: string; message: string }[] }>('/api/excel/validate-row', {
        method: 'POST',
        body: JSON.stringify(row),
      }),
    commitRow: (row: any) =>
      request<{ success: boolean; id: string; item_id: string }>('/api/excel/commit-row', {
        method: 'POST',
        body: JSON.stringify(row),
      }),
    /** Which design codes already exist (up to 500 per call). Answer: code -> message. */
    checkRows: (category: string, item_ids: string[]) =>
      request<{ existing: Record<string, string> }>('/api/excel/check-rows', {
        method: 'POST',
        body: JSON.stringify({ category, item_ids }),
      }),
    /** Save up to 50 rows; every row gets its own answer. */
    saveRows: (
      category: string,
      rows: { id: string; item_id: string; quantity: number; unit?: string; low_stock_threshold: number; cost_price?: number }[],
    ) =>
      request<{ results: { id: string; status: 'saved' | 'not_saved'; message?: string; item?: Record<string, unknown> }[] }>(
        '/api/excel/save-rows',
        { method: 'POST', body: JSON.stringify({ category, rows }) },
      ),
  },

  /** Jewelry types (chips in Plated / Raw / Scan): everyone reads; the owner adds. */
  jewelryTypes: {
    list: () => request<{ types: { prefix: string; name: string }[] }>('/api/jewelry-categories'),
    add: (name: string, prefix: string) =>
      request<{ added: { prefix: string; name: string }; existing: { plated: number; raw: number }; types: { prefix: string; name: string }[] }>(
        '/api/jewelry-categories',
        { method: 'POST', body: JSON.stringify({ name, prefix }) },
      ),
  },

  // Backups & Storage
  backup: {
    getMasterData: () =>
      request<{
        plated_jewelry: any[];
        raw_jewelry: any[];
        stones: any[];
        foil: any[];
      }>('/api/backup/master-data'),
    getTransactions: (date_from?: string, date_to?: string) => {
      const q = new URLSearchParams();
      if (date_from) q.set('date_from', date_from);
      if (date_to) q.set('date_to', date_to);
      return request<{ transactions: any[]; count: number }>(`/api/backup/transactions?${q.toString()}`);
    },
    getStorageUsage: () => request<StorageUsageResponse>('/api/backup/storage-usage'),
  },

  // Image Upload to R2
  images: {
    upload: (formData: FormData) =>
      request<{ success: boolean; image_key: string; thumb_key: string; photo_etag?: string | null }>('/api/images/upload', {
        method: 'POST',
        body: formData,
      }),
    getUrl: (key?: string | null, timestamp?: string) => {
      if (!key) return '';
      if (key.startsWith('blob:') || key.startsWith('data:')) return key;
      const base = `${API_BASE_URL}/api/images/${key}`;
      // Versioned keys (new photos) already change when the photo changes: no extra parameter, so the link
      // stays the same across stock movements and the cached copy keeps working (also offline).
      if (/\/[0-9a-z]+-(full|thumb)$/.test(key)) return base;
      return timestamp ? `${base}?t=${encodeURIComponent(timestamp)}` : base;
    },
  },

  // Visual Search (AI Jewelry Scanner)
  visualSearch: {
    search: (base64Image: string, category?: ScanCategory | null) =>
      request<VisualSearchResponse>('/api/visual-search/search', {
        method: 'POST',
        body: JSON.stringify(category ? { image: base64Image, category } : { image: base64Image }),
      }),
    descriptor: (id: string) =>
      request<VisualSearchDescriptor>(`/api/visual-search/descriptor/${encodeURIComponent(id)}`),
    /** Stored vector + attributes of one item, scored against the current query (re-ranked score). */
    descriptorScored: (id: string, vector: number[], attributes: JewelryAttributes | null, categoryFilter: ScanCategory | null) =>
      request<VisualSearchDescriptor>(`/api/visual-search/descriptor/${encodeURIComponent(id)}`, {
        method: 'POST',
        body: JSON.stringify({ vector, attributes, category_filter: categoryFilter }),
      }),
    reindexReset: () =>
      request<{ success: boolean; reset: number; prompt_version: string }>('/api/visual-search/reindex-reset', {
        method: 'POST',
      }),
    embedItem: (id: string) =>
      request<{ success: boolean; item_id: string; embedded_at: string }>(`/api/visual-search/embed/${id}`, {
        method: 'POST',
      }),
    deleteItemEmbedding: (id: string) =>
      request<{ success: boolean; deleted: string }>(`/api/visual-search/embed/${id}`, {
        method: 'DELETE',
      }),
    backfill: () =>
      request<VisualSearchBackfillResponse>('/api/visual-search/backfill', {
        method: 'POST',
      }),
    getStatus: () =>
      request<VisualSearchStatusResponse>('/api/visual-search/status'),
  },

  // On-device DINOv2 visual search — separate feature, separate endpoints (no Workers AI)
  // Costing in the cloud (owner only): see lib/costingSync.ts and backend/src/routes/costing.ts
  costing: {
    push: (changes: unknown[]) =>
      request<{ success: boolean; rev: number; applied: { entity: string; id: string }[]; skipped: { entity?: string; id?: string; reason: string; merged_into?: string; current?: any }[] }>(
        '/api/costing/push',
        { method: 'POST', body: JSON.stringify({ changes }) }
      ),
    pull: (since: number) =>
      request<{ changes: any[]; next_since: number; has_more: boolean; latest_rev: number }>(`/api/costing/pull?since=${since}`),
    status: () => request<{ latest_rev: number; categories: number; materials: number; designs: number }>('/api/costing/status'),
  },

  visualSearchDino: {
    status: () => request<DinoStatusResponse>('/api/visual-search-dino/status'),
    pending: () => request<DinoPendingResponse>('/api/visual-search-dino/pending'),
    /**
     * Save fingerprints. `photo_etag` (optional, per item, from the upload response): only save if the item still has exactly that photo.
     * `onlyMissing`: never overwrite an item that is already learned by the current model.
     */
    embed: (
      modelVersion: string,
      items: { id: string; vector: number[]; photo_etag?: string }[],
      options: { onlyMissing?: boolean } = {}
    ) =>
      request<DinoEmbedResponse>('/api/visual-search-dino/embed', {
        method: 'POST',
        body: JSON.stringify({ model_version: modelVersion, items, ...(options.onlyMissing ? { only_missing: true } : {}) }),
      }),
    search: (modelVersion: string, vector: number[], category?: ScanCategory | null) =>
      request<DinoSearchResponse>('/api/visual-search-dino/search', {
        method: 'POST',
        body: JSON.stringify({ model_version: modelVersion, vector, ...(category ? { category } : {}) }),
      }),
    descriptor: (id: string) =>
      request<DinoDescriptor>(`/api/visual-search-dino/descriptor/${encodeURIComponent(id)}`),
    reindexReset: () =>
      request<{ success: boolean; reset: number; model_version: string }>('/api/visual-search-dino/reindex-reset', {
        method: 'POST',
      }),
  },
};
