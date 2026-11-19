/**
 * syncEngine.ts
 * 
 * Background synchronization engine.
 * Handles: bootstrap (first load), push (local→cloud), pull (cloud→local).
 * 
 * Sync is non-blocking — the UI always reads from local SQLite.
 */

import { localDb } from './localDb';
import {
  getNextPendingBatch,
  updatePendingOpStatus,
  removePendingOp,
} from './pendingOps';

// ── Types ──────────────────────────────────────────────────────

export interface SyncStatus {
  isOnline: boolean;
  isSyncing: boolean;
  lastSyncedAt: string | null;
  pendingCount: number;
  failedCount: number;
  bootstrapComplete: boolean;
  error: string | null;
}

export type SyncStatusListener = (status: SyncStatus) => void;

// ── API helpers ────────────────────────────────────────────────

// In production on Vercel, route through the same-origin Vercel Mumbai proxy (/api)
const API_BASE_URL = (
  typeof window !== 'undefined' && window.location.hostname.includes('vercel.app')
    ? ''
    : (import.meta.env.VITE_API_URL || '')
).replace(/\/+$/, '');

function getAuthHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
  };
  const token = sessionStorage.getItem('session_token') || localStorage.getItem('session_token');
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  return headers;
}

async function apiRequest(endpoint: string, method: string, body?: any): Promise<any> {
  const url = endpoint.startsWith('http') ? endpoint : `${API_BASE_URL}${endpoint}`;
  const res = await fetch(url, {
    method,
    headers: getAuthHeaders(),
    credentials: 'include',
    body: body ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
  });
  if (!res.ok) {
    // The server says this login is no longer valid: let the app sign out (unsent changes are kept)
    if (res.status === 401) {
      try {
        sessionStorage.removeItem('session_token');
        localStorage.removeItem('session_token');
      } catch {
        /* ignore */
      }
      window.dispatchEvent(new CustomEvent('auth-unauthorized'));
    }
    const text = await res.text();
    let parsed: any;
    try { parsed = JSON.parse(text); } catch { parsed = { error: text }; }
    const err = new Error(parsed.error || parsed.message || res.statusText);
    (err as any).status = res.status;
    (err as any).data = parsed;
    throw err;
  }
  return res.json();
}

// ── Stock operation reconciliation ─────────────────────────────
// Stock in/out is applied on the phone instantly and sent in the background (online and offline alike).
// The server's answer is then made authoritative on the phone.

const STOCK_ENDPOINT = '/api/stock/operate';
const CATEGORY_PATH: Record<string, string> = {
  plated_jewelry: 'plated-jewelry',
  raw_jewelry: 'raw-jewelry',
  stones: 'stones',
  foil: 'foil',
};

/** Accepted: adopt the server's balance and history id (no duplicate history entry on this phone). */
async function reconcileAcceptedStockOp(payload: any, result: any): Promise<void> {
  try {
    if (!payload?.category || !CATEGORY_PATH[payload.category]) return;
    if (typeof result?.new_balance === 'number' && !result.duplicate) {
      await localDb.exec(`UPDATE ${payload.category} SET quantity = ? WHERE id = ?`, [result.new_balance, payload.item_id]);
    }
    if (result?.transaction_id && payload.idempotency_key) {
      // The server's history row (arriving via pull) has the server id; give the temporary row that id so
      // the pull replaces it instead of adding a second copy
      await localDb.exec(
        'DELETE FROM transactions WHERE id = ? AND idempotency_key != ?',
        [result.transaction_id, payload.idempotency_key]
      );
      await localDb.exec('UPDATE transactions SET id = ? WHERE idempotency_key = ?', [result.transaction_id, payload.idempotency_key]);
    }
  } catch (e) {
    console.warn('[Sync] Could not reconcile accepted stock op:', e);
  }
}

