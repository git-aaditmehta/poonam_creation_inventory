import React, { useEffect, useState } from 'react';
import { CloudOff, CloudUpload, CheckCircle2, AlertTriangle, Download, Loader2 } from 'lucide-react';
import { subscribeCostingSync, startFreshInCloud, syncCostingNow, type CostingSyncState } from '../lib/costingSync';
import { getAllJewelryCostings, getCostingCategories, getCostingMaterialsByCategory, getCostingMultiplierX, type CostingMaterial } from '../lib/costingDb';
import { exportJewelryCostingWorkbook, exportRawMaterialsWorkbook } from '../lib/costingExcel';
import { useToast } from '../context/ToastContext';
import { errorText } from '../utils/friendlyErrors';
import { formatIST } from '../utils/time';

/**
 * Wraps both Costing screens.
 * - One time per device (agreed: start fresh in the cloud): if this device still has Costing data from before the
 *   cloud version, offer an Excel backup, then clear it. Until then Costing does not sync on this device.
 * - Otherwise: a status line (saved to cloud / waiting / offline / problem) above the screen.
 */
export const CostingCloudGate: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { showToast } = useToast();
  const [s, setS] = useState<CostingSyncState | null>(null);
  const [busy, setBusy] = useState<'backup' | 'clear' | null>(null);
  const [online, setOnline] = useState(navigator.onLine);
  useEffect(() => subscribeCostingSync(setS), []);
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);

  const downloadBackup = async () => {
    setBusy('backup');
    try {
      const [records, categories, x] = await Promise.all([getAllJewelryCostings(), getCostingCategories(), getCostingMultiplierX()]);
      const materialsByCat: Record<string, CostingMaterial[]> = {};
      for (const c of categories) materialsByCat[c.id] = await getCostingMaterialsByCategory(c.id);
      exportJewelryCostingWorkbook(records, categories, x);
      exportRawMaterialsWorkbook(categories, materialsByCat);
      showToast('success', 'Backup downloaded', 'Two Excel files: jewelry costing and raw materials.');
    } catch (err) {
      showToast('error', 'Backup failed', errorText(err));
    } finally {
      setBusy(null);
    }
  };

  const clearAndStart = async () => {
    if (!window.confirm('Clear the Costing data on this device and start fresh in the cloud? This cannot be undone (download the backup first if you need it).')) return;
    setBusy('clear');
    try {
      await startFreshInCloud();
      showToast('success', 'Costing now saves to the cloud', 'This device starts fresh. Everything you enter is saved on this device and in the cloud.');
    } catch (err) {
      showToast('error', 'Could not clear', errorText(err));
    } finally {
      setBusy(null);
    }
  };

  if (s?.needsFreshStart) {
    return (
      <div className="view-container">
        <div className="card" style={{ maxWidth: 640, margin: '24px auto', display: 'flex', flexDirection: 'column', gap: 14 }}>
          <h2 style={{ fontSize: 20, fontWeight: 700 }}>Costing now saves to the cloud</h2>
          <p style={{ fontSize: 14, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
            From now on Costing is saved on this device <strong>and</strong> in the cloud, so it is safe if this phone is lost
            or its browser data is cleared, and it appears on your other devices too. As agreed, the cloud starts fresh:
            the Costing data that is on this device now will be cleared.
          </p>
          <p style={{ fontSize: 14, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
            If you want to keep a copy, download the Excel backup first. You can import it again later with the Excel restore.
          </p>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <button className="btn btn-secondary" onClick={downloadBackup} disabled={busy !== null}>
              {busy === 'backup' ? <Loader2 size={15} className="animate-spin" /> : <Download size={15} />} Download Excel backup
            </button>
            <button className="btn btn-primary" onClick={clearAndStart} disabled={busy !== null}>
              {busy === 'clear' ? <Loader2 size={15} className="animate-spin" /> : null} Clear and start fresh
            </button>
          </div>
        </div>
      </div>
    );
  }

  let icon = <CheckCircle2 size={14} />;
  let text = 'Saved on this device and in the cloud';
  let color = 'var(--emerald-text)';
  if (!s?.active) {
    text = 'Saved on this device';
    color = 'var(--text-muted)';
  } else if (s.error) {
    icon = <AlertTriangle size={14} />;
    text = `${s.waiting > 0 ? `${s.waiting} change(s) saved on this device, not yet in the cloud. ` : ''}${s.error}`;
    color = 'var(--amber-text)';
  } else if (!online) {
    icon = <CloudOff size={14} />;
    text = s.waiting > 0
      ? `Offline — ${s.waiting} change(s) saved on this device; they upload automatically when you are back online`
      : 'Offline — Costing works as usual; changes upload automatically when you are back online';
    color = 'var(--amber-text)';
  } else if (s.waiting > 0 || s.syncing) {
    icon = <CloudUpload size={14} />;
    text = s.waiting > 0 ? `Saving ${s.waiting} change(s) to the cloud…` : 'Checking the cloud for changes…';
    color = 'var(--text-secondary)';
  } else if (s.lastSyncedAt) {
    text = `Saved on this device and in the cloud · checked ${formatIST(s.lastSyncedAt)}`;
  }

  return (
    <>
      <div
        role="status"
        style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color, padding: '8px 16px 0', maxWidth: 1400, margin: '0 auto' }}
      >
        {icon}
        <span>{text}</span>
        {s?.active && s.error && online && (
          <button className="btn btn-secondary" style={{ fontSize: 11, padding: '2px 8px', marginLeft: 6 }} onClick={() => syncCostingNow()}>
            Try again
          </button>
        )}
      </div>
      {children}
    </>
  );
};
