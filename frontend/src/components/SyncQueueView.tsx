import React, { useState, useEffect, useCallback } from 'react';
import {
  RefreshCw,
  Clock,
  AlertCircle,
  CheckCircle2,
  Loader2,
  Trash2,
  RotateCcw,
  Wifi,
  WifiOff,
  HardDrive,
} from 'lucide-react';
import { getAllPendingOps, retryPendingOp, removePendingOp, type PendingOp } from '../lib/pendingOps';
import { syncEngine, type SyncStatus } from '../lib/syncEngine';
import { getStorageEstimate } from '../lib/imageCache';
import { useToast } from '../context/ToastContext';

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  if (diff < 60000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return `${Math.floor(diff / 86400000)}d ago`;
}

export const SyncQueueView: React.FC = () => {
  const { showToast } = useToast();
  const [ops, setOps] = useState<PendingOp[]>([]);
  const [syncStatus, setSyncStatus] = useState<SyncStatus>(syncEngine.status);
  const [storage, setStorage] = useState({ used: 0, quota: 0 });
  const [isLoading, setIsLoading] = useState(true);

  const refreshOps = useCallback(async () => {
    try {
      const pendingOps = await getAllPendingOps();
      setOps(pendingOps);
    } catch (err) {
      console.error('[SyncQueue] Failed to load ops:', err);
    }
    setIsLoading(false);
  }, []);

  const refreshStorage = useCallback(async () => {
    try {
      const est = await getStorageEstimate();
      setStorage(est);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    refreshOps();
    refreshStorage();

    const handler = () => refreshOps();
    window.addEventListener('pending-ops-changed', handler);
    const unsub = syncEngine.subscribe(setSyncStatus);

    return () => {
      window.removeEventListener('pending-ops-changed', handler);
      unsub();
    };
  }, [refreshOps, refreshStorage]);

  const handleRetry = async (id: string) => {
    await retryPendingOp(id);
    syncEngine.triggerSync();
    showToast('info', 'Retrying', 'Operation re-queued for sync');
  };

  const handleDiscard = async (id: string) => {
    await removePendingOp(id);
    showToast('info', 'Discarded', 'Operation removed from queue');
  };

  const handleForceSync = () => {
    if (!navigator.onLine) {
      showToast('warning', 'Offline Mode', 'Device is currently offline. Connect to internet to sync.');
      return;
    }
    syncEngine.triggerSync();
    showToast('info', 'Sync Triggered', 'Syncing operations with cloud...');
  };

  const handleForceResync = async () => {
    if (!confirm('This will clear all local data and re-download from cloud. Continue?')) return;
    await syncEngine.forceResync();
    showToast('info', 'Re-syncing', 'Full data re-download started...');
  };

  const statusIcon = (status: string) => {
    switch (status) {
      case 'PENDING': return <Clock size={16} style={{ color: 'var(--amber-500, #f59e0b)' }} />;
      case 'SYNCING': return <Loader2 size={16} className="animate-spin" style={{ color: 'var(--teal-deep)' }} />;
      case 'FAILED': return <AlertCircle size={16} style={{ color: 'var(--red-500, #ef4444)' }} />;
      case 'DONE': return <CheckCircle2 size={16} style={{ color: 'var(--green-500, #22c55e)' }} />;
      default: return null;
    }
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'PENDING': return '#f59e0b';
      case 'SYNCING': return 'var(--teal-deep, #0d9488)';
      case 'DONE': return '#22c55e';
      case 'FAILED': return '#ef4444';
      default: return 'var(--text-secondary)';
    }
  };

  const parsePayloadDetail = (payload: string) => {
    try {
      const p = typeof payload === 'string' ? JSON.parse(payload) : payload;
      if (p.operation && p.quantity && p.display_item_id) {
        return `${p.operation === 'add' ? '+' : '-'}${p.quantity} ${p.unit || ''} • Item ${p.display_item_id}`;
      }
      if (p.item_id) {
        return `Item ID: ${p.item_id}`;
      }
    } catch { /* ignore */ }
    return null;
  };

  const pendingCount = ops.filter(o => o.status === 'PENDING' || o.status === 'SYNCING').length;
  const failedCount = ops.filter(o => o.status === 'FAILED').length;

  return (
    <div style={{ padding: 24, maxWidth: 900, margin: '0 auto' }}>
      {/* Sync Status Header */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 16, marginBottom: 24,
        padding: 20, borderRadius: 12,
        background: 'var(--bg-card)', border: '1px solid var(--border-subtle)',
      }}>
        <div style={{
          width: 42, height: 42, borderRadius: 10, display: 'flex',
          alignItems: 'center', justifyContent: 'center',
          background: syncStatus.isOnline ? 'rgba(16,185,129,0.12)' : 'rgba(239,68,68,0.12)',
        }}>
          {syncStatus.isOnline
            ? <Wifi size={22} style={{ color: '#10b981' }} />
            : <WifiOff size={22} style={{ color: '#ef4444' }} />
          }
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 600, fontSize: 15, color: 'var(--text-primary)' }}>
            {syncStatus.isOnline ? 'Online' : 'Offline'}{' '}
            {syncStatus.isSyncing && <span style={{ color: 'var(--teal-deep)', fontWeight: 400 }}>— Syncing...</span>}
          </div>
          <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 2 }}>
            {syncStatus.lastSyncedAt
              ? `Last synced: ${timeAgo(syncStatus.lastSyncedAt)}`
              : 'Not yet synced'
            }
            {syncStatus.error && <span style={{ color: '#ef4444', marginLeft: 8 }}>• {syncStatus.error}</span>}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            onClick={handleForceSync}
            disabled={syncStatus.isSyncing || !syncStatus.isOnline}
            style={{
              padding: '8px 14px', borderRadius: 8, border: '1px solid var(--border-subtle)',
              background: 'var(--bg-base)', cursor: 'pointer', fontSize: 13,
              color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: 6,
              opacity: (syncStatus.isSyncing || !syncStatus.isOnline) ? 0.5 : 1,
            }}
          >
            <RefreshCw size={14} /> Sync Now
          </button>
          <button
            onClick={handleForceResync}
            style={{
              padding: '8px 14px', borderRadius: 8, border: '1px solid var(--border-subtle)',
              background: 'var(--bg-base)', cursor: 'pointer', fontSize: 13,
              color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: 6,
            }}
          >
            <RotateCcw size={14} /> Full Re-sync
          </button>
        </div>
      </div>

      {/* Storage Info */}
      <div style={{
        display: 'flex', gap: 16, marginBottom: 24,
        padding: 16, borderRadius: 12,
        background: 'var(--bg-card)', border: '1px solid var(--border-subtle)',
      }}>
        <HardDrive size={20} style={{ color: 'var(--text-secondary)', marginTop: 2 }} />
        <div>
          <div style={{ fontWeight: 600, fontSize: 14, color: 'var(--text-primary)' }}>Local Storage</div>
          <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 2 }}>
            {formatBytes(storage.used)} used{storage.quota > 0 ? ` / ${formatBytes(storage.quota)} available` : ''}
          </div>
          {storage.quota > 0 && (
            <div style={{
              marginTop: 8, height: 6, borderRadius: 3, background: 'var(--bg-hover)',
              overflow: 'hidden', width: 300, maxWidth: '100%',
            }}>
              <div style={{
                height: '100%', borderRadius: 3,
                background: 'var(--teal-deep)',
                width: `${Math.min(100, (storage.used / storage.quota) * 100)}%`,
                transition: 'width 0.3s ease',
              }} />
            </div>
          )}
        </div>
      </div>

      {/* Pending Operations Queue */}
      <div style={{
        borderRadius: 12, overflow: 'hidden',
        border: '1px solid var(--border-subtle)', background: 'var(--bg-card)',
      }}>
        <div style={{
          padding: '14px 20px', borderBottom: '1px solid var(--border-subtle)',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        }}>
          <div style={{ fontWeight: 600, fontSize: 15, color: 'var(--text-primary)' }}>
            Sync Queue
            {pendingCount > 0 && (
              <span style={{
                marginLeft: 8, padding: '2px 8px', borderRadius: 10,
                fontSize: 12, fontWeight: 600,
                background: 'rgba(245, 158, 11, 0.15)', color: '#f59e0b',
              }}>
                {pendingCount} pending
              </span>
            )}
            {failedCount > 0 && (
              <span style={{
                marginLeft: 6, padding: '2px 8px', borderRadius: 10,
                fontSize: 12, fontWeight: 600,
                background: 'rgba(239, 68, 68, 0.15)', color: '#ef4444',
              }}>
                {failedCount} failed
              </span>
            )}
          </div>
        </div>

        {isLoading ? (
          <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-secondary)' }}>
            <Loader2 size={24} className="animate-spin" style={{ margin: '0 auto' }} />
          </div>
        ) : ops.length === 0 ? (
          <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-secondary)', fontSize: 14 }}>
            <CheckCircle2 size={32} style={{ margin: '0 auto 12px', color: '#10b981' }} />
            All operations synced. Queue is empty.
          </div>
        ) : (
          <div>
            {ops.map((op) => {
              const detail = parsePayloadDetail(op.payload);
              return (
                <div key={op.id} style={{
                  padding: '14px 20px',
                  borderBottom: '1px solid var(--border-subtle)',
                  display: 'flex', alignItems: 'center', gap: 14,
                }}>
                  {statusIcon(op.status)}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                      <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>
                        {op.operation}
                      </span>
                      <span style={{
                        fontSize: 11, padding: '1px 6px', borderRadius: 4,
                        background: 'var(--bg-surface-2, rgba(255,255,255,0.06))',
                        color: 'var(--text-secondary)',
                        textTransform: 'capitalize',
                      }}>
                        {op.entity_type.replace(/_/g, ' ')}
                      </span>
                      {detail && (
                        <span style={{ fontSize: 12, color: 'var(--gold-primary)', fontWeight: 500 }} className="mono">
                          ({detail})
                        </span>
                      )}
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 3 }}>
                      <span style={{ color: getStatusColor(op.status), fontWeight: 600 }}>{op.status}</span>
                      {' • '}
                      {timeAgo(op.created_at)}
                      {op.error_message && (
                        <span style={{ color: '#ef4444', marginLeft: 8 }}>— {op.error_message}</span>
                      )}
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                  {op.status === 'FAILED' && (
                    <button
                      onClick={() => handleRetry(op.id)}
                      style={{
                        padding: '4px 10px', borderRadius: 6, border: '1px solid var(--border-subtle)',
                        background: 'var(--bg-base)', cursor: 'pointer', fontSize: 12,
                        color: 'var(--teal-deep)', display: 'flex', alignItems: 'center', gap: 4,
                      }}
                    >
                      <RotateCcw size={12} /> Retry
                    </button>
                  )}
                  {(op.status === 'FAILED' || op.status === 'PENDING') && (
                    <button
                      onClick={() => handleDiscard(op.id)}
                      style={{
                        padding: '4px 10px', borderRadius: 6, border: '1px solid var(--border-subtle)',
                        background: 'var(--bg-base)', cursor: 'pointer', fontSize: 12,
                        color: '#ef4444', display: 'flex', alignItems: 'center', gap: 4,
                      }}
                    >
                      <Trash2 size={12} /> Discard
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
        )}
      </div>
    </div>
  );
};