/** Refused (e.g. someone else sold it first): undo it on this phone and tell the user. */
async function revertRejectedStockOp(payload: any, message: string): Promise<void> {
  try {
    if (!payload?.category || !CATEGORY_PATH[payload.category]) return;
    if (payload.idempotency_key) {
      await localDb.exec('DELETE FROM transactions WHERE idempotency_key = ?', [payload.idempotency_key]);
    }
    try {
      const fresh = await apiRequest(`/api/inventory/${CATEGORY_PATH[payload.category]}/${encodeURIComponent(payload.item_id)}`, 'GET');
      if (fresh?.item && typeof fresh.item.quantity === 'number') {
        await localDb.exec(`UPDATE ${payload.category} SET quantity = ? WHERE id = ?`, [fresh.item.quantity, payload.item_id]);
      }
    } catch (e: any) {
      if (e?.status === 404) await localDb.exec(`DELETE FROM ${payload.category} WHERE id = ?`, [payload.item_id]);
    }
  } catch (e) {
    console.warn('[Sync] Could not revert rejected stock op:', e);
  }
  window.dispatchEvent(new CustomEvent('localdb-change', { detail: { store: payload?.category || 'all' } }));
  window.dispatchEvent(
    new CustomEvent('stock-op-rejected', {
      detail: { itemId: payload?.display_item_id || payload?.item_id, operation: payload?.operation, quantity: payload?.quantity, message },
    })
  );
}

// ── Sync Engine Class ──────────────────────────────────────────

class SyncEngine {
  private _status: SyncStatus = {
    isOnline: typeof navigator !== 'undefined' ? navigator.onLine : true,
    isSyncing: false,
    lastSyncedAt: null,
    pendingCount: 0,
    failedCount: 0,
    bootstrapComplete: false,
    error: null,
  };

  private _listeners = new Set<SyncStatusListener>();
  private _syncLock = false;
  private _syncTimer: ReturnType<typeof setInterval> | null = null;
  private _debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private _started = false;
  private _rerunRequested = false;

  /** Subscribe to status changes. Returns unsubscribe function. */
  subscribe(listener: SyncStatusListener): () => void {
    this._listeners.add(listener);
    listener(this._status);
    return () => this._listeners.delete(listener);
  }

  /** Get current status snapshot. */
  get status(): SyncStatus {
    return { ...this._status };
  }

  private _notify(): void {
    for (const listener of this._listeners) {
      try { listener({ ...this._status }); } catch { /* ignore */ }
    }
  }

  private _updateStatus(partial: Partial<SyncStatus>): void {
    Object.assign(this._status, partial);
    this._notify();
  }

  // ── Lifecycle ────────────────────────────────────────────────

  /** Start the sync engine. Call after login + localDb.ready. */
  async start(): Promise<void> {
    if (this._started) return;
    this._started = true;

    // Setup online/offline listeners
    window.addEventListener('online', this._onOnline);
    window.addEventListener('offline', this._onOffline);
    window.addEventListener('pending-ops-changed', this._onPendingChanged);
    document.addEventListener('visibilitychange', this._onVisibilityChange);

    this._updateStatus({ isOnline: navigator.onLine });

    // Check if bootstrap is needed
    const checkpoint = await localDb.getSyncState('checkpoint');
    // The first full download is done once it saved its checkpoint (written only at the END of a successful
    // download; cleared by logout / force re-sync). It used to also require at least one Kundan (stones) item,
    // so a shop with no stones re-downloaded everything on every open, and a phone opened offline never
    // synced again in that session.
    const bootstrapDone = checkpoint !== null;
    this._updateStatus({ bootstrapComplete: bootstrapDone });

    // Self-healing: If local DB already bootstrapped, replay changes from seq 0
    // so any previously failed or partial updates (like image keys seq 21/23) are cleanly applied
    const repairDone = await localDb.getSyncState('sync_repair_v2');
    if (!repairDone && bootstrapDone) {
      await localDb.setSyncState('checkpoint', '0');
      await localDb.setSyncState('sync_repair_v2', 'true');
    }

    if (!bootstrapDone && navigator.onLine) {
      await this.bootstrap();
    } else if (bootstrapDone) {
      // Update pending counts
      await this._refreshPendingCounts();
      // Trigger incremental sync
      if (navigator.onLine) {
        this.triggerSync();
      }
    }

    // Periodic sync every 30 seconds
    this._syncTimer = setInterval(() => {
      if (navigator.onLine && !this._syncLock) {
        this.triggerSync();
      }
    }, 30_000);
  }

