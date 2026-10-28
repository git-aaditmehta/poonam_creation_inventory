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

const API_BASE_URL = (import.meta.env.VITE_API_URL || '').replace(/\/+$/, '');

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
    let totalLocalItems = 0;
    let sCount = 0;
    try {
      const [s, p, r, f] = await Promise.all([
        localDb.count('stones'),
        localDb.count('plated_jewelry'),
        localDb.count('raw_jewelry'),
        localDb.count('foil'),
      ]);
      sCount = s;
      totalLocalItems = s + p + r + f;
    } catch {
      totalLocalItems = 0;
    }

    // Bootstrap is complete only if checkpoint exists AND local inventory tables contain data (including stones)
    const bootstrapDone = checkpoint !== null && totalLocalItems > 0 && sCount > 0;
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
      this._updateStatus({ error: `Bootstrap failed: ${err.message}` });
    } finally {
      this._syncLock = false;
      this._updateStatus({ isSyncing: false });
    }
  }

  // ── Trigger Sync ─────────────────────────────────────────────

  /** Trigger a full sync cycle (push then pull). */
  async triggerSync(): Promise<void> {
    if (this._syncLock || !navigator.onLine) return;
    if (!this._status.bootstrapComplete) return;

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
  }

  // ── Push (Local → Cloud) ─────────────────────────────────────

  private async _push(): Promise<void> {
    const ops = await getNextPendingBatch(20);
    if (ops.length === 0) return;

    console.log(`[Sync] Pushing ${ops.length} pending operations...`);

    for (const op of ops) {
      try {
        await updatePendingOpStatus(op.id, 'SYNCING');

        // For FormData operations (image upload), we handle differently
        let payload: any;
        try { payload = JSON.parse(op.payload); } catch { payload = op.payload; }

        const result = await apiRequest(op.endpoint, op.method, payload);

        // Handle duplicate detection (idempotency)
        if (result.duplicate) {
          console.log(`[Sync] Op ${op.id} was already processed (duplicate)`);
        }

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
        } else {
          console.error('[Sync] Pull error:', err);
        }
        hasMore = false;
      }
    }

    // Notify views that data may have changed
    window.dispatchEvent(new CustomEvent('localdb-change', { detail: { store: 'all' } }));
  }

  /** Force re-sync — clears local data and re-bootstraps. */
  async forceResync(): Promise<void> {
    await localDb.clearAll();
    this._updateStatus({ bootstrapComplete: false });
    if (navigator.onLine) {
      await this.bootstrap();
    }
  }
}

// Singleton export
export const syncEngine = new SyncEngine();
