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

async function request<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
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

  const response = await fetch(endpoint, {
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
    listPlated: (params: { page?: number; limit?: number; search?: string } = {}) => {
      const q = new URLSearchParams();
      if (params.page) q.set('page', params.page.toString());
      if (params.limit) q.set('limit', params.limit.toString());
      if (params.search) q.set('search', params.search);
      return request<InventoryListResponse<PlatedJewelryItem>>(`/api/inventory/plated-jewelry?${q.toString()}`);
    },
    listRaw: (params: { page?: number; limit?: number; search?: string } = {}) => {
      const q = new URLSearchParams();
      if (params.page) q.set('page', params.page.toString());
      if (params.limit) q.set('limit', params.limit.toString());
      if (params.search) q.set('search', params.search);
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
      request<{ success: boolean; id: string; item_id: string }>(`/api/inventory/${category}`, {
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
      request<{ success: boolean; image_key: string; thumb_key: string }>('/api/images/upload', {
        method: 'POST',
        body: formData,
      }),
    getUrl: (key: string) => `/api/images/${key}`,
  },
};