  /** Stop the sync engine. Call on logout. */
  stop(): void {
    this._started = false;
    window.removeEventListener('online', this._onOnline);
    window.removeEventListener('offline', this._onOffline);
    window.removeEventListener('pending-ops-changed', this._onPendingChanged);
    document.removeEventListener('visibilitychange', this._onVisibilityChange);

    if (this._syncTimer) {
      clearInterval(this._syncTimer);
      this._syncTimer = null;
    }
    if (this._debounceTimer) {
      clearTimeout(this._debounceTimer);
      this._debounceTimer = null;
    }
  }

  // ── Event Handlers ───────────────────────────────────────────

  private _onOnline = (): void => {
    this._updateStatus({ isOnline: true });
    // Opened offline before the first download ever finished: do it now
    if (!this._status.bootstrapComplete) {
      this.bootstrap();
      return;
    }
    this.triggerSync();
  };

  private _onOffline = (): void => {
    this._updateStatus({ isOnline: false });
  };

  private _onPendingChanged = (): void => {
    this._refreshPendingCounts();
    // Debounce push after mutations
    if (this._debounceTimer) clearTimeout(this._debounceTimer);
    this._debounceTimer = setTimeout(() => {
      if (navigator.onLine) this.triggerSync();
    }, 500);
  };

  private _onVisibilityChange = (): void => {
    if (document.visibilityState === 'visible' && navigator.onLine) {
      this.triggerSync();
    }
  };

  private async _refreshPendingCounts(): Promise<void> {
    try {
      const pending = await localDb.count('pending_ops', "status = 'PENDING' OR status = 'SYNCING'");
      const failed = await localDb.count('pending_ops', "status = 'FAILED'");
      this._updateStatus({ pendingCount: pending, failedCount: failed });
    } catch { /* ignore */ }
  }

  // ── Bootstrap ────────────────────────────────────────────────

  /** Full data download on first load or force re-sync. */
  async bootstrap(): Promise<void> {
    if (this._syncLock) return;
    this._syncLock = true;
    this._updateStatus({ isSyncing: true, error: null });

    try {
      console.log('[Sync] Starting bootstrap...');
      const data = await apiRequest('/api/sync/bootstrap', 'GET');

      // Clear existing local data before bootstrap
      await localDb.clearTable('plated_jewelry');
      await localDb.clearTable('raw_jewelry');
      await localDb.clearTable('stones');
      await localDb.clearTable('foil');
      await localDb.clearTable('transactions');

      // Bulk insert all data
      if (data.plated_jewelry?.length) {
        await localDb.bulkUpsert('plated_jewelry', data.plated_jewelry);
      }
      if (data.raw_jewelry?.length) {
        await localDb.bulkUpsert('raw_jewelry', data.raw_jewelry);
      }
      if (data.stones?.length) {
        await localDb.bulkUpsert('stones', data.stones);
      }
      if (data.foil?.length) {
        await localDb.bulkUpsert('foil', data.foil);
      }
      if (data.transactions?.length) {
        await localDb.bulkUpsert('transactions', data.transactions);
      }

      // Save checkpoint
      const checkpoint = data.latest_seq ?? 0;
      await localDb.setSyncState('checkpoint', String(checkpoint));

      console.log(`[Sync] Bootstrap complete. ${data.plated_jewelry?.length || 0} plated, ${data.raw_jewelry?.length || 0} raw, ${data.stones?.length || 0} stones, ${data.foil?.length || 0} foil, seq=${checkpoint}`);

      this._updateStatus({
        bootstrapComplete: true,
        lastSyncedAt: new Date().toISOString(),
        error: null,
      });

      // Notify views that data is available
      window.dispatchEvent(new CustomEvent('localdb-change', { detail: { store: 'all' } }));
    } catch (err: any) {
      console.error('[Sync] Bootstrap failed:', err);
      if (err?.status === 503 && err?.data?.code === 'daily_limit') {
        window.dispatchEvent(new CustomEvent('cloud-daily-limit', { detail: err.data }));
      }
      this._updateStatus({ error: `Bootstrap failed: ${err.message}` });
    } finally {
      this._syncLock = false;
      this._updateStatus({ isSyncing: false });
    }
    // Unsent offline stock changes (e.g. kept across an expired login) go out right away, not in 30 s
    if (this._status.bootstrapComplete && navigator.onLine) this.triggerSync();
  }

