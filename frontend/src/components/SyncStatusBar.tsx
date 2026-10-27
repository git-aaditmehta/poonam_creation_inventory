import React, { useState, useEffect, useCallback } from 'react';
import { Cloud, CheckCircle2, AlertCircle, RefreshCw, Copy, Check, X, WifiOff } from 'lucide-react';
import { createDiagnosticReport } from '../utils/friendlyErrors';
import type { FriendlyError } from '../utils/friendlyErrors';

export interface SyncStatusPayload {
  state: 'idle' | 'syncing' | 'synced' | 'offline' | 'error';
  title?: string;
  message?: string;
  solution?: string;
  itemId?: string;
  category?: string;
  error?: FriendlyError;
  duration?: number; // auto-dismiss ms
}

let notifyStatusListener: ((payload: SyncStatusPayload) => void) | null = null;

/** Helper function to dispatch sync status updates from anywhere in the app */
export function emitSyncStatus(payload: SyncStatusPayload) {
  if (notifyStatusListener) {
    notifyStatusListener(payload);
  }
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('sync-status-update', { detail: payload }));
  }
}

export const SyncStatusBar: React.FC = () => {
  const [status, setStatus] = useState<SyncStatusPayload>({ state: 'idle' });
  const [copied, setCopied] = useState(false);
  const [isDismissed, setIsDismissed] = useState(false);

  const handleUpdate = useCallback((payload: SyncStatusPayload) => {
    setStatus(payload);
    setIsDismissed(false);
    setCopied(false);

    if (payload.state === 'synced') {
      const duration = payload.duration || 3500;
      setTimeout(() => {
        setStatus((prev) => (prev.state === 'synced' ? { state: 'idle' } : prev));
      }, duration);
    }
  }, []);

  useEffect(() => {
    notifyStatusListener = handleUpdate;

    const handleCustomEvent = (e: Event) => {
      const customEvent = e as CustomEvent<SyncStatusPayload>;
      if (customEvent.detail) {
        handleUpdate(customEvent.detail);
      }
    };

    const handleOnline = () => {
      handleUpdate({
        state: 'synced',
        title: 'Connection Restored',
        message: 'Internet connection is back online. Syncing active.',
        duration: 3000,
      });
    };

    const handleOffline = () => {
      handleUpdate({
        state: 'offline',
        title: 'Offline Mode Active',
        message: 'No internet connection. All changes are saved safely on this device.',
        solution: 'Once you are reconnected to Wi-Fi/Internet, cloud backup will resume automatically.',
      });
    };

    window.addEventListener('sync-status-update', handleCustomEvent);
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    return () => {
      notifyStatusListener = null;
      window.removeEventListener('sync-status-update', handleCustomEvent);
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, [handleUpdate]);

  const handleCopyReport = () => {
    if (!status.error) return;
    const report = createDiagnosticReport(status.error, {
      action: 'Inventory Operation',
      category: status.category,
      itemId: status.itemId,
    });
    navigator.clipboard.writeText(report);
    setCopied(true);
    setTimeout(() => setCopied(false), 3000);
  };

  const handleManualSyncNow = () => {
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('trigger-manual-sync'));
    }
    handleUpdate({
      state: 'syncing',
      message: 'Checking and uploading pending records to cloud...',
    });
  };

  if (isDismissed || status.state === 'idle') {
    return null;
  }

  // Visual Themes by State
  const stateStyles = {
    syncing: {
      bg: 'rgba(212, 163, 89, 0.12)',
      border: '1px solid rgba(212, 163, 89, 0.35)',
      text: '#e6c88b',
      icon: <RefreshCw size={15} className="animate-spin" style={{ color: '#d4a359' }} />,
    },
    synced: {
      bg: 'rgba(46, 204, 113, 0.12)',
      border: '1px solid rgba(46, 204, 113, 0.35)',
      text: '#82e0aa',
      icon: <CheckCircle2 size={15} style={{ color: '#2ecc71' }} />,
    },
    offline: {
      bg: 'rgba(243, 156, 18, 0.12)',
      border: '1px solid rgba(243, 156, 18, 0.35)',
      text: '#f8c471',
      icon: <WifiOff size={15} style={{ color: '#f39c12' }} />,
    },
    error: {
      bg: 'rgba(231, 76, 60, 0.12)',
      border: '1px solid rgba(231, 76, 60, 0.4)',
      text: '#f1948a',
      icon: <AlertCircle size={15} style={{ color: '#e74c3c' }} />,
    },
  }[status.state] || {
    bg: 'rgba(255, 255, 255, 0.05)',
    border: '1px solid rgba(255, 255, 255, 0.1)',
    text: '#ffffff',
    icon: <Cloud size={15} />,
  };

  return (
    <div
      style={{
        width: '100%',
        maxWidth: '1400px',
        margin: '0 auto',
        padding: '0 24px',
        boxSizing: 'border-box',
        transition: 'all 0.3s ease',
      }}
    >
      <div
        style={{
          marginTop: '8px',
          marginBottom: '8px',
          padding: '10px 16px',
          borderRadius: '8px',
          backgroundColor: stateStyles.bg,
          border: stateStyles.border,
          color: stateStyles.text,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
          gap: '12px',
          fontSize: '13px',
          backdropFilter: 'blur(8px)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flex: '1 1 300px' }}>
          {stateStyles.icon}
          <div>
            <span style={{ fontWeight: 600 }}>
              {status.title || (status.state === 'syncing' ? 'Syncing with Cloud' : status.state === 'synced' ? 'Cloud Backup Complete' : 'Notice')}
              {status.itemId ? ` (${status.itemId})` : ''}:
            </span>{' '}
            <span style={{ opacity: 0.95 }}>{status.message}</span>
            {status.solution && (
              <div style={{ fontSize: '12px', opacity: 0.85, marginTop: '2px', fontWeight: 400 }}>
                💡 <strong>Suggested action:</strong> {status.solution}
              </div>
            )}
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0 }}>
          {status.state === 'offline' && (
            <button
              onClick={handleManualSyncNow}
              style={{
                backgroundColor: 'rgba(243, 156, 18, 0.25)',
                border: '1px solid rgba(243, 156, 18, 0.5)',
                color: '#fff',
                borderRadius: '6px',
                padding: '4px 10px',
                fontSize: '12px',
                cursor: 'pointer',
                fontWeight: 600,
              }}
            >
              Sync Now
            </button>
          )}

          {status.error?.isCritical && (
            <button
              onClick={handleCopyReport}
              style={{
                backgroundColor: copied ? 'rgba(46, 204, 113, 0.3)' : 'rgba(231, 76, 60, 0.25)',
                border: copied ? '1px solid rgba(46, 204, 113, 0.6)' : '1px solid rgba(231, 76, 60, 0.5)',
                color: '#fff',
                borderRadius: '6px',
                padding: '4px 10px',
                fontSize: '12px',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: '5px',
                fontWeight: 600,
              }}
              title="Copy detailed technical error log for your developer"
            >
              {copied ? <Check size={13} /> : <Copy size={13} />}
              {copied ? 'Copied Details!' : '📋 Copy Report for Developer'}
            </button>
          )}

          <button
            onClick={() => setIsDismissed(true)}
            style={{
              background: 'none',
              border: 'none',
              color: stateStyles.text,
              opacity: 0.6,
              cursor: 'pointer',
              padding: '2px',
              display: 'flex',
              alignItems: 'center',
            }}
            title="Dismiss"
          >
            <X size={15} />
          </button>
        </div>
      </div>
    </div>
  );
};
