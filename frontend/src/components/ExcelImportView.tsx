import React, { useState } from 'react';
import {
  FileSpreadsheet,
  Upload,
  Loader2,
  Save,
  Trash2,
  ArrowRight,
} from 'lucide-react';
import * as XLSX from 'xlsx';
import { api } from '../api';
import type { InventoryCategory, StagingRow, InventoryUnit } from '../types';
import { useToast } from '../context/ToastContext';

export const ExcelImportView: React.FC = () => {
  const { showToast } = useToast();

  const [category, setCategory] = useState<InventoryCategory>('plated_jewelry');
  const [columns, setColumns] = useState<string[]>([]);
  const [columnMapping, setColumnMapping] = useState<Record<string, string | null>>({});
  const [isMappingConfirmed, setIsMappingConfirmed] = useState(false);

  const [rawRows, setRawRows] = useState<Record<string, any>[]>([]);
  const [stagingQueue, setStagingQueue] = useState<StagingRow[]>([]);
  const [isValidating, setIsValidating] = useState(false);
  const [isBulkCommitting, setIsBulkCommitting] = useState(false);

  // File drop / select handler
  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFile = e.target.files?.[0];
    if (!selectedFile) return;

    setStagingQueue([]);
    setIsMappingConfirmed(false);

    try {
      const data = await selectedFile.arrayBuffer();
      const workbook = XLSX.read(data, { type: 'array' });
      const firstSheetName = workbook.SheetNames[0];
      const worksheet = workbook.Sheets[firstSheetName];

      const jsonRows = XLSX.utils.sheet_to_json<Record<string, any>>(worksheet, { defval: '' });

      if (jsonRows.length === 0) {
        showToast('error', 'Empty File', 'The selected spreadsheet has no data rows');
        return;
      }

      setRawRows(jsonRows);
      const headerCols = Object.keys(jsonRows[0] || {});
      setColumns(headerCols);

      // Fetch auto-map suggestions from backend
      const autoMapRes = await api.excel.autoMap(headerCols, category);
      setColumnMapping(autoMapRes.mapping);
      showToast('info', 'File Parsed', `Found ${jsonRows.length} rows and ${headerCols.length} columns`);
    } catch (err: any) {
      showToast('error', 'Parsing Failed', err.message);
    }
  };

  // Convert raw rows to staging queue and validate with Worker
  const handleConfirmMapping = async () => {
    setIsMappingConfirmed(true);
    setIsValidating(true);

    const rowsToStage: StagingRow[] = [];

    // Reverse lookup from internal field to excel column
    const fieldToCol: Record<string, string> = {};
    for (const [col, field] of Object.entries(columnMapping)) {
      if (field) fieldToCol[field] = col;
    }

    rawRows.forEach((raw, idx) => {
      const itemId = fieldToCol['item_id'] ? String(raw[fieldToCol['item_id']] || '').trim() : '';
      const rawQty = fieldToCol['quantity'] ? raw[fieldToCol['quantity']] : '';
      const rawThresh = fieldToCol['low_stock_threshold'] ? raw[fieldToCol['low_stock_threshold']] : '';
      const rawCost = fieldToCol['cost_price'] ? raw[fieldToCol['cost_price']] : '';

      let unit: InventoryUnit | '' = '';
      if (category === 'stones') unit = 'PC';
      else if (category === 'foil') unit = 'KGS';
      else unit = 'PC'; // default unit suggestion for plated/raw

      rowsToStage.push({
        rowNumber: idx + 2, // header is row 1
        rawData: raw,
        item_id: itemId,
        quantity: rawQty !== '' && !isNaN(Number(rawQty)) ? Number(rawQty) : '',
        unit,
        low_stock_threshold: rawThresh !== '' && !isNaN(Number(rawThresh)) ? Number(rawThresh) : '',
        cost_price: rawCost !== '' && !isNaN(Number(rawCost)) ? Number(rawCost) : '',
        status: 'pending',
        validationErrors: [],
      });
    });

    // Validate rows concurrently with the Worker
    const validatedRows = await Promise.all(
      rowsToStage.map(async (row) => {
        try {
          const res = await api.excel.validateRow({
            category,
            item_id: row.item_id,
            quantity: typeof row.quantity === 'number' ? row.quantity : undefined,
            unit: row.unit || undefined,
            low_stock_threshold: typeof row.low_stock_threshold === 'number' ? row.low_stock_threshold : undefined,
            cost_price: typeof row.cost_price === 'number' ? row.cost_price : undefined,
          });
          return {
            ...row,
            status: res.valid ? ('valid' as const) : ('invalid' as const),
            validationErrors: res.errors ? res.errors.map((e) => e.message) : [],
          };
        } catch (err: any) {
          const errors = err.data?.errors ? err.data.errors.map((e: any) => e.message) : [err.message];
          return {
            ...row,
            status: 'invalid' as const,
            validationErrors: errors,
          };
        }
      })
    );

    setStagingQueue(validatedRows);
    setIsValidating(false);
  };

  // Re-validate a single row after user edit
  const revalidateRow = async (index: number) => {
    const row = stagingQueue[index];
    try {
      const res = await api.excel.validateRow({
        category,
        item_id: row.item_id,
        quantity: typeof row.quantity === 'number' ? row.quantity : undefined,
        unit: row.unit || undefined,
        low_stock_threshold: typeof row.low_stock_threshold === 'number' ? row.low_stock_threshold : undefined,
        cost_price: typeof row.cost_price === 'number' ? row.cost_price : undefined,
      });

      const updated = [...stagingQueue];
      updated[index] = {
        ...row,
        status: res.valid ? 'valid' : 'invalid',
        validationErrors: res.errors ? res.errors.map((e) => e.message) : [],
      };
      setStagingQueue(updated);
    } catch (err: any) {
      const errors = err.data?.errors ? err.data.errors.map((e: any) => e.message) : [err.message];
      const updated = [...stagingQueue];
      updated[index] = {
        ...row,
        status: 'invalid',
        validationErrors: errors,
      };
      setStagingQueue(updated);
    }
  };

  // Commit individual row to D1
  const commitRow = async (index: number) => {
    const row = stagingQueue[index];
    if (row.status !== 'valid') return;

    try {
      await api.excel.commitRow({
        category,
        item_id: row.item_id,
        quantity: Number(row.quantity),
        unit: row.unit || undefined,
        low_stock_threshold: Number(row.low_stock_threshold),
        cost_price: row.cost_price !== '' ? Number(row.cost_price) : undefined,
      });

      const updated = [...stagingQueue];
      updated[index] = {
        ...row,
        status: 'committed',
        validationErrors: [],
      };
      setStagingQueue(updated);
      showToast('success', 'Row Saved', `Added ${row.item_id} to ${category}`);
    } catch (err: any) {
      const updated = [...stagingQueue];
      updated[index] = {
        ...row,
        status: 'error',
        validationErrors: [err.message],
      };
      setStagingQueue(updated);
      showToast('error', 'Commit Failed', err.message);
    }
  };

  // Bulk commit all valid rows
  const commitAllValidRows = async () => {
    const validIndices = stagingQueue
      .map((row, idx) => (row.status === 'valid' ? idx : -1))
      .filter((idx) => idx !== -1);

    if (validIndices.length === 0) {
      showToast('warning', 'No Valid Rows', 'There are no validated rows ready for commit');
      return;
    }

    setIsBulkCommitting(true);
    let successCount = 0;

    for (const idx of validIndices) {
      const row = stagingQueue[idx];
      try {
        await api.excel.commitRow({
          category,
          item_id: row.item_id,
          quantity: Number(row.quantity),
          unit: row.unit || undefined,
          low_stock_threshold: Number(row.low_stock_threshold),
          cost_price: row.cost_price !== '' ? Number(row.cost_price) : undefined,
        });
        successCount++;
        setStagingQueue((prev) => {
          const next = [...prev];
          next[idx] = { ...next[idx], status: 'committed', validationErrors: [] };
          return next;
        });
      } catch (err: any) {
        setStagingQueue((prev) => {
          const next = [...prev];
          next[idx] = { ...next[idx], status: 'error', validationErrors: [err.message] };
          return next;
        });
      }
    }

    setIsBulkCommitting(false);
    showToast('success', 'Bulk Commit Completed', `Saved ${successCount} items to D1 database`);
  };

  const removeRowFromQueue = (index: number) => {
    setStagingQueue((prev) => prev.filter((_, idx) => idx !== index));
  };

  const updateRowField = (index: number, field: keyof StagingRow, value: any) => {
    const updated = [...stagingQueue];
    updated[index] = { ...updated[index], [field]: value };
    setStagingQueue(updated);
  };

  const validCount = stagingQueue.filter((r) => r.status === 'valid').length;
  const invalidCount = stagingQueue.filter((r) => r.status === 'invalid').length;
  const committedCount = stagingQueue.filter((r) => r.status === 'committed').length;

  return (
    <div style={{ padding: '24px', maxWidth: '1400px', margin: '0 auto', width: '100%' }}>
      {/* Title */}
      <div style={{ marginBottom: 24 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <FileSpreadsheet size={24} color="var(--gold-primary)" />
          <h2 style={{ fontSize: 22, fontWeight: 800 }}>Excel Import & Safe Staging Queue</h2>
        </div>
        <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 4 }}>
          Client-side parsing with independent Worker validation. Rows stage safely before D1 commits.
        </p>
      </div>

      {/* Target Category Selector */}
      <div
        style={{
          background: 'var(--bg-surface-1)',
          border: '1px solid var(--border-medium)',
          borderRadius: 'var(--radius-lg)',
          padding: '16px 20px',
          marginBottom: 20,
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          gap: 16,
        }}
      >
        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>
          Target Category:
        </span>
        <select
          className="select"
          style={{ width: 'auto', minWidth: 200 }}
          value={category}
          onChange={(e) => {
            setCategory(e.target.value as InventoryCategory);
            setStagingQueue([]);
            setIsMappingConfirmed(false);
          }}
          disabled={stagingQueue.length > 0}
        >
          <option value="plated_jewelry">Plated Jewelry</option>
          <option value="raw_jewelry">Raw Jewelry</option>
          <option value="stones">Stones</option>
          <option value="foil">Foil</option>
        </select>
        <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
          {category === 'plated_jewelry' && 'Supports design code, initial stock, unit, threshold, and cost price'}
          {category === 'raw_jewelry' && 'Supports raw casting code, stock, unit, and threshold'}
          {category === 'stones' && 'Unit is fixed to PC, requires cost price'}
          {category === 'foil' && 'Unit is fixed to KGS, requires cost price'}
        </span>
      </div>

      {/* Step 1: Upload File */}
      {!isMappingConfirmed && (
        <div
          style={{
            background: 'var(--bg-surface-1)',
            border: '2px dashed var(--border-medium)',
            borderRadius: 'var(--radius-lg)',
            padding: '36px 20px',
            textAlign: 'center',
            marginBottom: 24,
            cursor: 'pointer',
          }}
          onClick={() => document.getElementById('excel-file-input')?.click()}
        >
          <Upload size={36} color="var(--gold-primary)" style={{ margin: '0 auto 12px' }} />
          <h3 style={{ fontSize: 16 }}>Drop your Excel (.xlsx / .csv) file here</h3>
          <p style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 4 }}>
            or click to browse from your device
          </p>
          <input
            id="excel-file-input"
            type="file"
            accept=".xlsx, .xls, .csv"
            style={{ display: 'none' }}
            onChange={handleFileChange}
          />
        </div>
      )}

      {/* Step 2: Column Mapping */}
      {columns.length > 0 && !isMappingConfirmed && (
        <div
          style={{
            background: 'var(--bg-surface-1)',
            border: '1px solid var(--border-medium)',
            borderRadius: 'var(--radius-lg)',
            padding: '24px',
            marginBottom: 24,
          }}
        >
          <h3 style={{ fontSize: 16, marginBottom: 12 }}>Verify Column Mapping</h3>
          <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 20 }}>
            Ensure each spreadsheet column corresponds to the appropriate inventory field.
          </p>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 16 }}>
            {columns.map((col) => (
              <div
                key={col}
                style={{
                  background: 'var(--bg-surface-2)',
                  padding: '12px 16px',
                  borderRadius: 'var(--radius-md)',
                  border: '1px solid var(--border-subtle)',
                }}
              >
                <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 6 }}>{col}</div>
                <select
                  className="select"
                  value={columnMapping[col] || ''}
                  onChange={(e) =>
                    setColumnMapping((prev) => ({
                      ...prev,
                      [col]: e.target.value ? e.target.value : null,
                    }))
                  }
                >
                  <option value="">-- Ignore this column --</option>
                  <option value="item_id">Item ID / Design Code</option>
                  <option value="quantity">Current Quantity</option>
                  <option value="low_stock_threshold">Low Stock Threshold</option>
                  {category !== 'raw_jewelry' && <option value="cost_price">Cost Price (₹)</option>}
                </select>
              </div>
            ))}
          </div>

          <div style={{ marginTop: 24, display: 'flex', justifyContent: 'flex-end', gap: 12 }}>
            <button
              onClick={() => {
                setColumns([]);
              }}
              className="btn btn-secondary"
            >
              Reset
            </button>
            <button onClick={handleConfirmMapping} className="btn btn-primary">
              Proceed to Validation Queue <ArrowRight size={15} />
            </button>
          </div>
        </div>
      )}

      {/* Step 3: Interactive Staging Queue */}
      {isMappingConfirmed && (
        <div>
          {/* Summary Bar */}
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              justifyContent: 'space-between',
              alignItems: 'center',
              gap: 16,
              marginBottom: 16,
              background: 'var(--bg-surface-1)',
              padding: '14px 20px',
              borderRadius: 'var(--radius-lg)',
              border: '1px solid var(--border-subtle)',
            }}
          >
            <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
              <span className="badge badge-emerald">✓ {validCount} Valid</span>
              <span className="badge badge-rose">✕ {invalidCount} Errors</span>
              <span className="badge badge-gold">★ {committedCount} Saved</span>
            </div>

            <div style={{ display: 'flex', gap: 10 }}>
              <button
                onClick={commitAllValidRows}
                className="btn btn-primary"
                disabled={validCount === 0 || isBulkCommitting}
              >
                {isBulkCommitting ? (
                  <>
                    <Loader2 size={14} className="animate-spin" /> Committing...
                  </>
                ) : (
                  <>
                    <Save size={15} /> Commit All {validCount} Valid Rows to D1
                  </>
                )}
              </button>
              <button
                onClick={() => {
                  setIsMappingConfirmed(false);
                  setStagingQueue([]);
                }}
                className="btn btn-secondary"
              >
                Start Over
              </button>
            </div>
          </div>

          {/* Staging Table */}
          {isValidating ? (
            <div style={{ textAlign: 'center', padding: '60px 0', color: 'var(--text-muted)' }}>
              <Loader2 size={32} className="animate-spin" style={{ margin: '0 auto 12px' }} />
              <div>Worker is independently validating queue rows against D1 schema...</div>
            </div>
          ) : (
            <div className="table-container">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Row #</th>
                    <th>Item ID</th>
                    <th>Quantity</th>
                    <th>Unit</th>
                    <th>Min Threshold</th>
                    {category !== 'raw_jewelry' && <th>Cost (₹)</th>}
                    <th>Validation Status</th>
                    <th style={{ textAlign: 'right' }}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {stagingQueue.map((row, idx) => (
                    <tr
                      key={idx}
                      style={{
                        background:
                          row.status === 'committed'
                            ? 'rgba(16, 185, 129, 0.05)'
                            : row.status === 'invalid'
                            ? 'rgba(244, 63, 94, 0.05)'
                            : 'transparent',
                      }}
                    >
                      <td style={{ color: 'var(--text-muted)' }} className="mono">
                        #{row.rowNumber}
                      </td>

                      {/* Item ID */}
                      <td>
                        <input
                          type="text"
                          className="input mono"
                          style={{ padding: '4px 8px', fontSize: 12, minWidth: 120 }}
                          value={row.item_id}
                          disabled={row.status === 'committed'}
                          onChange={(e) => updateRowField(idx, 'item_id', e.target.value)}
                          onBlur={() => revalidateRow(idx)}
                        />
                      </td>

                      {/* Quantity */}
                      <td>
                        <input
                          type="number"
                          step="any"
                          className="input mono"
                          style={{ padding: '4px 8px', fontSize: 12, width: 80 }}
                          value={row.quantity}
                          disabled={row.status === 'committed'}
                          onChange={(e) =>
                            updateRowField(idx, 'quantity', e.target.value === '' ? '' : Number(e.target.value))
                          }
                          onBlur={() => revalidateRow(idx)}
                        />
                      </td>

                      {/* Unit */}
                      <td>
                        {category === 'stones' ? (
                          <span className="badge badge-gold">PC</span>
                        ) : category === 'foil' ? (
                          <span className="badge badge-gold">KGS</span>
                        ) : (
                          <select
                            className="select"
                            style={{ padding: '4px 6px', fontSize: 12, width: 75 }}
                            value={row.unit}
                            disabled={row.status === 'committed'}
                            onChange={(e) => {
                              updateRowField(idx, 'unit', e.target.value);
                              setTimeout(() => revalidateRow(idx), 50);
                            }}
                          >
                            <option value="PC">PC</option>
                            <option value="KGS">KGS</option>
                            <option value="SET">SET</option>
                            <option value="JODI">JODI</option>
                          </select>
                        )}
                      </td>

                      {/* Threshold */}
                      <td>
                        <input
                          type="number"
                          step="any"
                          className="input mono"
                          style={{ padding: '4px 8px', fontSize: 12, width: 80 }}
                          value={row.low_stock_threshold}
                          disabled={row.status === 'committed'}
                          onChange={(e) =>
                            updateRowField(
                              idx,
                              'low_stock_threshold',
                              e.target.value === '' ? '' : Number(e.target.value)
                            )
                          }
                          onBlur={() => revalidateRow(idx)}
                        />
                      </td>

                      {/* Cost Price */}
                      {category !== 'raw_jewelry' && (
                        <td>
                          <input
                            type="number"
                            step="0.01"
                            className="input mono"
                            style={{ padding: '4px 8px', fontSize: 12, width: 90 }}
                            value={row.cost_price}
                            disabled={row.status === 'committed'}
                            onChange={(e) =>
                              updateRowField(idx, 'cost_price', e.target.value === '' ? '' : Number(e.target.value))
                            }
                            onBlur={() => revalidateRow(idx)}
                          />
                        </td>
                      )}

                      {/* Status */}
                      <td>
                        {row.status === 'committed' && (
                          <span className="badge badge-emerald">✓ Saved in D1</span>
                        )}
                        {row.status === 'valid' && (
                          <span className="badge badge-emerald">Ready to Save</span>
                        )}
                        {row.status === 'invalid' && (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                            {row.validationErrors.map((err, eIdx) => (
                              <span key={eIdx} className="badge badge-rose" style={{ fontSize: 10 }}>
                                ⚠ {err}
                              </span>
                            ))}
                          </div>
                        )}
                        {row.status === 'error' && (
                          <span className="badge badge-rose">Error Saving</span>
                        )}
                      </td>

                      {/* Actions */}
                      <td style={{ textAlign: 'right' }}>
                        <div style={{ display: 'inline-flex', gap: 6 }}>
                          {row.status === 'valid' && (
                            <button
                              onClick={() => commitRow(idx)}
                              className="btn btn-primary"
                              style={{ padding: '4px 10px', fontSize: 11 }}
                              title="Commit this row to D1"
                            >
                              Save Row
                            </button>
                          )}
                          {row.status !== 'committed' && (
                            <button
                              onClick={() => removeRowFromQueue(idx)}
                              className="btn btn-secondary"
                              style={{ padding: '4px 8px' }}
                              title="Discard row"
                            >
                              <Trash2 size={12} />
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