  // ── Trigger Sync ─────────────────────────────────────────────

  /** Trigger a full sync cycle (push then pull). */
  async triggerSync(): Promise<void> {
    if (!navigator.onLine) return;
    if (this._syncLock) {
      // A sync is running: run once more right after it, so a just-made stock change never waits 30 s
      this._rerunRequested = true;
      return;
    }
    if (!this._status.bootstrapComplete) return;
    this._rerunRequested = false;

    this._syncLock = true;
    this._updateStatus({ isSyncing: true, error: null });

    try {
      // 1. Push pending operations
      await this._push();

      // 2. Pull remote changes
      await this._pull();

      this._updateStatus({
        lastSyncedAt: new Date().toISOString(),
        error: null,
      });
    } catch (err: any) {
      console.error('[Sync] Sync cycle error:', err);
      this._updateStatus({ error: err.message });
    } finally {
      this._syncLock = false;
      this._updateStatus({ isSyncing: false });
      await this._refreshPendingCounts();
    }
    if (this._rerunRequested && navigator.onLine) {
      this._rerunRequested = false;
      this.triggerSync();
    }
  }

  // ── Push (Local → Cloud) ─────────────────────────────────────

  private async _push(): Promise<void> {
    const ops = await getNextPendingBatch(20);
    if (ops.length === 0) return;

    console.log(`[Sync] Pushing ${ops.length} pending operations...`);

    for (const op of ops) {
      // For FormData operations (image upload), we handle differently
      let payload: any;
      try { payload = JSON.parse(op.payload); } catch { payload = op.payload; }
      try {
        await updatePendingOpStatus(op.id, 'SYNCING');

        const result = await apiRequest(op.endpoint, op.method, payload);

        // Handle duplicate detection (idempotency)
        if (result.duplicate) {
          console.log(`[Sync] Op ${op.id} was already processed (duplicate)`);
        }
        if (op.endpoint === STOCK_ENDPOINT) await reconcileAcceptedStockOp(payload, result);

        // Mark as done and remove
        await updatePendingOpStatus(op.id, 'DONE');
        // Auto-remove done ops after a short delay
        setTimeout(() => removePendingOp(op.id), 3000);

      } catch (err: any) {
        const isNetworkErr = !navigator.onLine ||
          err.message === 'Failed to fetch' ||
          err.message === 'Load failed' ||
          err.message?.toLowerCase().includes('network') ||
          err.message?.toLowerCase().includes('fetch') ||
          err.status === 0;

        if (isNetworkErr) {
          // Network error — stop pushing, will retry later
          await updatePendingOpStatus(op.id, 'PENDING');
          console.log('[Sync] Network lost during push, will retry later');
          break;
        }

        if (err.status === 503 && err.data?.code === 'daily_limit') {
          // The cloud's free daily limit is used up: keep this change (and the rest) waiting, try after the renewal
          await updatePendingOpStatus(op.id, 'PENDING');
          window.dispatchEvent(new CustomEvent('cloud-daily-limit', { detail: err.data }));
          break;
        }

        if (err.status === 409) {
          // If server reports idempotency / already processed duplicate, op is DONE
          if (err.duplicate || err.message?.toLowerCase().includes('already processed')) {
            console.log(`[Sync] Op ${op.id} was already processed on server`);
            await updatePendingOpStatus(op.id, 'DONE');
            setTimeout(() => removePendingOp(op.id), 3000);
          } else {
            // Concurrency rejection or business rule failure — mark FAILED and pull fresh state
            console.warn(`[Sync] Op ${op.id} conflict:`, err.message);
            await updatePendingOpStatus(op.id, 'FAILED', err.message || 'Conflict: operation rejected by server');
            if (op.endpoint === STOCK_ENDPOINT) await revertRejectedStockOp(payload, err.message || 'Rejected by the server');
            try {
              await this._pull();
            } catch (pullErr) {
              console.warn('[Sync] Pull after conflict failed:', pullErr);
            }
          }
        } else if (err.status === 401) {
          // Auth error — stop pushing
          await updatePendingOpStatus(op.id, 'PENDING');
          break;
        } else {
          // Other error — mark as failed
          await updatePendingOpStatus(op.id, 'FAILED', err.message);
          if (op.endpoint === STOCK_ENDPOINT && err.status >= 400 && err.status < 500) {
            await revertRejectedStockOp(payload, err.message || 'Rejected by the server');
          }
          console.error(`[Sync] Op ${op.id} failed:`, err.message);
        }
      }
    }
  }

