import React, { useState, useMemo } from 'react';
import {
  FileSpreadsheet,
  Upload,
  Loader2,
  Save,
  Trash2,
  ArrowRight,
  ArrowLeft,
  CheckCircle2,
  AlertTriangle,
  Tag,
  Layers,
  Ruler,
  IndianRupee,
  Sparkles,
  RefreshCw,
  Link2,
} from 'lucide-react';
import * as XLSX from 'xlsx';
import { api } from '../api';
import type { InventoryCategory, StagingRow, InventoryUnit } from '../types';
import { useToast } from '../context/ToastContext';
import { localDb } from '../lib/localDb';
import { syncEngine } from '../lib/syncEngine';
import {
  parseExcelWorksheet,
  CATEGORY_FIELDS,
  autoMatchColumns,
  serializeTarget,
  parseTarget,
  detectSheetLinks,
  type SystemFieldDef,
  type ColumnTarget,
  type ParsedExcelResult,
} from '../utils/excelParser';

export const ExcelImportView: React.FC = () => {
  const { showToast } = useToast();

  const [category, setCategory] = useState<InventoryCategory>('plated_jewelry');
  const [fileName, setFileName] = useState<string>('');
  
  // All parsed sheets stored in a dictionary: sheetName -> ParsedExcelResult
  const [parsedSheets, setParsedSheets] = useState<Record<string, ParsedExcelResult>>({});
  const [sheetNames, setSheetNames] = useState<string[]>([]);
  const [activeSheet, setActiveSheet] = useState<string>('');

  // System field -> serialized target "sheet::col" (or null / empty string for "None")
  const [fieldMapping, setFieldMapping] = useState<Record<string, string | null>>({});
  // Optional default value for fields set to "None"
  const [manualDefaults, setManualDefaults] = useState<Record<string, string>>({});

  const [isMappingConfirmed, setIsMappingConfirmed] = useState(false);
  const [stagingQueue, setStagingQueue] = useState<StagingRow[]>([]);
  const [isValidating, setIsValidating] = useState(false);
  const [isBulkCommitting, setIsBulkCommitting] = useState(false);

  // Quick fill tool state in staging view
  const [quickFillField, setQuickFillField] = useState<string>('low_stock_threshold');
  const [quickFillValue, setQuickFillValue] = useState<string>('10');

  // Active sheet data derivations
  const activeParsed = parsedSheets[activeSheet];
  const detectedColumns = activeParsed?.detectedColumns || [];
  const rawRows = activeParsed?.rawRows || [];
  const skippedHeaderCount = activeParsed?.skippedHeaderCount || 0;
  const hasParsedSheets = Object.keys(parsedSheets).length > 0;

  // Custom bridge link overrides (user freedom to override linking columns if desired)
  const [customSheetLinks, setCustomSheetLinks] = useState<Record<string, { colA: string; colB: string }>>({});
  const [showLinkConfig, setShowLinkConfig] = useState(false);

  // Automatically detect common bridge columns across sheets by comparing real cell values
  const autoLinks = useMemo(() => {
    if (sheetNames.length < 2) return {};
    const pSheet = activeSheet || sheetNames[0];
    return detectSheetLinks(parsedSheets, pSheet);
  }, [parsedSheets, activeSheet, sheetNames]);

  // File drop / select handler
  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFile = e.target.files?.[0];
    if (!selectedFile) return;

    setStagingQueue([]);
    setIsMappingConfirmed(false);
    setFileName(selectedFile.name);

    try {
      const data = await selectedFile.arrayBuffer();
      const wb = XLSX.read(data, { type: 'array' });

      const names = wb.SheetNames || [];
      setSheetNames(names);

      if (names.length === 0) {
        showToast('error', 'Empty Workbook', 'No sheets found in this file.');
        return;
      }

      // Parse all sheets in workbook
      const parsedMap: Record<string, ParsedExcelResult> = {};
      for (const name of names) {
        const ws = wb.Sheets[name];
        if (ws) {
          try {
            const parsed = parseExcelWorksheet(ws, name);
            if (parsed.detectedColumns.length > 0) {
              parsedMap[name] = parsed;
            }
          } catch (err: any) {
            console.warn(`Could not parse sheet "${name}":`, err.message);
          }
        }
      }

      const parsedKeys = Object.keys(parsedMap);
      if (parsedKeys.length === 0) {
        showToast('error', 'No Valid Columns', 'Could not identify headers in any sheet.');
        return;
      }

      setParsedSheets(parsedMap);
      const initialSheet = parsedKeys[0];
      setActiveSheet(initialSheet);

      // Perform initial auto-matching on initial sheet
      const initialFields = CATEGORY_FIELDS[category] || [];
      const newMapping: Record<string, string | null> = {};

      const s1Matches = autoMatchColumns(category, parsedMap[initialSheet].detectedColumns);
      for (const field of initialFields) {
        if (s1Matches[field.key]) {
          newMapping[field.key] = serializeTarget(initialSheet, s1Matches[field.key]!);
        } else {
          newMapping[field.key] = null;
        }
      }

      setFieldMapping(newMapping);
      setManualDefaults({});

      showToast(
        'info',
        'Excel Loaded',
        `Found ${names.length} sheet(s). Active sheet: "${initialSheet}" with ${parsedMap[initialSheet].detectedColumns.length} columns.`
      );
    } catch (err: any) {
      showToast('error', 'Parsing Failed', err.message);
    }
  };

  // Switch active sheet while preserving previously mapped columns
  const handleSelectSheet = (newSheetName: string) => {
    setActiveSheet(newSheetName);
    const newSheetParsed = parsedSheets[newSheetName];
    if (!newSheetParsed) return;

    // PRESERVE ALL EXISTING MAPPINGS! DO NOT LOSE PREVIOUS SHEET MAPPINGS!
    setFieldMapping((prevMapping) => {
      const updated = { ...prevMapping };
      const currentActiveFields = CATEGORY_FIELDS[category] || [];

      // Check for any unmapped fields
      const unmappedFields = currentActiveFields.filter((f) => !updated[f.key]);

      if (unmappedFields.length > 0) {
        // Auto-match unmapped fields against newly selected sheet
        const unmappedKeys = new Set(unmappedFields.map((f) => f.key));
        const newSheetMatches = autoMatchColumns(category, newSheetParsed.detectedColumns);
        for (const [k, col] of Object.entries(newSheetMatches)) {
          if (unmappedKeys.has(k) && col) {
            updated[k] = serializeTarget(newSheetName, col);
          }
        }
      }
      return updated;
    });

    showToast(
      'info',
      `Switched to "${newSheetName}"`,
      `Previous mappings preserved. You can now map columns from "${newSheetName}".`
    );
  };

  // Switch category and re-apply auto matching
  const handleCategoryChange = (newCat: InventoryCategory) => {
    setCategory(newCat);
    setStagingQueue([]);
    setIsMappingConfirmed(false);

    const newFields = CATEGORY_FIELDS[newCat] || [];
    const newMapping: Record<string, string | null> = {};

    const activeSheetParsed = parsedSheets[activeSheet] || Object.values(parsedSheets)[0];
    if (activeSheetParsed) {
      // First pass on active sheet
      const activeMatches = autoMatchColumns(newCat, activeSheetParsed.detectedColumns);
      for (const field of newFields) {
        if (activeMatches[field.key]) {
          newMapping[field.key] = serializeTarget(activeSheetParsed.sheetName, activeMatches[field.key]!);
        } else {
          newMapping[field.key] = null;
        }
      }

      // Check remaining sheets for unmapped fields
      for (const [sName, sParsed] of Object.entries(parsedSheets)) {
        if (sName === activeSheetParsed.sheetName) continue;
        const otherMatches = autoMatchColumns(newCat, sParsed.detectedColumns);
        for (const field of newFields) {
          if (!newMapping[field.key] && otherMatches[field.key]) {
            newMapping[field.key] = serializeTarget(sName, otherMatches[field.key]!);
          }
        }
      }
    }

    setFieldMapping(newMapping);
    setManualDefaults({});
  };

  // Convert raw rows to staging queue and validate with Worker (supporting cross-sheet joins)
  const handleConfirmMapping = async () => {
    setIsMappingConfirmed(true);
    setIsValidating(true);

    const currentActiveFields = CATEGORY_FIELDS[category] || [];

    // 1. Parse all mapped targets
    const parsedTargets: Record<string, ColumnTarget | null> = {};
    for (const field of currentActiveFields) {
      parsedTargets[field.key] = parseTarget(fieldMapping[field.key]);
    }

    // 2. Identify primary sheet (sheet where item_id is mapped, or sheet with most mapped fields)
    const itemIdTarget = parsedTargets['item_id'];
    let primarySheetName = itemIdTarget?.sheet;

    if (!primarySheetName || !parsedSheets[primarySheetName]) {
      const sheetCounts: Record<string, number> = {};
      for (const target of Object.values(parsedTargets)) {
        if (target && target.sheet && parsedSheets[target.sheet]) {
          sheetCounts[target.sheet] = (sheetCounts[target.sheet] || 0) + 1;
        }
      }
      let maxCount = -1;
      for (const [s, cnt] of Object.entries(sheetCounts)) {
        if (cnt > maxCount) {
          maxCount = cnt;
          primarySheetName = s;
        }
      }
      if (!primarySheetName) {
        primarySheetName = activeSheet || Object.keys(parsedSheets)[0];
      }
    }

    const primaryParsed = parsedSheets[primarySheetName];
    if (!primaryParsed || primaryParsed.rawRows.length === 0) {
      showToast('error', 'No Data', `Primary sheet "${primarySheetName}" has no data rows.`);
      setIsValidating(false);
      setIsMappingConfirmed(false);
      return;
    }

    // 3. For any secondary sheets mapped to fields, build key lookup tables using smart bridge detection
    const secondaryLookups: Record<
      string,
      {
        primaryKeyCol: string;
        secKeyCol: string;
        lookupMap: Map<string, Record<string, any>>;
        rawRows: Record<string, any>[];
      }
    > = {};

    const primaryItemCol = itemIdTarget?.sheet === primarySheetName ? itemIdTarget.column : '';
    const primaryItemIds = primaryItemCol
      ? primaryParsed.rawRows.map((r) => String(r[primaryItemCol] || '').trim()).filter(Boolean)
      : [];

    for (const target of Object.values(parsedTargets)) {
      if (!target || !target.sheet || target.sheet === primarySheetName) continue;
      const secSheet = target.sheet;
      if (secondaryLookups[secSheet]) continue;

      const secParsed = parsedSheets[secSheet];
      if (!secParsed) continue;

      // Smart link bridge (custom or auto-detected)
      const link = customSheetLinks[secSheet] || autoLinks[secSheet];
      let primaryKeyCol = link ? link.colA : (primaryItemCol || '');
      let secKeyCol = link ? link.colB : '';

      // If no bridge link was found, search for best matching column
      if (!secKeyCol && primaryItemIds.length > 0) {
        let maxMatchCount = 0;
        for (const col of secParsed.detectedColumns) {
          const secVals = new Set(
            secParsed.rawRows.map((r) => String(r[col] || '').trim().toLowerCase())
          );
          let m = 0;
          for (const id of primaryItemIds) {
            if (secVals.has(id.toLowerCase())) m++;
          }
          if (m > maxMatchCount) {
            maxMatchCount = m;
            secKeyCol = col;
          }
        }
      }

      const lookupMap = new Map<string, Record<string, any>>();
      if (secKeyCol) {
        for (const r of secParsed.rawRows) {
          const key = String(r[secKeyCol] || '').trim().toLowerCase();
          if (key && !lookupMap.has(key)) {
            lookupMap.set(key, r);
          }
        }
      }

      secondaryLookups[secSheet] = {
        primaryKeyCol,
        secKeyCol,
        lookupMap,
        rawRows: secParsed.rawRows,
      };
    }

    // Helper to extract field value from primary or secondary sheet
    const getFieldValue = (fieldKey: string, primaryRow: Record<string, any>, rowIdx: number, itemId: string) => {
      const target = parsedTargets[fieldKey];
      if (!target || !target.column) {
        return manualDefaults[fieldKey] || '';
      }

      if (target.sheet === primarySheetName) {
        const val = primaryRow[target.column];
        return val !== undefined && val !== null ? val : (manualDefaults[fieldKey] || '');
      }

      // Read from secondary sheet
      const secInfo = secondaryLookups[target.sheet];
      if (secInfo) {
        // 1. Try matching by bridge key (e.g. primaryRow['Stock Balance - Item Name'])
        const bridgeKey = secInfo.primaryKeyCol
          ? String(primaryRow[secInfo.primaryKeyCol] || itemId || '').trim()
          : itemId;

        if (bridgeKey && secInfo.lookupMap.size > 0) {
          const secRow = secInfo.lookupMap.get(bridgeKey.toLowerCase());
          if (secRow && secRow[target.column] !== undefined && secRow[target.column] !== null) {
            return secRow[target.column];
          }
        }
        // 2. Fallback to row index
        if (secInfo.rawRows[rowIdx] && secInfo.rawRows[rowIdx][target.column] !== undefined) {
          return secInfo.rawRows[rowIdx][target.column];
        }
      }

      return manualDefaults[fieldKey] || '';
    };

    // 4. Construct staging rows
    const rowsToStage: StagingRow[] = [];

    primaryParsed.rawRows.forEach((raw, idx) => {
      let itemId = '';
      if (itemIdTarget && itemIdTarget.sheet === primarySheetName) {
        itemId = String(raw[itemIdTarget.column] || '').trim();
      } else if (itemIdTarget) {
        itemId = String(getFieldValue('item_id', raw, idx, '') || '').trim();
      } else {
        itemId = manualDefaults['item_id'] || '';
      }

      const rawQty = getFieldValue('quantity', raw, idx, itemId);

      // Skip trailing/blank spacer rows in Excel if item_id was mapped but blank
      if (itemIdTarget && !itemId && (!rawQty || rawQty === '')) {
        return;
      }

      const rawThresh = getFieldValue('low_stock_threshold', raw, idx, itemId);
      const rawCost = getFieldValue('cost_price', raw, idx, itemId);

      // Unit
      let unit: InventoryUnit | '' = '';
      if (category === 'stones') {
        unit = 'PC';
      } else if (category === 'foil') {
        unit = 'KGS';
      } else {
        const rawUnit = String(getFieldValue('unit', raw, idx, itemId) || '').trim().toUpperCase();
        if (['PC', 'KGS', 'SET', 'JODI'].includes(rawUnit)) {
          unit = rawUnit as InventoryUnit;
        } else {
          unit = 'PC';
        }
      }

      rowsToStage.push({
        rowNumber: idx + 1 + (primaryParsed.skippedHeaderCount + 1),
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

    if (rowsToStage.length === 0) {
      showToast('warning', 'No Rows Found', 'No valid rows with data were found to stage.');
      setIsValidating(false);
      setIsMappingConfirmed(false);
      return;
    }

    // 5. Validate rows concurrently with the Worker
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

  // Re-validate a single row after user edits a cell
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

  // Commit individual row to D1 and local SQLite
  const commitRow = async (index: number) => {
    const row = stagingQueue[index];
    if (row.status !== 'valid') return;

    try {
      const res = await api.excel.commitRow({
        category,
        item_id: row.item_id,
        quantity: Number(row.quantity),
        unit: row.unit || undefined,
        low_stock_threshold: Number(row.low_stock_threshold),
        cost_price: row.cost_price !== '' ? Number(row.cost_price) : undefined,
      });

      // Update local SQLite so Kundan Stones and all inventory views reflect changes instantly
      const unit = row.unit || (category === 'stones' ? 'PC' : category === 'foil' ? 'KGS' : 'PC');
      const costNum = row.cost_price !== '' && row.cost_price !== undefined ? Number(row.cost_price) : 0;
      const costCents = Math.round(costNum * 100);
      const now = new Date().toISOString();
      const itemId = res?.id || (res as any)?.item?.id || `local_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

      try {
        await localDb.upsertItem(category, {
          id: itemId,
          item_id: row.item_id.trim(),
          quantity: Number(row.quantity),
          unit,
          low_stock_threshold: Number(row.low_stock_threshold),
          cost_price_cents: costCents,
          cost_price: costNum,
          is_deleted: 0,
          created_at: now,
          updated_at: now,
        });
        window.dispatchEvent(new CustomEvent('localdb-change', { detail: { store: category } }));
        syncEngine.triggerSync().catch(() => {});
      } catch (localErr) {
        console.warn('Failed to upsert row to localDb:', localErr);
      }

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
    const committedLocalItems: Record<string, any>[] = [];

    for (const idx of validIndices) {
      const row = stagingQueue[idx];
      try {
        const res = await api.excel.commitRow({
          category,
          item_id: row.item_id,
          quantity: Number(row.quantity),
          unit: row.unit || undefined,
          low_stock_threshold: Number(row.low_stock_threshold),
          cost_price: row.cost_price !== '' ? Number(row.cost_price) : undefined,
        });
        successCount++;

        const unit = row.unit || (category === 'stones' ? 'PC' : category === 'foil' ? 'KGS' : 'PC');
        const costNum = row.cost_price !== '' && row.cost_price !== undefined ? Number(row.cost_price) : 0;
        const costCents = Math.round(costNum * 100);
        const now = new Date().toISOString();
        const itemId = res?.id || (res as any)?.item?.id || `local_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

        committedLocalItems.push({
          id: itemId,
          item_id: row.item_id.trim(),
          quantity: Number(row.quantity),
          unit,
          low_stock_threshold: Number(row.low_stock_threshold),
          cost_price_cents: costCents,
          cost_price: costNum,
          is_deleted: 0,
          created_at: now,
          updated_at: now,
        });

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

    // Upsert all successfully committed items to local SQLite
    if (committedLocalItems.length > 0) {
      try {
        await localDb.bulkUpsert(category, committedLocalItems);
        window.dispatchEvent(new CustomEvent('localdb-change', { detail: { store: category } }));
        syncEngine.triggerSync().catch(() => {});
      } catch (localErr) {
        console.warn('Failed to bulk upsert to localDb:', localErr);
      }
    }

    setIsBulkCommitting(false);
    showToast('success', 'Bulk Commit Completed', `Saved ${successCount} items to ${category}`);
  };

  // Quick fill tool to apply a common value to all empty cells in staging queue
  const applyQuickFill = async () => {
    if (quickFillValue === '') return;
    const field = quickFillField as keyof StagingRow;
    const parsedVal =
      field === 'quantity' || field === 'low_stock_threshold' || field === 'cost_price'
        ? Number(quickFillValue)
        : quickFillValue;

    const updated = stagingQueue.map((row) => {
      if (row.status === 'committed') return row;
      if (row[field] === '' || row[field] === undefined || isNaN(row[field] as any)) {
        return { ...row, [field]: parsedVal };
      }
      return row;
    });

    setStagingQueue(updated);
    showToast('info', 'Batch Updated', `Applied "${quickFillValue}" to all uncommitted rows`);

    // Revalidate modified rows
    setIsValidating(true);
    const revalidated = await Promise.all(
      updated.map(async (row) => {
        if (row.status === 'committed') return row;
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
    setStagingQueue(revalidated);
    setIsValidating(false);
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

  const activeFields: SystemFieldDef[] = CATEGORY_FIELDS[category] || [];

  const getFieldIcon = (key: string) => {
    switch (key) {
      case 'item_id':
        return <Tag size={16} color="var(--gold-primary)" />;
      case 'quantity':
        return <Layers size={16} color="var(--teal-deep)" />;
      case 'unit':
        return <Ruler size={16} color="#6366F1" />;
      case 'low_stock_threshold':
        return <AlertTriangle size={16} color="#F59E0B" />;
      case 'cost_price':
        return <IndianRupee size={16} color="#10B981" />;
      default:
        return <Tag size={16} />;
    }
  };

  return (
    <div className="view-container">
      {/* Title */}
      <div style={{ marginBottom: 24 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <FileSpreadsheet size={24} color="var(--gold-primary)" />
          <h2 style={{ fontSize: 22, fontWeight: 700 }}>Excel Import & Safe Staging Queue</h2>
        </div>
        <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 4 }}>
          Automatic column identification (skipping headers), interactive zig-zag visual mapping, and safe D1 staging.
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
          onChange={(e) => handleCategoryChange(e.target.value as InventoryCategory)}
          disabled={stagingQueue.length > 0}
        >
          <option value="plated_jewelry">Plated Jewelry</option>
          <option value="raw_jewelry">Raw Jewelry</option>
          <option value="stones">Kundan Stone</option>
          <option value="foil">Foil</option>
        </select>
        <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
          {category === 'plated_jewelry' && 'Maps: Item ID, Quantity, Unit, Threshold, Cost Price (₹)'}
          {category === 'raw_jewelry' && 'Maps: Raw Casting Code, Quantity, Unit, Threshold'}
          {category === 'stones' && 'Maps: Kundan Stone Code, Quantity (PC), Threshold, Cost Price (₹)'}
          {category === 'foil' && 'Maps: Foil Code, Quantity (KGS), Threshold, Cost Price (₹)'}
        </span>
      </div>

      {/* Step 1: Upload File */}
      {!isMappingConfirmed && !hasParsedSheets && (
        <div
          style={{
            background: 'var(--bg-surface-1)',
            border: '2px dashed var(--border-medium)',
            borderRadius: 'var(--radius-lg)',
            padding: '48px 20px',
            textAlign: 'center',
            marginBottom: 24,
            cursor: 'pointer',
            transition: 'border-color 0.2s ease',
          }}
          onClick={() => document.getElementById('excel-file-input')?.click()}
        >
          <Upload size={40} color="var(--gold-primary)" style={{ margin: '0 auto 12px' }} />
          <h3 style={{ fontSize: 17, fontWeight: 600 }}>Drop your Excel spreadsheet (.xlsx, .xls, .csv) here</h3>
          <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 6, maxWidth: 480, margin: '6px auto 0' }}>
            Headers, banners, and title blocks at the top will be automatically identified and skipped.
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

      {/* Step 2: Zig-Zag Column Mapping Board */}
      {hasParsedSheets && !isMappingConfirmed && (
        <div
          style={{
            background: 'var(--bg-surface-1)',
            border: '1px solid var(--border-medium)',
            borderRadius: 'var(--radius-lg)',
            padding: '24px',
            marginBottom: 24,
            boxShadow: 'var(--shadow-sm)',
          }}
        >
          {/* Header & File Info Banner */}
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 12,
              paddingBottom: 16,
              borderBottom: '1px solid var(--border-subtle)',
              marginBottom: 24,
            }}
          >
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Sparkles size={18} color="var(--gold-primary)" />
                <h3 style={{ fontSize: 16, fontWeight: 700 }}>Interactive Column Mapping Board</h3>
              </div>
              <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 2 }}>
                Map each category field to any column across workbook sheets. Columns from different sheets can be freely combined.
              </p>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--text-muted)' }}>
                <span className="badge badge-gold">File: {fileName} {activeSheet ? `(${activeSheet})` : ''}</span>
                <span className="badge badge-emerald">{detectedColumns.length} Columns in Active Sheet</span>
                <span className="badge badge-indigo">{rawRows.length} Data Rows</span>
                {skippedHeaderCount > 0 && (
                  <span className="badge badge-rose">Skipped {skippedHeaderCount} Banners</span>
                )}
              </div>

              {sheetNames.length > 1 && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-secondary)' }}>
                    Workbook Sheets:
                  </span>
                  {sheetNames.map((s) => {
                    const isSelected = activeSheet === s;
                    const sParsed = parsedSheets[s];
                    // Count how many fields are currently mapped from this sheet
                    const mappedCountForSheet = activeFields.filter((f) => {
                      const t = parseTarget(fieldMapping[f.key]);
                      return t?.sheet === s;
                    }).length;

                    return (
                      <button
                        key={s}
                        type="button"
                        onClick={() => handleSelectSheet(s)}
                        style={{
                          cursor: 'pointer',
                          padding: '4px 10px',
                          fontSize: 11,
                          borderRadius: 'var(--radius-sm)',
                          border: isSelected ? '2px solid var(--gold-primary)' : '1px solid var(--border-medium)',
                          background: isSelected ? 'var(--bg-surface-2)' : 'transparent',
                          fontWeight: isSelected ? 700 : 500,
                          color: isSelected ? 'var(--gold-primary)' : 'var(--text-secondary)',
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: 6,
                          transition: 'all 0.15s ease',
                        }}
                      >
                        <span>{s}</span>
                        {sParsed && (
                          <span
                            style={{
                              fontSize: 10,
                              background: isSelected ? 'var(--gold-primary)' : 'var(--bg-surface-3)',
                              color: isSelected ? '#000' : 'var(--text-muted)',
                              padding: '1px 5px',
                              borderRadius: 8,
                              fontWeight: 700,
                            }}
                          >
                            {sParsed.detectedColumns.length} cols
                          </span>
                        )}
                        {mappedCountForSheet > 0 && (
                          <span
                            className="badge badge-emerald"
                            style={{ fontSize: 9, padding: '1px 5px', lineHeight: '14px', fontWeight: 700 }}
                            title={`${mappedCountForSheet} field(s) mapped from this sheet`}
                          >
                            ✓ {mappedCountForSheet} mapped
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </div>

          {/* Smart Sheet Bridge Banner when multiple sheets exist */}
          {sheetNames.length > 1 && Object.keys(autoLinks).length > 0 && (
            <div
              style={{
                background: 'var(--bg-surface-2)',
                border: '1px solid rgba(217, 119, 6, 0.25)',
                borderRadius: 'var(--radius-md)',
                padding: '12px 16px',
                marginBottom: 20,
                display: 'flex',
                flexWrap: 'wrap',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 12,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <Link2 size={16} color="var(--gold-primary)" />
                <div>
                  <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-primary)' }}>
                    Smart Multi-Sheet Identification
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
                    Common item identifier columns were automatically detected across your sheets for seamless merging:
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                  {Object.entries(autoLinks).map(([sB, link]) => {
                    const custom = customSheetLinks[sB];
                    const activeColA = custom?.colA || link.colA;
                    const activeColB = custom?.colB || link.colB;
                    return (
                      <span
                        key={sB}
                        className="badge badge-gold"
                        style={{ fontSize: 11, padding: '4px 10px', display: 'inline-flex', alignItems: 'center', gap: 6 }}
                      >
                        <strong>{link.sheetA}</strong> [{activeColA}] ⟷ <strong>{link.sheetB}</strong> [{activeColB}]
                        <span style={{ fontSize: 10, opacity: 0.85 }}>({link.matchCount} common items)</span>
                      </span>
                    );
                  })}
                </div>
              </div>

              <button
                type="button"
                onClick={() => setShowLinkConfig(!showLinkConfig)}
                className="btn btn-secondary"
                style={{ fontSize: 11, padding: '4px 10px', height: 'auto' }}
              >
                {showLinkConfig ? 'Close Key Settings' : 'Customize Bridge Key'}
              </button>

              {showLinkConfig && (
                <div
                  style={{
                    width: '100%',
                    paddingTop: 12,
                    marginTop: 4,
                    borderTop: '1px solid rgba(217, 119, 6, 0.15)',
                    display: 'flex',
                    flexWrap: 'wrap',
                    alignItems: 'center',
                    gap: 12,
                    fontSize: 12,
                  }}
                >
                  <span style={{ fontWeight: 600, color: 'var(--text-secondary)' }}>
                    Link column pair:
                  </span>
                  {Object.entries(autoLinks).map(([sB, link]) => {
                    const sAParsed = parsedSheets[link.sheetA];
                    const sBParsed = parsedSheets[link.sheetB];
                    const custom = customSheetLinks[sB];
                    const selectedA = custom?.colA || link.colA;
                    const selectedB = custom?.colB || link.colB;

                    return (
                      <div key={sB} style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                        <span>{link.sheetA}:</span>
                        <select
                          className="select"
                          style={{ padding: '3px 8px', fontSize: 11, width: 'auto' }}
                          value={selectedA}
                          onChange={(e) =>
                            setCustomSheetLinks((prev) => ({
                              ...prev,
                              [sB]: { colA: e.target.value, colB: selectedB },
                            }))
                          }
                        >
                          {sAParsed?.detectedColumns.map((c) => (
                            <option key={c} value={c}>
                              {c}
                            </option>
                          ))}
                        </select>
                        <span>⟷ {link.sheetB}:</span>
                        <select
                          className="select"
                          style={{ padding: '3px 8px', fontSize: 11, width: 'auto' }}
                          value={selectedB}
                          onChange={(e) =>
                            setCustomSheetLinks((prev) => ({
                              ...prev,
                              [sB]: { colA: selectedA, colB: e.target.value },
                            }))
                          }
                        >
                          {sBParsed?.detectedColumns.map((c) => (
                            <option key={c} value={c}>
                              {c}
                            </option>
                          ))}
                        </select>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* Canvas Guide Labels */}
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              padding: '0 12px 14px',
              fontSize: 11,
              fontWeight: 700,
              textTransform: 'uppercase',
              letterSpacing: '0.06em',
              color: 'var(--text-muted)',
            }}
          >
            <div style={{ width: 280 }}>Category System Fields (Left)</div>
            <div style={{ flex: 1, textAlign: 'center' }}>Connection & Mapping Flow</div>
            <div style={{ width: 340 }}>Excel Sheet Columns (Right)</div>
          </div>

          {/* Zig-Zag Mapping Rows */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
            {activeFields.map((field, index) => {
              const isEven = index % 2 === 0;
              // Zig-zag staggered horizontal offset: one in (0px), one out (36px), another in (0px)...
              const leftOffset = isEven ? '0px' : '36px';
              const rightOffset = isEven ? '0px' : '36px';

              const currentTarget = parseTarget(fieldMapping[field.key]);
              const isMapped = Boolean(currentTarget && currentTarget.column);
              const mappedSheet = currentTarget?.sheet || '';
              const mappedCol = currentTarget?.column || '';

              // Samples from the sheet where the column was mapped:
              const sampleVals =
                isMapped && mappedSheet && mappedCol
                  ? parsedSheets[mappedSheet]?.columnSamples[mappedCol] || []
                  : [];

              return (
                <div
                  key={field.key}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 16,
                  }}
                >
                  {/* LEFT BOX: System Field */}
                  <div
                    style={{
                      width: 280,
                      flexShrink: 0,
                      marginLeft: leftOffset,
                      background: 'var(--bg-surface-2)',
                      border: isMapped ? '1px solid rgba(16, 185, 129, 0.4)' : '1px solid var(--border-medium)',
                      borderRadius: 'var(--radius-md)',
                      padding: '12px 14px',
                      position: 'relative',
                      boxShadow: 'var(--shadow-sm)',
                      transition: 'all 0.2s ease',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        {getFieldIcon(field.key)}
                        <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)' }}>
                          {field.label}
                        </span>
                      </div>
                      <span
                        className={field.required ? 'badge badge-rose' : 'badge badge-gold'}
                        style={{ fontSize: 9, padding: '2px 6px' }}
                      >
                        {field.required ? 'REQUIRED' : 'OPTIONAL'}
                      </span>
                    </div>

                    <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
                      {field.description}
                    </div>

                    {/* Right-edge connector anchor dot */}
                    <div
                      style={{
                        position: 'absolute',
                        right: -6,
                        top: '50%',
                        transform: 'translateY(-50%)',
                        width: 12,
                        height: 12,
                        borderRadius: '50%',
                        backgroundColor: isMapped ? '#10B981' : '#CBD5E1',
                        border: '2px solid var(--bg-surface-1)',
                      }}
                    />
                  </div>

                  {/* MIDDLE CONNECTOR: Dotted Arrow with Status */}
                  <div
                    style={{
                      flex: 1,
                      display: 'flex',
                      alignItems: 'center',
                      position: 'relative',
                      minWidth: 100,
                    }}
                  >
                    {/* Dotted horizontal line */}
                    <div
                      style={{
                        width: '100%',
                        height: 2,
                        borderTop: isMapped ? '2px dashed #10B981' : '2px dashed #94A3B8',
                        opacity: isMapped ? 0.9 : 0.4,
                      }}
                    />

                    {/* Middle Status Pill */}
                    <div
                      style={{
                        position: 'absolute',
                        left: '50%',
                        top: '50%',
                        transform: 'translate(-50%, -50%)',
                        background: 'var(--bg-surface-1)',
                        padding: '2px 8px',
                        borderRadius: 12,
                        border: isMapped ? '1px solid #10B981' : '1px solid #CBD5E1',
                        fontSize: 10,
                        fontWeight: 600,
                        whiteSpace: 'nowrap',
                        color: isMapped ? '#059669' : '#64748B',
                        display: 'flex',
                        alignItems: 'center',
                        gap: 4,
                      }}
                    >
                      {isMapped ? (
                        <>
                          <CheckCircle2 size={11} color="#10B981" />
                          <span>{mappedSheet ? `Mapped (${mappedSheet})` : 'Mapped'}</span>
                        </>
                      ) : (
                        <span>Manual Input</span>
                      )}
                    </div>

                    {/* Arrow head pointing into right box */}
                    <div
                      style={{
                        position: 'absolute',
                        right: 0,
                        top: '50%',
                        transform: 'translateY(-50%)',
                        color: isMapped ? '#10B981' : '#94A3B8',
                        display: 'flex',
                        alignItems: 'center',
                      }}
                    >
                      <ArrowRight size={14} />
                    </div>
                  </div>

                  {/* RIGHT BOX: Excel Column Dropdown */}
                  <div
                    style={{
                      width: 340,
                      flexShrink: 0,
                      marginLeft: rightOffset,
                      background: 'var(--bg-surface-2)',
                      border: isMapped ? '1px solid rgba(16, 185, 129, 0.4)' : '1px solid var(--border-medium)',
                      borderRadius: 'var(--radius-md)',
                      padding: '12px 14px',
                      position: 'relative',
                      boxShadow: 'var(--shadow-sm)',
                    }}
                  >
                    {/* Left-edge connector anchor dot */}
                    <div
                      style={{
                        position: 'absolute',
                        left: -6,
                        top: '50%',
                        transform: 'translateY(-50%)',
                        width: 12,
                        height: 12,
                        borderRadius: '50%',
                        backgroundColor: isMapped ? '#10B981' : '#CBD5E1',
                        border: '2px solid var(--bg-surface-1)',
                      }}
                    />

                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                      <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)' }}>
                        Excel Column Source
                      </span>
                      {isMapped ? (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <span
                            className="badge badge-gold"
                            style={{ fontSize: 9, padding: '1px 6px', fontWeight: 700 }}
                          >
                            Sheet: {mappedSheet}
                          </span>
                          <span style={{ fontSize: 10, color: '#059669', fontWeight: 600 }}>
                            ✓ Linked
                          </span>
                        </div>
                      ) : (
                        <span style={{ fontSize: 10, color: '#D97706', fontWeight: 600 }}>
                          Manual in Staging
                        </span>
                      )}
                    </div>

                    {/* Dropdown containing columns grouped by sheet */}
                    <select
                      className="select"
                      style={{
                        width: '100%',
                        fontSize: 12,
                        padding: '6px 8px',
                        background: 'var(--bg-surface-1)',
                        borderColor: isMapped ? '#10B981' : 'var(--border-medium)',
                      }}
                      value={fieldMapping[field.key] || ''}
                      onChange={(e) => {
                        const val = e.target.value ? e.target.value : null;
                        setFieldMapping((prev) => ({
                          ...prev,
                          [field.key]: val,
                        }));
                      }}
                    >
                      <option value="">-- None (Manual Input in Staging) --</option>
                      {sheetNames.map((sName) => {
                        const sParsed = parsedSheets[sName];
                        if (!sParsed || sParsed.detectedColumns.length === 0) return null;
                        const isCurrentActive = sName === activeSheet;
                        return (
                          <optgroup
                            key={sName}
                            label={`Sheet: ${sName}${isCurrentActive ? ' (Active)' : ''} — ${sParsed.detectedColumns.length} cols`}
                          >
                            {sParsed.detectedColumns.map((col) => {
                              const isBridge = Object.values(autoLinks).some(
                                (l) => (l.sheetA === sName && l.colA === col) || (l.sheetB === sName && l.colB === col)
                              );
                              return (
                                <option key={`${sName}::${col}`} value={serializeTarget(sName, col)}>
                                  {sName} ➔ {col}{isBridge ? ' (🔗 Bridge Key)' : ''}
                                </option>
                              );
                            })}
                          </optgroup>
                        );
                      })}
                    </select>

                    {/* Bottom Preview or Manual Helper */}
                    <div style={{ marginTop: 6, minHeight: 20 }}>
                      {isMapped ? (
                        <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>
                          From <span style={{ fontWeight: 600, color: 'var(--text-secondary)' }}>{mappedSheet}</span>:{' '}
                          <span style={{ color: 'var(--text-primary)', fontWeight: 600 }}>
                            {sampleVals.length > 0 ? sampleVals.slice(0, 3).join(', ') : '(empty)'}
                          </span>
                        </div>
                      ) : (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 10, color: '#B45309' }}>
                          <span>⚡ Leave blank or set default for all:</span>
                          <input
                            type="text"
                            placeholder={field.key === 'unit' ? 'PC' : field.key === 'low_stock_threshold' ? '10' : 'Value'}
                            style={{
                              width: 60,
                              padding: '2px 4px',
                              fontSize: 10,
                              borderRadius: 4,
                              border: '1px solid #FDE68A',
                              background: '#FFFBEB',
                            }}
                            value={manualDefaults[field.key] || ''}
                            onChange={(e) =>
                              setManualDefaults((prev) => ({
                                ...prev,
                                [field.key]: e.target.value,
                              }))
                            }
                          />
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Action Bar */}
          <div
            style={{
              marginTop: 32,
              paddingTop: 20,
              borderTop: '1px solid var(--border-subtle)',
              display: 'flex',
              flexWrap: 'wrap',
              justifyContent: 'space-between',
              alignItems: 'center',
              gap: 12,
            }}
          >
            <button
              onClick={() => {
                setParsedSheets({});
                setSheetNames([]);
                setActiveSheet('');
                setFieldMapping({});
                setManualDefaults({});
              }}
              className="btn btn-secondary"
            >
              <RefreshCw size={14} /> Upload Different File
            </button>

            <button onClick={handleConfirmMapping} className="btn btn-primary" style={{ padding: '10px 20px' }}>
              Proceed to Staging Queue <ArrowRight size={16} />
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
                <ArrowLeft size={14} /> Back to Mapping
              </button>
            </div>
          </div>

          {/* Quick Batch Fill Helper Tool (Specially useful for fields mapped to None) */}
          <div
            style={{
              background: 'var(--bg-surface-2)',
              border: '1px solid var(--border-subtle)',
              borderRadius: 'var(--radius-md)',
              padding: '10px 16px',
              marginBottom: 16,
              display: 'flex',
              flexWrap: 'wrap',
              alignItems: 'center',
              gap: 12,
              fontSize: 12,
            }}
          >
            <span style={{ fontWeight: 600, color: 'var(--text-secondary)' }}>
              ⚡ Quick Batch Fill (for unmapped cells):
            </span>
            <select
              className="select"
              style={{ width: 'auto', padding: '4px 8px', fontSize: 12 }}
              value={quickFillField}
              onChange={(e) => setQuickFillField(e.target.value)}
            >
              <option value="low_stock_threshold">Low Stock Threshold</option>
              {category === 'plated_jewelry' || category === 'raw_jewelry' ? (
                <option value="unit">Measurement Unit</option>
              ) : null}
              {category !== 'raw_jewelry' && <option value="cost_price">Cost Price (₹)</option>}
              <option value="quantity">Current Quantity</option>
            </select>
            <input
              type="text"
              className="input"
              style={{ width: 100, padding: '4px 8px', fontSize: 12 }}
              placeholder="Value"
              value={quickFillValue}
              onChange={(e) => setQuickFillValue(e.target.value)}
            />
            <button
              onClick={applyQuickFill}
              className="btn btn-secondary"
              style={{ padding: '4px 12px', fontSize: 11 }}
            >
              Apply to Empty Cells
            </button>
            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
              Fills empty or missing values across all uncommitted rows and triggers re-validation.
            </span>
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
