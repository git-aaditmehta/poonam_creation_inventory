import React, { useState, useEffect } from 'react';
import {
  Database,
  Download,
  HardDrive,
  CheckCircle2,
  Loader2,
  FileSpreadsheet,
  ShieldAlert,
} from 'lucide-react';
import * as XLSX from 'xlsx';
import { api } from '../api';
import type { StorageUsageResponse, PrepareDeleteResponse } from '../types';
import { useToast } from '../context/ToastContext';

export const BackupView: React.FC = () => {
  const { showToast } = useToast();

  const [usage, setUsage] = useState<StorageUsageResponse | null>(null);
  const [isLoadingUsage, setIsLoadingUsage] = useState(true);

  // Transaction export filters
  const [txDateFrom, setTxDateFrom] = useState('');
  const [txDateTo, setTxDateTo] = useState('');
  const [isExportingMaster, setIsExportingMaster] = useState(false);
  const [isExportingTx, setIsExportingTx] = useState(false);

  // Secure Delete State
  const [delDateFrom, setDelDateFrom] = useState('');
  const [delDateTo, setDelDateTo] = useState('');
  const [prepareData, setPrepareData] = useState<PrepareDeleteResponse | null>(null);
  const [isPreparing, setIsPreparing] = useState(false);
  const [isBackupDownloaded, setIsBackupDownloaded] = useState(false);
  const [confirmText, setConfirmText] = useState('');
  const [isConfirming, setIsConfirming] = useState(false);

  const fetchStorageUsage = async () => {
    setIsLoadingUsage(true);
    try {
      const res = await api.backup.getStorageUsage();
      setUsage(res);
    } catch (err: any) {
      showToast('error', 'Storage Usage Failed', err.message);
    } finally {
      setIsLoadingUsage(false);
    }
  };

  useEffect(() => {
    fetchStorageUsage();
  }, []);

  // Export Master Data (Sheet 1: Plated Jewelry, Sheet 2: Raw Jewelry, Sheet 3: Stones, Sheet 4: Foil)
  const handleExportMasterData = async () => {
    setIsExportingMaster(true);
    try {
      const res = await api.backup.getMasterData();
      const wb = XLSX.utils.book_new();

      // Sheet 1: Plated Jewelry
      const wsPlated = XLSX.utils.json_to_sheet(
        (res.plated_jewelry || []).map((p) => ({
          'Design Code': p.item_id,
          'Current Quantity': p.quantity,
          'Unit': p.unit,
          'Min Threshold': p.low_stock_threshold ?? 0,
          'Cost Price (₹)': p.cost_price,
        }))
      );
      XLSX.utils.book_append_sheet(wb, wsPlated, 'Plated_Jewelry');

      // Sheet 2: Raw Jewelry
      const wsRaw = XLSX.utils.json_to_sheet(
        (res.raw_jewelry || []).map((r) => ({
          'Item Code': r.item_id,
          'Current Quantity': r.quantity,
          'Unit': r.unit,
          'Min Threshold': r.low_stock_threshold ?? 0,
        }))
      );
      XLSX.utils.book_append_sheet(wb, wsRaw, 'Raw_Jewelry');

      // Sheet 3: Stones
      const wsStones = XLSX.utils.json_to_sheet(
        (res.stones || []).map((s) => ({
          'Stone Code': s.item_id,
          'Current Quantity': s.quantity,
          'Unit': s.unit,
          'Min Threshold': s.low_stock_threshold ?? 0,
          'Cost Price (₹)': s.cost_price,
        }))
      );
      XLSX.utils.book_append_sheet(wb, wsStones, 'Stones');

      // Sheet 4: Foil
      const wsFoil = XLSX.utils.json_to_sheet(
        (res.foil || []).map((f) => ({
          'Foil Code': f.item_id,
          'Current Quantity': f.quantity,
          'Unit': f.unit,
          'Min Threshold': f.low_stock_threshold ?? 0,
          'Cost Price (₹)': f.cost_price,
        }))
      );
      XLSX.utils.book_append_sheet(wb, wsFoil, 'Foil');

      const filename = `Poonam_Master_Data_${new Date().toISOString().slice(0, 10)}.xlsx`;
      XLSX.writeFile(wb, filename);
      showToast('success', 'Master Data Exported', filename);
    } catch (err: any) {
      showToast('error', 'Export Failed', err.message);
    } finally {
      setIsExportingMaster(false);
    }
  };

  // Export Transaction History
  const handleExportTransactions = async (dateFrom?: string, dateTo?: string) => {
    setIsExportingTx(true);
    try {
      const res = await api.backup.getTransactions(dateFrom || undefined, dateTo || undefined);
      if (res.transactions.length === 0) {
        showToast('warning', 'No Transactions', 'No transactions found in this date range');
        setIsExportingTx(false);
        return false;
      }

      const ws = XLSX.utils.json_to_sheet(
        res.transactions.map((t) => ({
          'Transaction ID': t.id,
          'Timestamp': t.created_at,
          'Category': t.category,
          'Item Code': t.item_display_id,
          'Operation': t.operation.toUpperCase(),
          'Quantity Change': t.quantity_change,
          'Unit': t.unit,
          'Previous Balance': t.quantity_before,
          'Resulting Balance': t.quantity_after,
          'Performed By': t.performer_name || t.performed_by,
        }))
      );

      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Transactions');
      const filename = `Poonam_Transactions_Backup_${dateFrom || 'all'}_to_${dateTo || 'all'}.xlsx`;
      XLSX.writeFile(wb, filename);
      showToast('success', 'Transactions Exported', filename);
      return true;
    } catch (err: any) {
      showToast('error', 'Export Failed', err.message);
      return false;
    } finally {
      setIsExportingTx(false);
    }
  };

  // Step 1: Prepare Stable Boundary for Deletion
  const handlePrepareDelete = async () => {
    if (!delDateFrom || !delDateTo) {
      showToast('error', 'Date Range Required', 'Please choose both start and end date');
      return;
    }

    setIsPreparing(true);
    try {
      const res = await api.history.prepareDelete(delDateFrom, delDateTo);
      setPrepareData(res);
      setIsBackupDownloaded(false);
      setConfirmText('');
      showToast('info', 'Boundary Captured', `Identified ${res.count} transactions in boundary snapshot`);
    } catch (err: any) {
      showToast('error', 'Prepare Failed', err.message);
    } finally {
      setIsPreparing(false);
    }
  };

  // Step 2: Download verified backup for this exact boundary
  const handleDownloadVerifiedBackup = async () => {
    if (!prepareData) return;
    const ok = await handleExportTransactions(prepareData.date_from, prepareData.date_to);
    if (ok) {
      setIsBackupDownloaded(true);
    }
  };

  // Step 3: Confirm and execute boundary-guarded deletion
  const handleConfirmDelete = async () => {
    if (!prepareData) return;
    if (!isBackupDownloaded) {
      showToast('error', 'Verification Required', 'You must download the backup file before deleting');
      return;
    }
    if (confirmText !== 'DELETE') {
      showToast('error', 'Type DELETE', 'You must type DELETE to confirm transaction purge');
      return;
    }

    setIsConfirming(true);
    try {
      const res = await api.history.confirmDelete({
        date_from: prepareData.date_from,
        date_to: prepareData.date_to,
        boundary_rowid: prepareData.boundary_rowid,
        confirmation_text: 'DELETE',
        backup_verified: true,
      });

      showToast(
        'success',
        'Transactions Cleared',
        `Safely purged ${res.deleted_count} transactions inside verified boundary.`
      );

      setPrepareData(null);
      setConfirmText('');
      setIsBackupDownloaded(false);
      fetchStorageUsage();
    } catch (err: any) {
      showToast('error', 'Purge Failed', err.message);
    } finally {
      setIsConfirming(false);
    }
  };

  return (
    <div style={{ padding: '24px', maxWidth: '1200px', margin: '0 auto', width: '100%' }}>
      {/* Title */}
      <div style={{ marginBottom: 24 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <Database size={24} color="var(--gold-primary)" />
          <h2 style={{ fontSize: 22, fontWeight: 800 }}>Backup, Storage & Data Safety</h2>
        </div>
        <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 4 }}>
          Cloudflare D1 & R2 storage metrics, Excel workbooks, and verified history deletion.
        </p>
      </div>

      {/* Storage Metrics Cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 16, marginBottom: 28 }}>
        <div className="card">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
            <HardDrive size={18} color="var(--gold-primary)" />
            <h3 style={{ fontSize: 14 }}>Cloudflare D1 Database</h3>
          </div>
          {isLoadingUsage ? (
            <Loader2 size={16} className="animate-spin" />
          ) : usage ? (
            <div>
              <div style={{ fontSize: 22, fontWeight: 800, color: 'var(--gold-primary)' }} className="mono">
                {usage.d1.total_rows} Total Rows
              </div>
              <div style={{ marginTop: 10, fontSize: 12, color: 'var(--text-secondary)' }}>
                Plated: {usage.d1.table_counts.plated_jewelry || 0} · Raw: {usage.d1.table_counts.raw_jewelry || 0} · Stones: {usage.d1.table_counts.stones || 0} · Foil: {usage.d1.table_counts.foil || 0} · Transactions: {usage.d1.table_counts.transactions || 0}
              </div>
            </div>
          ) : (
            <div style={{ color: 'var(--text-muted)' }}>Unavailable</div>
          )}
        </div>

        <div className="card">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
            <FileSpreadsheet size={18} color="var(--emerald-text)" />
            <h3 style={{ fontSize: 14 }}>Cloudflare R2 Object Storage</h3>
          </div>
          {isLoadingUsage ? (
            <Loader2 size={16} className="animate-spin" />
          ) : usage ? (
            <div>
              <div style={{ fontSize: 22, fontWeight: 800, color: 'var(--emerald-text)' }} className="mono">
                {usage.r2.object_count} Images ({usage.r2.total_size_mb} MB)
              </div>
              <div style={{ marginTop: 10, fontSize: 12, color: 'var(--text-secondary)' }}>
                Optimized high-res catalog photos & thumbnails stored in R2.
              </div>
            </div>
          ) : (
            <div style={{ color: 'var(--text-muted)' }}>Unavailable</div>
          )}
        </div>
      </div>

      {/* Backup Downloads Section */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 20, marginBottom: 32 }}>
        {/* Master Data Workbook */}
        <div className="card">
          <h3 style={{ fontSize: 15, marginBottom: 6 }}>Export Master Data Workbook</h3>
          <p style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 16 }}>
            Download complete catalog snapshot (Plated Jewelry, Raw Jewelry, Stones, and Foil with valuations).
          </p>
          <button
            onClick={handleExportMasterData}
            className="btn btn-primary"
            disabled={isExportingMaster}
            style={{ width: '100%' }}
          >
            {isExportingMaster ? (
              <>
                <Loader2 size={14} className="animate-spin" /> Generating...
              </>
            ) : (
              <>
                <Download size={15} /> Download Master Data (.xlsx)
              </>
            )}
          </button>
        </div>

        {/* Transactions Workbook */}
        <div className="card">
          <h3 style={{ fontSize: 15, marginBottom: 6 }}>Export Transactions Workbook</h3>
          <p style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 12 }}>
            Export sequential audit log of all stock adjustments for reporting.
          </p>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 12 }}>
            <div>
              <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Date From:</span>
              <input
                type="date"
                className="input"
                style={{ fontSize: 12, padding: '6px' }}
                value={txDateFrom}
                onChange={(e) => setTxDateFrom(e.target.value)}
              />
            </div>
            <div>
              <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Date To:</span>
              <input
                type="date"
                className="input"
                style={{ fontSize: 12, padding: '6px' }}
                value={txDateTo}
                onChange={(e) => setTxDateTo(e.target.value)}
              />
            </div>
          </div>
          <button
            onClick={() => handleExportTransactions(txDateFrom, txDateTo)}
            className="btn btn-secondary"
            disabled={isExportingTx}
            style={{ width: '100%' }}
          >
            {isExportingTx ? (
              <>
                <Loader2 size={14} className="animate-spin" /> Exporting...
              </>
            ) : (
              <>
                <Download size={15} /> Export Transactions (.xlsx)
              </>
            )}
          </button>
        </div>
      </div>

      {/* Verified Stable Boundary Deletion Card */}
      <div
        style={{
          background: 'var(--bg-surface-1)',
          border: '1px solid var(--rose-border)',
          borderRadius: 'var(--radius-lg)',
          padding: '24px',
          boxShadow: 'var(--shadow-sm)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
          <ShieldAlert size={20} color="var(--rose-text)" />
          <h3 style={{ fontSize: 16, color: 'var(--rose-text)' }}>
            Secure Verified Boundary Transaction Deletion
          </h3>
        </div>
        <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 20 }}>
          Per security policy: Transactions cannot be purged without capturing a stable verified backup boundary. Any concurrent or newly created transactions during this process are protected.
        </p>

        {/* Step 1: Select Date Range */}
        {!prepareData && (
          <div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center', marginBottom: 16 }}>
              <div>
                <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Purge From:</span>
                <input
                  type="date"
                  className="input"
                  style={{ width: 160 }}
                  value={delDateFrom}
                  onChange={(e) => setDelDateFrom(e.target.value)}
                />
              </div>
              <div>
                <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Purge To:</span>
                <input
                  type="date"
                  className="input"
                  style={{ width: 160 }}
                  value={delDateTo}
                  onChange={(e) => setDelDateTo(e.target.value)}
                />
              </div>
              <button
                onClick={handlePrepareDelete}
                className="btn btn-danger"
                disabled={!delDateFrom || !delDateTo || isPreparing}
                style={{ marginTop: 16 }}
              >
                {isPreparing ? <Loader2 size={14} className="animate-spin" /> : 'Step 1: Capture Boundary'}
              </button>
            </div>
          </div>
        )}

        {/* Step 2 & 3: Verification & Confirm */}
        {prepareData && (
          <div
            style={{
              background: 'var(--bg-surface-2)',
              border: '1px solid var(--border-medium)',
              borderRadius: 'var(--radius-md)',
              padding: '18px',
            }}
          >
            <div style={{ marginBottom: 14 }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)' }}>
                Snapshot Boundary Established:
              </div>
              <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 4 }}>
                Found <strong>{prepareData.count}</strong> transactions between <strong>{prepareData.date_from}</strong> and <strong>{prepareData.date_to}</strong>.
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }} className="mono">
                Stable Boundary RowID: #{prepareData.boundary_rowid}
              </div>
            </div>

            {/* Download Gate */}
            <div style={{ marginBottom: 16 }}>
              <button
                onClick={handleDownloadVerifiedBackup}
                className={`btn ${isBackupDownloaded ? 'btn-secondary' : 'btn-primary'}`}
              >
                {isBackupDownloaded ? (
                  <>
                    <CheckCircle2 size={15} color="var(--emerald-text)" /> Backup Downloaded & Verified
                  </>
                ) : (
                  <>
                    <Download size={15} /> Step 2: Download Verified Boundary Backup (.xlsx)
                  </>
                )}
              </button>
            </div>

            {/* Final Confirmation Gate */}
            {isBackupDownloaded && (
              <div style={{ borderTop: '1px solid var(--border-subtle)', paddingTop: 16 }}>
                <label className="form-label" style={{ color: 'var(--rose-text)' }}>
                  Step 3: Type DELETE to permanently clear these {prepareData.count} transactions
                </label>
                <div style={{ display: 'flex', gap: 12, marginTop: 8 }}>
                  <input
                    type="text"
                    className="input mono"
                    style={{ maxWidth: 220 }}
                    placeholder="DELETE"
                    value={confirmText}
                    onChange={(e) => setConfirmText(e.target.value)}
                  />
                  <button
                    onClick={handleConfirmDelete}
                    className="btn btn-danger"
                    disabled={confirmText !== 'DELETE' || isConfirming}
                  >
                    {isConfirming ? <Loader2 size={14} className="animate-spin" /> : 'Confirm Purge'}
                  </button>
                  <button
                    onClick={() => {
                      setPrepareData(null);
                      setIsBackupDownloaded(false);
                      setConfirmText('');
                    }}
                    className="btn btn-secondary"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
