import React, { useEffect, useMemo, useRef, useState } from 'react';
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
  XCircle,
  Info,
  X,
} from 'lucide-react';
import * as XLSX from 'xlsx';
import { api } from '../api';
import { useToast } from '../context/ToastContext';
import { errorText, isDailyLimitError } from '../utils/friendlyErrors';
import { localDb } from '../lib/localDb';
import { syncEngine } from '../lib/syncEngine';
import { blockIfOffline } from '../utils/offlineGuard';
import { itemKey } from '../utils/itemId';
import { parseExcelWorksheet, CATEGORY_FIELDS, type ParsedExcelResult } from '../utils/excelParser';
import {
  CATEGORY_LABEL,
  FIELD_LABEL,
  autoMatch,
  buildRows,
  checkRow,
  codeText,
  duplicateIndex,
  fieldsFor,
  fixedUnit,
  guessLinkColumn,
  hasCost,
  mappingIssues,
  readNumber,
  readUnit,
  splitTarget,
  summarize,
  target,
  type FieldMatch,
  type ImportCategory,
  type ImportField,
  type RowCheck,
  type StagedRow,
} from '../utils/excelImport';

/**
 * Excel import (rebuilt 2026-11-21). Three steps: 1. choose the file, 2. match columns (the zig-zag board),
 * 3. check every row and save. All rules live in utils/excelImport.ts (unit-tested); the server checks every row
 * again (routes/excel.ts). Rows are saved 50 at a time; each row carries its own id so a retry never doubles an item.
 */

const UNITS = ['PC', 'KGS', 'SET', 'JODI', 'GRMS'] as const;
const SAVE_BATCH = 50;
const CHECK_BATCH = 500;
const PAGE = 200;