  // ── Pull (Cloud → Local) ─────────────────────────────────────

  private async _pull(): Promise<void> {
    let checkpoint = await localDb.getSyncState('checkpoint');
    let afterSeq = parseInt(checkpoint || '0', 10);
    let hasMore = true;

    while (hasMore) {
      try {
        const data = await apiRequest(`/api/sync/changes?after=${afterSeq}&limit=500`, 'GET');
        const changes = data.changes || [];

        if (changes.length === 0) {
          hasMore = false;
          break;
        }

        console.log(`[Sync] Pulling ${changes.length} changes after seq ${afterSeq}...`);

        for (const change of changes) {
          try {
            if (change.operation === 'DELETE') {
              await localDb.exec(`DELETE FROM ${change.entity_type} WHERE id = ?`, [change.entity_id]);
            } else if (change.operation === 'UPDATE') {
              const payload = typeof change.payload === 'string'
                ? JSON.parse(change.payload)
                : change.payload;
              // Try updating the existing row fields in SQLite first (preserves untouched columns like item_id)
              const updated = await localDb.updateFields(change.entity_type, change.entity_id, payload);
              if (!updated && payload.item_id) {
                // If row didn't exist locally yet but has item_id, upsert full row
                await localDb.upsertItem(change.entity_type, payload);
              }
            } else {
              // CREATE — upsert the full record
              const payload = typeof change.payload === 'string'
                ? JSON.parse(change.payload)
                : change.payload;
              if (change.entity_type === 'transactions' && payload?.idempotency_key) {
                // Replace this phone's temporary copy of the same stock operation (no double entry in History)
                await localDb.exec('DELETE FROM transactions WHERE idempotency_key = ? AND id != ?', [payload.idempotency_key, change.entity_id]);
              }
              await localDb.upsertItem(change.entity_type, payload);
            }
          } catch (innerErr: any) {
            console.error(`[Sync] Error applying change seq=${change.seq}:`, innerErr);
          }
        }

        // Advance checkpoint
        const maxSeq = Math.max(...changes.map((c: any) => c.seq));
        afterSeq = maxSeq;
        await localDb.setSyncState('checkpoint', String(maxSeq));

        // If we got fewer than limit, we're done
        hasMore = changes.length >= 500;

      } catch (err: any) {
        const isNetworkErr = !navigator.onLine ||
          err.message === 'Failed to fetch' ||
          err.message === 'Load failed' ||
          err.message?.toLowerCase().includes('network') ||
          err.message?.toLowerCase().includes('fetch') ||
          err.status === 0;

        if (isNetworkErr) {
          console.log('[Sync] Network lost during pull');
        } else if (err.status === 503 && err.data?.code === 'daily_limit') {
          window.dispatchEvent(new CustomEvent('cloud-daily-limit', { detail: err.data }));
        } else {
          console.error('[Sync] Pull error:', err);
        }
        hasMore = false;
      }
    }

    // Notify views that data may have changed
    window.dispatchEvent(new CustomEvent('localdb-change', { detail: { store: 'all' } }));
  }

  /**
   * Force re-sync — re-downloads all data. Unsent changes are KEPT and sent right after the download
   * (bootstrap pushes the queue when it finishes). Nothing waiting on this phone is ever lost.
   */
  async forceResync(): Promise<void> {
    await localDb.clearAll({ keepPendingOps: true });
    this._updateStatus({ bootstrapComplete: false });
    if (navigator.onLine) {
      await this.bootstrap();
    }
  }
}

// Singleton export
export const syncEngine = new SyncEngine();