const uuid = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
      });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const inr = (n: number) => `₹${n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

type Filter = 'all' | 'fix' | 'warn' | 'ready' | 'saved';
interface SaveReport {
  saved: number;
  attempted: number;
  notSaved: { rowNumber: number; code: string; message: string }[];
  stoppedReason?: string;
}

function fieldIcon(key: ImportField) {
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
  }
}

export const ExcelImportView: React.FC = () => {
  const { showToast } = useToast();

  const [category, setCategory] = useState<ImportCategory>('plated_jewelry');
  const [fileName, setFileName] = useState('');
  const [sheets, setSheets] = useState<Record<string, ParsedExcelResult>>({});
  const [sheetNames, setSheetNames] = useState<string[]>([]);
  const [activeSheet, setActiveSheet] = useState('');
  const [mapping, setMapping] = useState<Record<ImportField, FieldMatch>>({} as Record<ImportField, FieldMatch>);
  const [confirmed, setConfirmed] = useState<Set<ImportField>>(new Set());
  const [defaults, setDefaults] = useState<Partial<Record<ImportField, string>>>({});
  const [linkColumns, setLinkColumns] = useState<Record<string, string>>({});
  const [showLinkConfig, setShowLinkConfig] = useState(false);
  const [step, setStep] = useState<'upload' | 'map' | 'review'>('upload');

  const [rows, setRows] = useState<StagedRow[]>([]);
  const [checking, setChecking] = useState<{ done: number; total: number } | null>(null);
  const [checkFailed, setCheckFailed] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [shown, setShown] = useState(PAGE);
  const [fillField, setFillField] = useState<ImportField>('low_stock_threshold');
  const [fillValue, setFillValue] = useState('');
  const [showSummary, setShowSummary] = useState(false);
  const [saving, setSaving] = useState<{ done: number; total: number } | null>(null);
  const [report, setReport] = useState<SaveReport | null>(null);
  const savingRef = useRef(false);

  const fields = fieldsFor(category);
  const hasFile = sheetNames.length > 0;

  // Don't let the page be closed in the middle of saving
  useEffect(() => {
    if (!saving) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [saving]);

  // ── Step 1: file ───────────────────────────────────────────────────────────────────────────────────────────
  const resetAll = () => {
    setSheets({});
    setSheetNames([]);
    setActiveSheet('');
    setMapping({} as Record<ImportField, FieldMatch>);
    setConfirmed(new Set());
    setDefaults({});
    setLinkColumns({});
    setRows([]);
    setReport(null);
    setStep('upload');
    setFileName('');
  };

  const applyAutoMatch = (cat: ImportCategory, parsed: Record<string, ParsedExcelResult>, primary: string) => {
    const m = autoMatch(cat, parsed, primary);
    setMapping(m);
    setConfirmed(new Set());
    setDefaults({});
    setLinkColumns(autoLinks(cat, parsed, m, {}));
  };

  /** For every other sheet a field is taken from: which of its columns holds the design codes. */
  const autoLinks = (cat: ImportCategory, parsed: Record<string, ParsedExcelResult>, m: Record<ImportField, FieldMatch>, current: Record<string, string>) => {
    const id = splitTarget(m.item_id?.target);
    const out: Record<string, string> = {};
    if (!id) return out;
    for (const f of fieldsFor(cat)) {
      const t = splitTarget(m[f]?.target);
      if (!t || t.sheet === id.sheet || out[t.sheet]) continue;
      out[t.sheet] = current[t.sheet] || guessLinkColumn(parsed, id.sheet, id.column, t.sheet) || '';
    }
    return out;
  };

  const handleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      let wb: XLSX.WorkBook;
      if (/\.(csv|txt)$/i.test(file.name)) {
        // CSV: every value is taken as text, exactly as written (no number or date conversion: "00123", "10-12" stay)
        wb = XLSX.read(await file.text(), { type: 'string', raw: true });
      } else {
        wb = XLSX.read(await file.arrayBuffer(), { type: 'array', cellNF: true });
      }
      const parsed: Record<string, ParsedExcelResult> = {};
      const skipped: string[] = [];
      for (const name of wb.SheetNames || []) {
        try {
          const p = parseExcelWorksheet(wb.Sheets[name], name);
          if (p.detectedColumns.length > 0) parsed[name] = p;
        } catch {
          skipped.push(name);
        }
      }
      const names = Object.keys(parsed);
      if (names.length === 0) {
        showToast('error', 'Nothing to import', 'No sheet in this file has column headings (like "Design Code", "Qty"). Check the file and try again.');
        return;
      }
      // The sheet with the most rows is most likely the stock list
      const primary = names.reduce((a, b) => (parsed[b].rows.length > parsed[a].rows.length ? b : a), names[0]);
      setFileName(file.name);
      setSheets(parsed);
      setSheetNames(names);
      setActiveSheet(primary);
      applyAutoMatch(category, parsed, primary);
      setRows([]);
      setReport(null);
      setStep('map');
      showToast(
        'info',
        'File read',
        `${names.length} sheet${names.length === 1 ? '' : 's'} with data. "${primary}": ${parsed[primary].rows.length} rows.` +
          (skipped.length ? ` Skipped (no column headings): ${skipped.join(', ')}.` : ''),
      );
    } catch (err: any) {
      const msg = /password/i.test(String(err?.message))
        ? 'This file is password-protected. Remove the password in Excel and try again.'
        : 'This file could not be read. Open it in Excel, save it as .xlsx, and try again.';
      showToast('error', 'File not read', msg);
    }
  };

  const handleCategoryChange = (cat: ImportCategory) => {
    setCategory(cat);
    setRows([]);
    setReport(null);
    if (hasFile) {
      applyAutoMatch(cat, sheets, activeSheet);
      setStep('map');
    }
  };

  const handleSelectSheet = (name: string) => {
    setActiveSheet(name);
    // Fields the user has not set themselves are matched again, preferring this sheet
    const fresh = autoMatch(category, sheets, name);
    const next = { ...mapping };
    for (const f of fields) if (mapping[f]?.how !== 'user') next[f] = fresh[f];
    setMapping(next);
    setConfirmed((prev) => new Set([...prev].filter((f) => mapping[f]?.how === 'user')));
    setLinkColumns(autoLinks(category, sheets, next, linkColumns));
  };

  const setFieldTarget = (f: ImportField, t: string | null) => {
    const next = { ...mapping, [f]: { target: t, how: t ? 'user' : 'none' } as FieldMatch };
    setMapping(next);
    setConfirmed((prev) => {
      const s = new Set(prev);
      s.delete(f);
      return s;
    });
    setLinkColumns(autoLinks(category, sheets, next, linkColumns));
  };

  // ── Step 2: matching checks ───────────────────────────────────────────────────────────────────────────────
  const issues = useMemo(() => {
    if (!hasFile || !mapping.item_id) return [];
    const list = mappingIssues(category, sheets, mapping, defaults);
    const id = splitTarget(mapping.item_id?.target);
    for (const [sheet, col] of Object.entries(linkColumns)) {
      const f = fields.find((x) => splitTarget(mapping[x]?.target)?.sheet === sheet) as ImportField;
      if (!col) list.push({ field: f, level: 'block', message: `Choose which column in sheet "${sheet}" has the design codes, so each design's values can be found there.` });
      else if (id) {
        const keys = new Set(sheets[sheet]?.rows.map((r) => itemKey(codeText(r.cells[col]))).filter(Boolean));
        const total = sheets[id.sheet]?.rows.length ?? 0;
        const found = sheets[id.sheet]?.rows.filter((r) => keys.has(itemKey(codeText(r.cells[id.column])))).length ?? 0;
        if (found < total) {
          list.push({ field: f, level: 'check', message: `Only ${found} of ${total} designs were found in sheet "${sheet}" (by column "${col}"). The others will be marked "not found".` });
        }
      }
    }
    return list;
  }, [hasFile, category, sheets, mapping, defaults, linkColumns, fields]);

  const blockers = issues.filter((i) => i.level === 'block');
  const toConfirm = [...new Set(issues.filter((i) => i.level === 'check').map((i) => i.field))].filter((f) => !confirmed.has(f));
  const canContinue = blockers.length === 0 && toConfirm.length === 0;

  // ── Step 3: rows ───────────────────────────────────────────────────────────────────────────────────────────
  const checks = useMemo(() => {
    const first = duplicateIndex(rows);
    return new Map<string, RowCheck>(rows.map((r) => [r.key, checkRow(r, category, first)]));
  }, [rows, category]);

  const counts = useMemo(() => {
    let fix = 0, warn = 0, ready = 0, saved = 0;
    for (const r of rows) {
      if (r.status === 'saved') saved++;
      else if (!checks.get(r.key)?.save) fix++;
      else {
        ready++;
        if (checks.get(r.key)!.warnings.length) warn++;
      }
    }
    return { fix, warn, ready, saved };
  }, [rows, checks]);

  /** Asks the server which design codes already exist; the answer is stored per row with the code it was for. */
  const checkExisting = async (subset?: StagedRow[]) => {
    const list = (subset || rows).filter((r) => r.status !== 'saved' && r.values.item_id.trim());
    if (list.length === 0) return;
    if (!subset) setChecking({ done: 0, total: list.length });
    setCheckFailed(null);
    try {
      for (let i = 0; i < list.length; i += CHECK_BATCH) {
        const part = list.slice(i, i + CHECK_BATCH);
        const codes = part.map((r) => r.values.item_id.trim());
        const res = await api.excel.checkRows(category, codes);
        const byKey = new Map(part.map((r) => [r.key, r.values.item_id.trim()]));
        setRows((prev) =>
          prev.map((r) => {
            const code = byKey.get(r.key);
            if (code === undefined || r.values.item_id.trim() !== code) return r; // edited meanwhile
            const msg = res.existing[code];
            return { ...r, exists: msg ? { code, message: msg } : undefined };
          }),
        );
        if (!subset) setChecking({ done: Math.min(i + CHECK_BATCH, list.length), total: list.length });
      }
    } catch (err) {
      setCheckFailed(`Could not check which designs already exist: ${errorText(err)} Rows are still checked again when you save.`);
    } finally {
      if (!subset) setChecking(null);
    }
  };

  const proceedToReview = async () => {
    if (!canContinue) return;
    if (blockIfOffline(showToast, 'Excel import')) return;
    const built = buildRows({ category, sheets, mapping, defaults, linkColumns, makeId: uuid });
    if (built.length === 0) {
      showToast('warning', 'No rows found', 'The sheet with the design codes has no data rows under its headings.');
      return;
    }
    needsCheck.current = true;
    setRows(built);
    setFilter('all');
    setShown(PAGE);
    setReport(null);
    setStep('review');
  };

  // Check codes against the cloud once, right after the rows are built
  const needsCheck = useRef(false);
  useEffect(() => {
    if (step === 'review' && needsCheck.current && rows.length) {
      needsCheck.current = false;
      void checkExisting();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, rows]);

  /** Edit one cell. Always applied to the latest rows (no stale copies), then the row is checked again at once. */
  const editRow = (key: string, f: ImportField, value: string) => {
    setRows((prev) =>
      prev.map((r) =>
        r.key !== key
          ? r
          : {
              ...r,
              values: { ...r.values, [f]: value },
              notes: { ...r.notes, [f]: undefined },
              fileProblems: { ...r.fileProblems, [f]: undefined },
              fileWarnings: { ...r.fileWarnings, [f]: undefined },
              status: r.status === 'failed' ? 'pending' : r.status,
              saveMessage: r.status === 'failed' ? undefined : r.saveMessage,
            },
      ),
    );
  };

  const recheckCode = (key: string) => {
    const r = rows.find((x) => x.key === key);
    if (r && r.values.item_id.trim() && (!r.exists || r.exists.code !== r.values.item_id.trim())) void checkExisting([r]);
  };

  const removeRow = (key: string) => setRows((prev) => prev.filter((r) => r.key !== key));

  const fillError = useMemo(() => {
    if (!fillValue.trim()) return null;
    if (fillField === 'unit') return readUnit(fillValue) === 'unknown' || readUnit(fillValue) === null ? `"${fillValue}" is not a unit. Use PC, KGS, SET, JODI or GRMS.` : null;
    const r = readNumber(fillValue, FIELD_LABEL[fillField]);
    if (!r.ok) return `"${fillValue}" is not a number.`;
    if (r.value < 0) return 'The value can’t be negative.';
    if (fillField !== 'cost_price' && category !== 'foil' && !Number.isInteger(r.value)) return `${CATEGORY_LABEL[category]} is counted in whole numbers.`;
    return null;
  }, [fillField, fillValue, category]);

  const applyFill = () => {
    if (!fillValue.trim() || fillError) return;
    const v = fillField === 'unit' ? (readUnit(fillValue) as string) : fillValue.trim();
    let n = 0;
    setRows((prev) =>
      prev.map((r) => {
        if (r.status === 'saved' || r.values[fillField].trim() !== '') return r;
        n++;
        return { ...r, values: { ...r.values, [fillField]: v }, fileProblems: { ...r.fileProblems, [fillField]: undefined }, notes: { ...r.notes, [fillField]: undefined } };
      }),
    );
    setTimeout(() => showToast('info', 'Empty cells filled', n ? `${FIELD_LABEL[fillField]} set to ${v} in ${n} row${n === 1 ? '' : 's'} where it was empty.` : `No row had an empty ${FIELD_LABEL[fillField].toLowerCase()}.`), 0);
  };

  const summary = useMemo(() => summarize(category, rows, checks), [category, rows, checks]);

  // ── Saving ─────────────────────────────────────────────────────────────────────────────────────────────────
  const saveAll = async () => {
    if (savingRef.current) return;
    setShowSummary(false);
    if (blockIfOffline(showToast, 'Saving the import')) return;
    const toSave = rows.filter((r) => r.status !== 'saved' && checks.get(r.key)?.save);
    if (toSave.length === 0) return;
    savingRef.current = true;
    setSaving({ done: 0, total: toSave.length });
    setReport(null);
    const outcome = new Map<string, { status: 'saved' | 'failed'; message?: string }>();
    let stoppedReason: string | undefined;

    for (let i = 0; i < toSave.length; i += SAVE_BATCH) {
      const part = toSave.slice(i, i + SAVE_BATCH);
      const payload = part.map((r) => checks.get(r.key)!.save!);
      let answer: Awaited<ReturnType<typeof api.excel.saveRows>> | null = null;
      for (let attempt = 0; attempt < 4 && !answer; attempt++) {
        try {
          answer = await api.excel.saveRows(category, payload);
        } catch (err: any) {
          const status = Number(err?.status || 0);
          if (isDailyLimitError(err)) {
            stoppedReason = errorText(err);
            break;
          }
          const network = !status || status >= 500;
          if (!network || attempt === 3) {
            stoppedReason = network ? `${errorText(err)} The remaining rows were not sent.` : errorText(err);
            break;
          }
          await sleep([1500, 4000, 8000][attempt]); // bad connection: try the same rows again (never doubled: same ids)
        }
      }
      if (!answer) {
        for (const r of toSave.slice(i)) outcome.set(r.key, { status: 'failed', message: `Not saved: ${stoppedReason}` });
        break;
      }
      const saved: Record<string, any>[] = [];
      answer.results.forEach((res, j) => {
        const r = part[j];
        if (res.status === 'saved') {
          outcome.set(r.key, { status: 'saved' });
          if (res.item) saved.push({ ...res.item, cost_price: typeof res.item.cost_price_cents === 'number' ? res.item.cost_price_cents / 100 : undefined });
        } else outcome.set(r.key, { status: 'failed', message: res.message || 'Not saved.' });
      });
      if (saved.length) {
        try {
          await localDb.bulkUpsert(category, saved);
          window.dispatchEvent(new CustomEvent('localdb-change', { detail: { store: category } }));
        } catch {
          /* the cloud has them; this phone gets them at the next sync */
        }
      }
      setRows((prev) => prev.map((r) => (outcome.has(r.key) ? { ...r, status: outcome.get(r.key)!.status, saveMessage: outcome.get(r.key)!.message } : r)));
      setSaving({ done: Math.min(i + SAVE_BATCH, toSave.length), total: toSave.length });
    }

    setRows((prev) => prev.map((r) => (outcome.has(r.key) ? { ...r, status: outcome.get(r.key)!.status, saveMessage: outcome.get(r.key)!.message } : r)));
    syncEngine.triggerSync().catch(() => undefined);
    const notSaved = toSave
      .filter((r) => outcome.get(r.key)?.status !== 'saved')
      .map((r) => ({ rowNumber: r.rowNumber, code: r.values.item_id.trim(), message: outcome.get(r.key)?.message || 'Not saved.' }));
    const savedCount = toSave.length - notSaved.length;
    setReport({ saved: savedCount, attempted: toSave.length, notSaved, stoppedReason });
    const label = CATEGORY_LABEL[category];
    if (notSaved.length === 0) showToast('success', 'Import saved', `All ${savedCount} design${savedCount === 1 ? '' : 's'} were saved to ${label}.`);
    else if (savedCount === 0) showToast('error', 'Nothing was saved', `None of the ${toSave.length} designs were saved. See the reasons above the rows.`);
    else showToast('warning', 'Partly saved', `${savedCount} of ${toSave.length} designs were saved to ${label}. ${notSaved.length} were not; see the reasons above the rows.`);
    setFilter(notSaved.length ? 'fix' : 'all');
    setSaving(null);
    savingRef.current = false;
  };

  // ── Rendering helpers ──────────────────────────────────────────────────────────────────────────────────────
  const visibleRows = rows.filter((r) => {
    const c = checks.get(r.key);
    if (filter === 'saved') return r.status === 'saved';
    if (filter === 'fix') return r.status !== 'saved' && !c?.save;
    if (filter === 'warn') return r.status !== 'saved' && !!c?.save && c.warnings.length > 0;
    if (filter === 'ready') return r.status !== 'saved' && !!c?.save;
    return true;
  });
  const fieldDef = (f: ImportField) => CATEGORY_FIELDS[category]?.find((d) => d.key === f);
  const busy = !!saving;

  return (
    <div className="view-container">
      {/* Title */}
      <div style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <FileSpreadsheet size={24} color="var(--gold-primary)" />
          <h2 style={{ fontSize: 22, fontWeight: 700 }}>Excel Import & Safe Staging Queue</h2>
        </div>
        <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 4 }}>
          Automatic column identification (skipping headers), interactive zig-zag visual mapping, and safe D1 staging.
        </p>
      </div>

      {/* Steps */}
      <div className="xl-steps">
        {(['upload', 'map', 'review'] as const).map((s, i) => {
          const done = (['upload', 'map', 'review'] as const).indexOf(step) > i;
          return (
            <div key={s} className={`xl-step ${step === s ? 'active' : ''} ${done ? 'done' : ''}`}>
              <span className="xl-step-n">{done ? '✓' : i + 1}</span>
              {s === 'upload' ? 'Choose file' : s === 'map' ? 'Match columns' : 'Check & save'}
            </div>
          );
        })}
      </div>

      {/* Category */}
      <div className="xl-card" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12 }}>
        <span style={{ fontSize: 13, fontWeight: 600 }}>Import into:</span>
        <select
          className="select"
          style={{ width: 'auto', minWidth: 200 }}
          value={category}
          onChange={(e) => handleCategoryChange(e.target.value as ImportCategory)}
          disabled={step === 'review' || busy}
          title={step === 'review' ? 'Go back to "Match columns" to change the category' : undefined}
        >
          <option value="plated_jewelry">Plated Jewelry</option>
          <option value="raw_jewelry">Raw Jewelry</option>
          <option value="stones">Kundan Stone</option>
          <option value="foil">Foil</option>
        </select>
        <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
          Needs: {fields.map((f) => FIELD_LABEL[f]).join(', ')}.
          {fixedUnit(category) ? ` Unit is always ${fixedUnit(category)}.` : ' No unit in the file = PC.'} Import only adds new designs; existing ones are never changed.
        </span>
      </div>

      {/* Step 1 */}
      {step === 'upload' && (
        <div
          className="xl-drop"
          onClick={() => document.getElementById('excel-file-input')?.click()}
          role="button"
          tabIndex={0}
        >
          <Upload size={40} color="var(--gold-primary)" style={{ margin: '0 auto 12px' }} />
          <h3 style={{ fontSize: 17, fontWeight: 600 }}>Choose your Excel file (.xlsx, .xls or .csv)</h3>
          <p style={{ fontSize: 13, color: 'var(--text-secondary)', maxWidth: 520, margin: '6px auto 0' }}>
            Titles above the column headings are skipped automatically. Nothing is saved until you check the rows and tap Save.
          </p>
          <input id="excel-file-input" type="file" accept=".xlsx,.xls,.csv" style={{ display: 'none' }} onChange={handleFile} />
        </div>
      )}

      {/* Step 2: zig-zag board */}
      {step === 'map' && hasFile && (
        <div className="xl-card" style={{ padding: 24 }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 12, paddingBottom: 16, borderBottom: '1px solid var(--border-subtle)', marginBottom: 20 }}>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Sparkles size={18} color="var(--gold-primary)" />
                <h3 style={{ fontSize: 16, fontWeight: 700 }}>Interactive Column Mapping Board</h3>
              </div>
              <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 2 }}>
                Check that each field takes the right Excel column. Example values from your file are shown under each one.
              </p>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6 }}>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                <span className="badge badge-gold">File: {fileName}</span>
                <span className="badge badge-indigo">{sheets[activeSheet]?.rows.length ?? 0} rows in "{activeSheet}"</span>
                {(sheets[activeSheet]?.headerRowNumber ?? 1) > 1 && <span className="badge badge-rose">Headings found on row {sheets[activeSheet].headerRowNumber}</span>}
              </div>
              {sheetNames.length > 1 && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-secondary)' }}>Sheet with your designs:</span>
                  {sheetNames.map((s) => (
                    <button key={s} type="button" onClick={() => handleSelectSheet(s)} className={`xl-sheet ${activeSheet === s ? 'active' : ''}`}>
                      {s} <span className="xl-sheet-n">{sheets[s].rows.length} rows</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Second sheets: matched by design code */}
          {Object.keys(linkColumns).length > 0 && (
            <div className="xl-bridge">
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', flex: 1 }}>
                <Link2 size={16} color="var(--gold-primary)" />
                <div style={{ fontSize: 12 }}>
                  <strong>Values from another sheet</strong> are found by design code (capitals, spaces and dashes ignored), never by row position.
                </div>
                {Object.entries(linkColumns).map(([s, c]) => (
                  <span key={s} className="badge badge-gold" style={{ fontSize: 11 }}>
                    {splitTarget(mapping.item_id?.target)?.column} ⟷ {s} [{c || 'choose'}]
                  </span>
                ))}
              </div>
              <button type="button" className="btn btn-secondary" style={{ fontSize: 11, padding: '4px 10px' }} onClick={() => setShowLinkConfig(!showLinkConfig)}>
                {showLinkConfig ? 'Done' : 'Change link column'}
              </button>
              {showLinkConfig && (
                <div style={{ width: '100%', display: 'flex', flexWrap: 'wrap', gap: 12, paddingTop: 10, fontSize: 12 }}>
                  {Object.entries(linkColumns).map(([s, c]) => (
                    <label key={s} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      Design codes in "{s}":
                      <select className="select" style={{ width: 'auto', fontSize: 12, padding: '3px 8px' }} value={c} onChange={(e) => setLinkColumns((p) => ({ ...p, [s]: e.target.value }))}>
                        <option value="">— choose —</option>
                        {sheets[s]?.detectedColumns.map((col) => (
                          <option key={col} value={col}>{col}</option>
                        ))}
                      </select>
                    </label>
                  ))}
                </div>
              )}
            </div>
          )}

          <div className="xl-board-head">
            <div style={{ width: 280 }}>App fields</div>
            <div style={{ flex: 1, textAlign: 'center' }}>Connection</div>
            <div style={{ width: 340 }}>Excel columns</div>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
            {fields.map((f, index) => {
              const offset = index % 2 === 0 ? '0px' : '36px';
              const m = mapping[f];
              const t = splitTarget(m?.target);
              const isMapped = !!t;
              const fieldIssues = issues.filter((i) => i.field === f);
              const blocked = fieldIssues.some((i) => i.level === 'block');
              const needsCheck = fieldIssues.some((i) => i.level === 'check');
              const ok = confirmed.has(f);
              const state = blocked ? 'block' : needsCheck && !ok ? 'check' : isMapped ? 'ok' : 'none';
              const color = state === 'block' ? '#DC2626' : state === 'check' ? '#D97706' : state === 'ok' ? '#10B981' : '#94A3B8';
              const samples = t ? sheets[t.sheet]?.columnSamples[t.column] || [] : [];
              const def = fieldDef(f);
              return (
                <div key={f}>
                  <div className="xl-row">
                    <div className="xl-left" style={{ marginLeft: offset, borderColor: color }}>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          {fieldIcon(f)}
                          <span style={{ fontSize: 13, fontWeight: 700 }}>{def?.label || FIELD_LABEL[f]}</span>
                        </div>
                        <span className="badge badge-rose" style={{ fontSize: 9, padding: '2px 6px' }}>REQUIRED</span>
                      </div>
                      <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{def?.description}</div>
                      <div className="xl-dot right" style={{ background: color }} />
                    </div>

                    <div className="xl-connector">
                      <div style={{ width: '100%', borderTop: `2px dashed ${color}`, opacity: isMapped ? 0.9 : 0.4 }} />
                      <div className="xl-pill" style={{ borderColor: color, color }}>
                        {state === 'ok' && <><CheckCircle2 size={11} /> {m?.how === 'user' ? 'Chosen by you' : ok ? 'Confirmed' : 'Matched'}</>}
                        {state === 'check' && <><AlertTriangle size={11} /> Please check</>}
                        {state === 'block' && <><XCircle size={11} /> Fix this</>}
                        {state === 'none' && <>Not in file</>}
                      </div>
                      <div style={{ position: 'absolute', right: 0, color, display: 'flex' }}><ArrowRight size={14} /></div>
                    </div>

                    <div className="xl-right" style={{ marginLeft: offset, borderColor: color }}>
                      <div className="xl-dot left" style={{ background: color }} />
                      <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 6 }}>Excel column</div>
                      <select
                        className="select"
                        style={{ width: '100%', fontSize: 12, padding: '6px 8px', borderColor: color }}
                        value={m?.target || ''}
                        onChange={(e) => setFieldTarget(f, e.target.value || null)}
                      >
                        <option value="">{f === 'item_id' ? '— choose the design code column —' : '— Not in the file —'}</option>
                        {sheetNames.map((s) => (
                          <optgroup key={s} label={`Sheet "${s}"`}>
                            {sheets[s].detectedColumns.map((col) => (
                              <option key={col} value={target(s, col)}>{sheetNames.length > 1 ? `${s} ➔ ` : ''}{col}</option>
                            ))}
                          </optgroup>
                        ))}
                      </select>
                      <div style={{ marginTop: 6, fontSize: 11, color: 'var(--text-muted)' }}>
                        {isMapped ? (
                          <>Examples: <strong style={{ color: 'var(--text-primary)' }}>{samples.length ? samples.slice(0, 3).join(', ') : '(empty)'}</strong></>
                        ) : f === 'unit' ? (
                          <span>Every row will be <strong>PC</strong> unless you type another unit here:{' '}
                            <input className="xl-default" placeholder="PC" value={defaults.unit || ''} onChange={(e) => setDefaults((p) => ({ ...p, unit: e.target.value }))} />
                          </span>
                        ) : f !== 'item_id' ? (
                          <span>Same value for every row (optional):{' '}
                            <input className="xl-default" placeholder={f === 'low_stock_threshold' ? 'e.g. 10' : 'value'} value={defaults[f] || ''} onChange={(e) => setDefaults((p) => ({ ...p, [f]: e.target.value }))} />
                            {!defaults[f] && <span> — or type it per row in the next step.</span>}
                          </span>
                        ) : null}
                      </div>
                    </div>
                  </div>

                  {fieldIssues.length > 0 && (
                    <div className={`xl-issues ${blocked ? 'block' : 'check'}`}>
                      {fieldIssues.map((i, k) => (
                        <div key={k} style={{ display: 'flex', gap: 6 }}>
                          {i.level === 'block' ? <XCircle size={13} style={{ flexShrink: 0, marginTop: 2 }} /> : <AlertTriangle size={13} style={{ flexShrink: 0, marginTop: 2 }} />}
                          <span>{i.message}</span>
                        </div>
                      ))}
                      {!blocked && (
                        <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 6, fontWeight: 600, cursor: 'pointer' }}>
                          <input
                            type="checkbox"
                            checked={ok}
                            onChange={(e) =>
                              setConfirmed((p) => {
                                const s = new Set(p);
                                if (e.target.checked) s.add(f);
                                else s.delete(f);
                                return s;
                              })
                            }
                          />
                          {isMapped ? `Yes, "${t!.column}" is the right column for ${FIELD_LABEL[f]}` : 'Yes, continue'}
                        </label>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          <div style={{ marginTop: 28, paddingTop: 18, borderTop: '1px solid var(--border-subtle)', display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
            <button onClick={resetAll} className="btn btn-secondary">
              <RefreshCw size={14} /> Choose a different file
            </button>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
              {!canContinue && (
                <span style={{ fontSize: 12, color: blockers.length ? '#DC2626' : '#B45309', maxWidth: 420 }}>
                  {blockers.length
                    ? `Fix ${blockers.length} item${blockers.length === 1 ? '' : 's'} marked "Fix this" to continue.`
                    : `Confirm or change ${toConfirm.length} field${toConfirm.length === 1 ? '' : 's'} marked "Please check": ${toConfirm.map((f) => FIELD_LABEL[f]).join(', ')}.`}
                </span>
              )}
              <button onClick={proceedToReview} className="btn btn-primary" style={{ padding: '10px 20px' }} disabled={!canContinue}>
                Continue: check the rows <ArrowRight size={16} />
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Step 3: rows */}
      {step === 'review' && (
        <div>
          <div className="xl-card" style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {([
                ['all', `All ${rows.length}`],
                ['fix', `Needs fixing ${counts.fix}`],
                ['warn', `Warnings ${counts.warn}`],
                ['ready', `Ready ${counts.ready}`],
                ['saved', `Saved ${counts.saved}`],
              ] as [Filter, string][]).map(([k, l]) => (
                <button key={k} type="button" className={`xl-filter ${filter === k ? 'active' : ''} ${k}`} onClick={() => { setFilter(k); setShown(PAGE); }}>
                  {l}
                </button>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              <button onClick={() => setShowSummary(true)} className="btn btn-primary" disabled={counts.ready === 0 || busy || !!checking}>
                {busy ? <><Loader2 size={14} className="animate-spin" /> Saving {saving!.done} of {saving!.total}…</> : <><Save size={15} /> Save {counts.ready} design{counts.ready === 1 ? '' : 's'}</>}
              </button>
              <button onClick={() => setStep('map')} className="btn btn-secondary" disabled={busy}>
                <ArrowLeft size={14} /> Back to matching
              </button>
            </div>
          </div>

          {checking && (
            <div className="xl-note"><Loader2 size={14} className="animate-spin" /> Checking which designs already exist in the cloud… {checking.done} of {checking.total}</div>
          )}
          {checkFailed && (
            <div className="xl-note warn">
              <AlertTriangle size={14} /> {checkFailed}
              <button className="btn btn-secondary" style={{ fontSize: 11, padding: '3px 10px', marginLeft: 8 }} onClick={() => void checkExisting()}>Check again</button>
            </div>
          )}
          {counts.fix > 0 && !report && (
            <div className="xl-note warn">
              <AlertTriangle size={14} /> {counts.fix} row{counts.fix === 1 ? '' : 's'} need{counts.fix === 1 ? 's' : ''} fixing and won’t be saved until fixed. Edit them below (tap “Needs fixing”), or remove them with the bin.
            </div>
          )}

          {report && (
            <div className={`xl-report ${report.notSaved.length === 0 ? 'ok' : report.saved === 0 ? 'bad' : 'part'}`}>
              <button className="xl-report-x" onClick={() => setReport(null)} aria-label="Close"><X size={14} /></button>
              <strong>
                {report.notSaved.length === 0
                  ? `All ${report.saved} design${report.saved === 1 ? '' : 's'} were saved to ${CATEGORY_LABEL[category]}.`
                  : report.saved === 0
                    ? `None of the ${report.attempted} designs were saved.`
                    : `Saved ${report.saved} of ${report.attempted} designs to ${CATEGORY_LABEL[category]}. ${report.notSaved.length} were not saved:`}
              </strong>
              {report.stoppedReason && <div style={{ marginTop: 4 }}>Stopped: {report.stoppedReason}</div>}
              {report.notSaved.length > 0 && (
                <ul style={{ margin: '6px 0 0 18px' }}>
                  {report.notSaved.slice(0, 10).map((x) => (
                    <li key={x.rowNumber + x.code}>Row {x.rowNumber}{x.code ? ` · ${x.code}` : ''}: {x.message.replace(/^Not saved: /, '')}</li>
                  ))}
                  {report.notSaved.length > 10 && <li>…and {report.notSaved.length - 10} more (shown under “Needs fixing”).</li>}
                </ul>
              )}
              {report.notSaved.length > 0 && <div style={{ marginTop: 6 }}>These rows stay below: fix them and tap Save again. Saved rows are never saved twice.</div>}
            </div>
          )}

          {/* Fill empty cells */}
          <div className="xl-fill">
            <span style={{ fontWeight: 600 }}>Fill empty cells:</span>
            <select className="select" style={{ width: 'auto', padding: '4px 8px', fontSize: 12 }} value={fillField} onChange={(e) => setFillField(e.target.value as ImportField)}>
              {fields.filter((f) => f !== 'item_id' && !(f === 'unit' && fixedUnit(category))).map((f) => (
                <option key={f} value={f}>{FIELD_LABEL[f]}</option>
              ))}
            </select>
            <input className="input" style={{ width: 110, padding: '4px 8px', fontSize: 12 }} placeholder={fillField === 'unit' ? 'e.g. PC' : 'e.g. 10'} value={fillValue} onChange={(e) => setFillValue(e.target.value)} />
            <button onClick={applyFill} className="btn btn-secondary" style={{ padding: '4px 12px', fontSize: 11 }} disabled={!fillValue.trim() || !!fillError || busy}>
              Fill
            </button>
            <span style={{ fontSize: 11, color: fillError ? '#DC2626' : 'var(--text-muted)' }}>
              {fillError || 'Only empty cells of rows not yet saved are filled. Nothing else changes.'}
            </span>
          </div>

          <div className="table-container">
            <table className="data-table xl-table">
              <thead>
                <tr>
                  <th>Excel row</th>
                  <th>Design code</th>
                  <th>Quantity</th>
                  <th>Unit</th>
                  <th>Low stock level</th>
                  {hasCost(category) && <th>Cost (₹)</th>}
                  <th style={{ minWidth: 260 }}>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {visibleRows.slice(0, shown).map((r) => {
                  const c = checks.get(r.key)!;
                  const saved = r.status === 'saved';
                  const bad = (f: ImportField) => c.problems.some((p) => p.field === f);
                  const cell = (f: ImportField, width: number) => (
                    <input
                      className={`input mono ${bad(f) ? 'xl-bad' : ''}`}
                      style={{ padding: '4px 8px', fontSize: 12, width }}
                      inputMode={f === 'item_id' ? 'text' : 'decimal'}
                      value={r.values[f]}
                      disabled={saved || busy}
                      onChange={(e) => editRow(r.key, f, e.target.value)}
                      onBlur={f === 'item_id' ? () => recheckCode(r.key) : undefined}
                      aria-label={`${FIELD_LABEL[f]}, Excel row ${r.rowNumber}`}
                    />
                  );
                  const unitKnown = (UNITS as readonly string[]).includes(r.values.unit);
                  return (
                    <tr key={r.key} className={saved ? 'xl-saved' : c.save ? '' : 'xl-problem'}>
                      <td className="mono" style={{ color: 'var(--text-muted)' }}>{r.rowNumber}{r.sheet !== activeSheet ? ` (${r.sheet})` : ''}</td>
                      <td>{cell('item_id', 130)}</td>
                      <td>{cell('quantity', 80)}</td>
                      <td>
                        {fixedUnit(category) ? (
                          <span className="badge badge-gold">{fixedUnit(category)}</span>
                        ) : (
                          <select
                            className={`select ${bad('unit') ? 'xl-bad' : ''}`}
                            style={{ padding: '4px 6px', fontSize: 12, width: 92 }}
                            value={r.values.unit}
                            disabled={saved || busy}
                            onChange={(e) => editRow(r.key, 'unit', e.target.value)}
                          >
                            {!unitKnown && <option value={r.values.unit}>{r.values.unit ? `${r.values.unit} (?)` : '—'}</option>}
                            {UNITS.map((u) => <option key={u} value={u}>{u}</option>)}
                          </select>
                        )}
                      </td>
                      <td>{cell('low_stock_threshold', 80)}</td>
                      {hasCost(category) && <td>{cell('cost_price', 90)}</td>}
                      <td style={{ fontSize: 11 }}>
                        {saved ? (
                          <span className="badge badge-emerald">✓ Saved</span>
                        ) : r.status === 'failed' && c.save ? (
                          <div className="xl-msg bad"><XCircle size={12} /> {r.saveMessage}</div>
                        ) : c.save ? (
                          <span className="badge badge-emerald">Ready</span>
                        ) : null}
                        {!saved && r.status === 'failed' && !c.save && r.saveMessage && <div className="xl-msg bad"><XCircle size={12} /> {r.saveMessage}</div>}
                        {!saved && c.problems.map((p, k) => <div key={`p${k}`} className="xl-msg bad"><XCircle size={12} /> {p.message}</div>)}
                        {!saved && c.warnings.map((p, k) => <div key={`w${k}`} className="xl-msg warn"><AlertTriangle size={12} /> {p.message}</div>)}
                        {!saved && c.notes.map((p, k) => <div key={`n${k}`} className="xl-msg note"><Info size={12} /> {p.message}</div>)}
                      </td>
                      <td style={{ textAlign: 'right' }}>
                        {!saved && (
                          <button onClick={() => removeRow(r.key)} className="btn btn-secondary" style={{ padding: '4px 8px' }} title="Leave this row out of the import" disabled={busy}>
                            <Trash2 size={12} />
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
                {visibleRows.length === 0 && (
                  <tr><td colSpan={8} style={{ textAlign: 'center', padding: 30, color: 'var(--text-muted)' }}>No rows here.</td></tr>
                )}
              </tbody>
            </table>
          </div>
          {visibleRows.length > shown && (
            <div style={{ textAlign: 'center', marginTop: 12 }}>
              <button className="btn btn-secondary" onClick={() => setShown((s) => s + PAGE)}>Show more rows ({visibleRows.length - shown} more)</button>
            </div>
          )}
        </div>
      )}

      {/* Summary before saving */}
      {showSummary && (
        <div className="modal-backdrop" onClick={() => setShowSummary(false)}>
          <div className="modal-content" style={{ maxWidth: 520 }} onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3 style={{ fontSize: 16, fontWeight: 700 }}>Save {summary.ready} design{summary.ready === 1 ? '' : 's'} to {CATEGORY_LABEL[category]}?</h3>
              <button className="btn-icon" onClick={() => setShowSummary(false)} aria-label="Close"><X size={16} /></button>
            </div>
            <div className="modal-body" style={{ fontSize: 13, lineHeight: 1.6 }}>
              <div style={{ color: 'var(--text-secondary)', marginBottom: 8 }}>File: {fileName} · sheet "{splitTarget(mapping.item_id?.target)?.sheet}"</div>
              <ul className="xl-sum">
                <li><span>Rows in the import</span><strong>{summary.rowsInFile}</strong></li>
                <li><span>Ready to save now</span><strong style={{ color: 'var(--emerald-text)' }}>{summary.ready}</strong></li>
                {summary.readyWithWarnings > 0 && <li><span>…of which have warnings (they will be saved as shown)</span><strong style={{ color: '#B45309' }}>{summary.readyWithWarnings}</strong></li>}
                <li><span>Need fixing — will NOT be saved</span><strong style={{ color: summary.problems ? '#DC2626' : undefined }}>{summary.problems}</strong></li>
                {summary.alreadySaved > 0 && <li><span>Already saved earlier</span><strong>{summary.alreadySaved}</strong></li>}
                <li>
                  <span>Total quantity</span>
                  <strong>{Object.entries(summary.quantityByUnit).map(([u, q]) => `${q.toLocaleString('en-IN')} ${u}`).join(' · ') || '0'}</strong>
                </li>
                {summary.totalValue !== null && <li><span>Total value (quantity × cost)</span><strong>{inr(summary.totalValue)}</strong></li>}
                {summary.unitSetToPC > 0 && <li><span>Unit set to PC (no unit in the file)</span><strong>{summary.unitSetToPC}</strong></li>}
                {summary.readNotes > 0 && <li><span>Values read from text (₹, commas, units…)</span><strong>{summary.readNotes}</strong></li>}
              </ul>
              {summary.readyWithWarnings > 0 && (
                <div className="xl-note warn" style={{ marginTop: 10 }}><AlertTriangle size={14} /> Rows with warnings are saved as shown. To review them first, cancel and tap “Warnings”.</div>
              )}
              <div style={{ marginTop: 10, color: 'var(--text-secondary)' }}>Only new designs are added; nothing that already exists is changed. Keep this page open while saving.</div>
            </div>
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => setShowSummary(false)}>Cancel</button>
              <button className="btn btn-primary" onClick={saveAll}><Save size={15} /> Save {summary.ready} design{summary.ready === 1 ? '' : 's'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
