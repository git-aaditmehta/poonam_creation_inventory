/**
 * Excel import rules (agreed 2026-11-21). Pure functions, no screen code, so they are unit-tested.
 *
 * Principles:
 *  - Nothing in the file is silently changed. Design codes are taken exactly as Excel shows them; numbers written
 *    with ₹ / Rs / commas are read and the reading is shown; anything unclear is a problem the user fixes.
 *  - Wrong column matching is prevented: columns whose names mean something else (Low/Min… for Quantity,
 *    Sale/MRP… for Cost) are never picked automatically; guesses are marked "Please check" and must be confirmed;
 *    one column can't feed two fields; the values themselves are checked (names in a code column, text in a number
 *    column, unknown units…).
 *  - A value from a second sheet is found by design code only (same ID rule as everywhere: capitals, spaces and
 *    dashes ignored). Never by row position.
 *  - Every row shows ALL its problems in plain words, with its real Excel row number.
 *  - The same rules run again on the server (backend/src/routes/excel.ts rowProblems) — keep the wording in sync.
 */
import { itemKey } from './itemId';
import type { CellInfo, ParsedExcelResult } from './excelParser';
import { JEWELRY_CATEGORY_PREFIX } from './jewelryCategory';

export type ImportCategory = 'plated_jewelry' | 'raw_jewelry' | 'stones' | 'foil';
export type ImportField = 'item_id' | 'quantity' | 'unit' | 'low_stock_threshold' | 'cost_price';
export type ImportUnit = 'PC' | 'KGS' | 'SET' | 'JODI' | 'GRMS';

export const CATEGORY_LABEL: Record<ImportCategory, string> = {
  plated_jewelry: 'Plated Jewelry',
  raw_jewelry: 'Raw Jewelry',
  stones: 'Kundan Stone',
  foil: 'Foil',
};

export const FIELD_LABEL: Record<ImportField, string> = {
  item_id: 'Design code',
  quantity: 'Quantity',
  unit: 'Unit',
  low_stock_threshold: 'Low stock level',
  cost_price: 'Cost price',
};

export function fieldsFor(category: ImportCategory): ImportField[] {
  const f: ImportField[] = ['item_id', 'quantity'];
  if (category === 'plated_jewelry' || category === 'raw_jewelry') f.push('unit');
  f.push('low_stock_threshold');
  if (category !== 'raw_jewelry') f.push('cost_price');
  return f;
}

export const decimalsAllowed = (category: ImportCategory) => category === 'foil';
export const hasCost = (category: ImportCategory) => category !== 'raw_jewelry';
export const fixedUnit = (category: ImportCategory): ImportUnit | null =>
  category === 'stones' ? 'PC' : category === 'foil' ? 'KGS' : null;

// ─── Units (E3) ────────────────────────────────────────────────────────────────────────────────────────────────

const UNIT_WORDS: Record<string, ImportUnit> = {
  PC: 'PC', PCS: 'PC', PIECE: 'PC', PIECES: 'PC', NOS: 'PC', NO: 'PC', NUMBER: 'PC', NUMBERS: 'PC',
  SET: 'SET', SETS: 'SET',
  JODI: 'JODI', JODIS: 'JODI', JODIES: 'JODI', JODA: 'JODI', PAIR: 'JODI', PAIRS: 'JODI', PR: 'JODI', PRS: 'JODI',
  KG: 'KGS', KGS: 'KGS', KILO: 'KGS', KILOS: 'KGS', KILOGRAM: 'KGS', KILOGRAMS: 'KGS',
  G: 'GRMS', GM: 'GRMS', GMS: 'GRMS', GR: 'GRMS', GRS: 'GRMS', GRM: 'GRMS', GRMS: 'GRMS', GRAM: 'GRMS', GRAMS: 'GRMS',
};

/** A unit as written in Excel → the app's unit; null if blank; 'unknown' if not recognised. Ignores case, spaces, dots. */
export function readUnit(raw: string): ImportUnit | null | 'unknown' {
  const k = String(raw ?? '').toUpperCase().replace(/[\s.]/g, '');
  if (!k) return null;
  return UNIT_WORDS[k] ?? 'unknown';
}

// ─── Numbers (E7, E9) ──────────────────────────────────────────────────────────────────────────────────────────

/** Removes binary float leftovers (0.30000000000000004 → 0.3): what Excel itself shows. Not a change of value. */
export function cleanFloat(n: number): number {
  return Number(n.toPrecision(12));
}

export type NumberRead = { ok: true; value: number; note?: string } | { ok: false; empty: true } | { ok: false; empty: false; message: string };

const UNIT_SUFFIX = /\s*(pcs?|pieces?|nos?|sets?|jodis?|pairs?|kgs?|kilos?|gms?|grms?|grams?|g)\.?$/i;

/**
 * Reads a number cell. Real numbers are taken as they are. Text like "1,200", "1,25,000", "₹1,250.00", "Rs. 99/-"
 * or "50 pcs" is read and a note says how; anything else ("50-60", "approx 50") is a problem, never a guess.
 */
export function readNumber(raw: string | number | boolean | undefined | null, label: string, allowUnitWord = false): NumberRead {
  if (raw === undefined || raw === null) return { ok: false, empty: true };
  if (typeof raw === 'number') return Number.isFinite(raw) ? { ok: true, value: cleanFloat(raw) } : { ok: false, empty: false, message: `${label} is not a number.` };
  if (typeof raw === 'boolean') return { ok: false, empty: false, message: `${label} is not a number ("${raw}").` };
  const original = String(raw).trim();
  if (!original) return { ok: false, empty: true };
  let t = original.replace(/^(₹|rs\.?|inr)\s*/i, '').replace(/\s*\/-$/, '').replace(/\s*(₹|rs\.?|inr)$/i, '');
  if (allowUnitWord) t = t.replace(UNIT_SUFFIX, '');
  t = t.replace(/,/g, '').replace(/\s+/g, '');
  if (!/^-?(\d+(\.\d*)?|\.\d+)$/.test(t)) return { ok: false, empty: false, message: `${label} "${original}" is not a number.` };
  const value = cleanFloat(Number(t));
  const plain = /^-?(\d+(\.\d*)?|\.\d+)$/.test(original);
  return plain ? { ok: true, value } : { ok: true, value, note: `${label}: read "${original}" as ${value}.` };
}

const decimalsOf = (n: number) => {
  const s = String(n);
  if (s.includes('e')) return 20;
  const i = s.indexOf('.');
  return i < 0 ? 0 : s.length - i - 1;
};

/** Rounds to `places` decimals the way people expect (10.555 → 10.56, not 10.55). */
export function roundTo(n: number, places: number): number {
  const f = 10 ** places;
  return Math.round((n + Math.sign(n) * Number.EPSILON) * f) / f;
}

// ─── Design codes (E4) ─────────────────────────────────────────────────────────────────────────────────────────

/** The design code exactly as Excel shows it (00123 stays 00123), never in "1.2E+11" form. */
export function codeText(cell: CellInfo | undefined): string {
  if (!cell) return '';
  if (typeof cell.v === 'number') {
    if (cell.text && !/e[+-]?\d/i.test(cell.text) && !cell.isDate) return cell.text;
    return cell.v.toLocaleString('en-US', { useGrouping: false, maximumFractionDigits: 20 });
  }
  return cell.text;
}

const PREFIXES = Object.values(JEWELRY_CATEGORY_PREFIX);
const looksLikeCode = (s: string) => /\d/.test(s);
const hasKnownPrefix = (s: string) => PREFIXES.some((p) => new RegExp(`^${p}(?![A-Z])`, 'i').test(s.trim()));

// ─── Column matching (E2) ──────────────────────────────────────────────────────────────────────────────────────

/** "Sheet::Column" */
export type Target = string;
export const target = (sheet: string, column: string): Target => `${sheet}::${column}`;
export function splitTarget(t: Target | null | undefined): { sheet: string; column: string } | null {
  if (!t) return null;
  const i = t.indexOf('::');
  return i < 0 ? null : { sheet: t.slice(0, i), column: t.slice(i + 2) };
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

type AliasSet = { sure: string[]; check: string[]; never: string[] };

function aliasesFor(field: ImportField, category: ImportCategory): AliasSet {
  switch (field) {
    case 'item_id':
      return {
        sure: ['design code', 'design no', 'design number', 'design id', 'item code', 'item id', 'product code', 'product id', 'code', 'id', 'sku', 'article no', 'article code', 'stone code', 'foil code', 'casting code', 'casting no', 'casting id', 'raw code', 'variety code'],
        check: ['design', 'item', 'name', 'item name', 'product', 'product name', 'description', 'model', 'style', 'article', 'stone', 'stone name', 'foil', 'foil name', 'variety', 'type', 'casting'],
        never: ['sr', 'sno', 's no', 'serial', 'qty', 'quantity', 'stock', 'price', 'rate', 'cost', 'value', 'amount', 'unit', 'uom', 'date', 'min', 'low'],
      };
    case 'quantity':
      return {
        sure: ['qty', 'quantity', 'current qty', 'current quantity', 'current stock', 'closing qty', 'closing quantity', 'closing stock', 'closing balance', 'balance qty', 'stock qty', 'available qty', 'avail qty', 'available stock', 'in stock', 'no of pcs', 'pcs', 'nos', ...(category === 'foil' ? ['weight', 'wt', 'kgs', 'kg', 'net weight', 'net wt', 'weight kg', 'weight kgs'] : [])],
        check: ['stock', 'balance', 'total qty', 'total pcs', 'pieces', 'count', 'total'],
        never: ['low', 'min', 'minimum', 'safety', 'reorder', 'threshold', 'alert', 'opening', 'inward', 'outward', 'in', 'out', 'sold', 'sale', 'sales', 'purchase', 'purchased', 'received', 'issued', 'rate', 'price', 'cost', 'value', 'amount', 'mrp', 'code', 'id', 'name', 'unit', 'uom', 'date', 'sr', 'sno', ...(category === 'foil' ? [] : ['weight', 'wt', 'gms', 'grams'])],
      };
    case 'unit':
      return { sure: ['unit', 'units', 'uom', 'unit of measure', 'measurement', 'measure'], check: [], never: ['price', 'rate', 'cost', 'qty'] };
    case 'low_stock_threshold':
      return {
        sure: ['low stock', 'low stock level', 'low stock threshold', 'low stock qty', 'low stock alert', 'min stock', 'minimum stock', 'min qty', 'minimum qty', 'min quantity', 'minimum quantity', 'min', 'minimum', 'threshold', 'min threshold', 'minimum threshold', 'reorder level', 'reorder qty', 'reorder point', 'safety stock', 'min level', 'alert level', 'alert qty'],
        check: ['reorder', 'buffer', 'safety', 'alert'],
        never: ['price', 'cost', 'rate', 'value', 'amount', 'code', 'name'],
      };
    case 'cost_price':
      return {
        sure: ['cost', 'cost price', 'cost rate', 'purchase price', 'purchase rate', 'buying price', 'buying rate', 'cost per pc', 'cost pc', 'cost per kg', 'cost per piece', 'landing cost', 'making cost'],
        check: ['rate', 'price', 'unit price', 'unit rate', 'rate per pc', 'rate per kg', 'rate pc', 'rate kg'],
        never: ['sale', 'sales', 'selling', 'sell', 'mrp', 'retail', 'wholesale', 'value', 'amount', 'total', 'profit', 'margin', 'discount', 'gst', 'tax', 'qty', 'quantity', 'stock', 'code', 'name'],
      };
  }
}

const words = (s: string) => new Set(norm(s).split(' ').filter(Boolean));
const containsPhrase = (name: string, phrase: string) => ` ${norm(name)} `.includes(` ${phrase} `);

/** Why a column must not be used for a field (by its name), or null. */
export function nameConflict(field: ImportField, category: ImportCategory, column: string): string | null {
  const sub = column.includes(' - ') ? column.split(' - ').slice(1).join(' - ') : column;
  const a = aliasesFor(field, category);
  // A name that is exactly one of this field's names is never a conflict ("In Stock" is a quantity)
  if ([...a.sure, ...a.check].some((x) => x === norm(sub) || x === norm(column))) return null;
  const w = words(sub);
  const bad = a.never.find((x) => (x.includes(' ') ? containsPhrase(sub, x) : w.has(x)));
  if (!bad) return null;
  switch (field) {
    case 'quantity':
      return /low|min|safety|reorder|threshold|alert/.test(bad)
        ? `"${column}" looks like a low-stock level, not the current quantity.`
        : /opening|inward|outward|in|out|sold|sale|purchase|received|issued/.test(bad)
          ? `"${column}" looks like a stock movement (in/out/opening), not the current quantity.`
          : `"${column}" doesn't look like a quantity column.`;
    case 'cost_price':
      return /sale|sell|mrp|retail|wholesale/.test(bad)
        ? `"${column}" looks like a selling price, not the cost price.`
        : /value|amount|total/.test(bad)
          ? `"${column}" looks like a total value (quantity × price), not the cost of one piece.`
          : `"${column}" doesn't look like a cost price column.`;
    case 'item_id':
      return /sr|sno|serial/.test(bad) ? `"${column}" looks like a serial number, not a design code.` : `"${column}" doesn't look like a design code column.`;
    default:
      return `"${column}" doesn't look like a ${FIELD_LABEL[field].toLowerCase()} column.`;
  }
}

/** 100 = the name clearly means this field; 60 = a guess; 0 = no. */
export function nameScore(field: ImportField, category: ImportCategory, column: string): number {
  if (nameConflict(field, category, column)) return 0;
  const a = aliasesFor(field, category);
  const sub = column.includes(' - ') ? column.split(' - ').slice(1).join(' - ') : column;
  const n = norm(sub);
  const full = norm(column);
  if (a.sure.includes(n) || a.sure.includes(full)) return 100;
  if (a.check.includes(n) || a.check.includes(full)) return 60;
  if (a.sure.some((x) => containsPhrase(sub, x))) return 50;
  if (a.check.some((x) => containsPhrase(sub, x))) return 30;
  return 0;
}

export type Confidence = 'sure' | 'check';
export interface FieldMatch {
  target: Target | null;
  /** How the column was chosen: automatically (sure / a guess) or by the user. */
  how: 'auto-sure' | 'auto-check' | 'user' | 'none';
}

/**
 * Picks a column for every field: the clearest names first, never one column twice, never a column whose name means
 * something else. Columns of `primarySheet` are preferred; other sheets fill fields still missing (always a guess).
 */
export function autoMatch(category: ImportCategory, sheets: Record<string, ParsedExcelResult>, primarySheet: string): Record<ImportField, FieldMatch> {
  const fields = fieldsFor(category);
  const out = Object.fromEntries(fields.map((f) => [f, { target: null, how: 'none' } as FieldMatch])) as Record<ImportField, FieldMatch>;
  const used = new Set<Target>();
  const order = [primarySheet, ...Object.keys(sheets).filter((s) => s !== primarySheet)];
  for (const sheet of order) {
    const parsed = sheets[sheet];
    if (!parsed) continue;
    const options: { field: ImportField; column: string; score: number; pos: number }[] = [];
    for (const field of fields) {
      if (out[field].target) continue;
      parsed.detectedColumns.forEach((column, pos) => {
        const score = nameScore(field, category, column);
        if (score > 0) options.push({ field, column, score, pos });
      });
    }
    options.sort((x, y) => y.score - x.score || x.pos - y.pos);
    for (const o of options) {
      const t = target(sheet, o.column);
      if (out[o.field].target || used.has(t)) continue;
      out[o.field] = { target: t, how: o.score >= 100 && sheet === primarySheet ? 'auto-sure' : 'auto-check' };
      used.add(t);
    }
  }
  return out;
}

export interface MappingIssue {
  field: ImportField;
  level: 'block' | 'check';
  message: string;
}

function columnCells(sheets: Record<string, ParsedExcelResult>, t: Target): CellInfo[] {
  const st = splitTarget(t);
  const parsed = st ? sheets[st.sheet] : undefined;
  if (!st || !parsed) return [];
  return parsed.rows.map((r) => r.cells[st.column]).filter((c): c is CellInfo => !!c);
}

const quote = (s: string) => `"${s.length > 24 ? s.slice(0, 24) + '…' : s}"`;

/**
 * Everything the user must look at before continuing: 'block' must be fixed; 'check' must be confirmed
 * ("Yes, this column is right") or changed.
 */
export function mappingIssues(
  category: ImportCategory,
  sheets: Record<string, ParsedExcelResult>,
  mapping: Record<ImportField, FieldMatch>,
  defaults: Partial<Record<ImportField, string>>,
): MappingIssue[] {
  const issues: MappingIssue[] = [];
  const fields = fieldsFor(category);
  const label = CATEGORY_LABEL[category];

  // One column, one field
  const byTarget = new Map<Target, ImportField[]>();
  for (const f of fields) {
    const t = mapping[f]?.target;
    if (t) byTarget.set(t, [...(byTarget.get(t) || []), f]);
  }
  for (const [t, fs] of byTarget) {
    if (fs.length > 1) {
      for (const f of fs.slice(1)) {
        issues.push({ field: f, level: 'block', message: `Column "${splitTarget(t)?.column}" is already used for ${FIELD_LABEL[fs[0]]}. One column can't fill two fields; choose another column.` });
      }
    }
  }

  for (const f of fields) {
    const m = mapping[f];
    const t = m?.target;
    if (!t) {
      if (f === 'item_id') issues.push({ field: f, level: 'block', message: 'Choose the column that has the design codes (e.g. PS 101). Every row needs one.' });
      const d = defaults[f]?.trim();
      if (d && f !== 'unit' && f !== 'item_id') {
        const r = readNumber(d, FIELD_LABEL[f]);
        if (!r.ok) issues.push({ field: f, level: 'block', message: `The value for every row "${d}" is not a number.` });
        else if (r.value < 0) issues.push({ field: f, level: 'block', message: `The value for every row can't be negative.` });
        else if (!decimalsAllowed(category) && f !== 'cost_price' && !Number.isInteger(r.value)) {
          issues.push({ field: f, level: 'block', message: `The value for every row has decimals (${r.value}). ${label} is counted in whole numbers.` });
        }
      }
      if (f === 'unit' && d && readUnit(d) === 'unknown') {
        issues.push({ field: f, level: 'block', message: `"${d}" is not a unit the app knows. Use PC, KGS, SET, JODI or GRMS.` });
      }
      continue;
    }
    const st = splitTarget(t)!;
    const conflict = nameConflict(f, category, st.column);
    if (conflict) issues.push({ field: f, level: 'check', message: `${conflict} Are you sure?` });
    if (m.how === 'auto-check') {
      const idSheet = splitTarget(mapping.item_id?.target)?.sheet;
      issues.push({
        field: f,
        level: 'check',
        message:
          nameScore(f, category, st.column) >= 100 && idSheet && st.sheet !== idSheet
            ? `Found in another sheet ("${st.sheet}"), matched to each design by its code. Check the example values.`
            : `Matched by guess: the column name "${st.column}" is not a clear ${FIELD_LABEL[f].toLowerCase()} name. Check the example values.`,
      });
    }
    const cells = columnCells(sheets, t);
    const total = sheets[st.sheet]?.rows.length ?? 0;
    if (total > 0 && cells.length === 0) {
      issues.push({ field: f, level: 'check', message: `Column "${st.column}" is empty in every row.` });
      continue;
    }
    if (f === 'item_id') {
      const texts = cells.map(codeText).filter(Boolean);
      const names = texts.filter((x) => !looksLikeCode(x));
      if (names.length >= Math.max(1, texts.length * 0.5)) {
        issues.push({ field: f, level: 'check', message: `These look like names, not design codes (e.g. ${quote(names[0])}). Choose the column with codes like "PS 101" if there is one.` });
      }
      const dates = cells.filter((c) => c.isDate);
      if (dates.length) issues.push({ field: f, level: 'check', message: `${dates.length} code(s) are formatted as dates in Excel (e.g. ${quote(dates[0].text)}); Excel may have changed them. Check them in the file.` });
      if (total - cells.length > 0) issues.push({ field: f, level: 'check', message: `${total - cells.length} row(s) have no design code in this column.` });
      const seen = new Set<string>();
      const repeats = new Set<string>();
      for (const x of texts) {
        const k = itemKey(x);
        if (seen.has(k)) repeats.add(x);
        seen.add(k);
      }
      if (repeats.size) issues.push({ field: f, level: 'check', message: `${repeats.size} design code(s) appear more than once (e.g. ${quote([...repeats][0])}). Each design must appear once; those rows will be marked.` });
      if ((category === 'stones' || category === 'foil') && texts.length && texts.filter(hasKnownPrefix).length >= texts.length * 0.5) {
        issues.push({ field: f, level: 'check', message: `These codes look like jewelry designs (${quote(texts.find(hasKnownPrefix)!)}), but you are importing ${label}. Check the category at the top.` });
      }
    } else if (f === 'unit') {
      const unknown = cells.map((c) => c.text).filter((x) => readUnit(x) === 'unknown');
      if (unknown.length) {
        issues.push({ field: f, level: 'check', message: `${unknown.length} value(s) are not units the app knows (e.g. ${quote(unknown[0])}). Those rows will need a unit chosen (PC, KGS, SET, JODI or GRMS).` });
      }
    } else {
      const reads = cells.map((c) => readNumber(c.v, FIELD_LABEL[f], f === 'quantity'));
      const bad = cells.filter((_, i) => !reads[i].ok);
      if (bad.length) issues.push({ field: f, level: 'check', message: `${bad.length} value(s) are not numbers (e.g. ${quote(bad[0].text)}). Those rows will need fixing.` });
      const nums = reads.flatMap((r) => (r.ok ? [r.value] : []));
      const neg = nums.filter((n) => n < 0);
      if (neg.length) issues.push({ field: f, level: 'check', message: `${neg.length} value(s) are negative (e.g. ${neg[0]}). Those rows will need fixing.` });
      if (f !== 'cost_price' && !decimalsAllowed(category)) {
        const dec = nums.filter((n) => !Number.isInteger(n));
        if (dec.length) issues.push({ field: f, level: 'check', message: `${dec.length} value(s) have decimals (e.g. ${dec[0]}). ${label} is counted in whole numbers; those rows will need fixing.` });
      }
    }
  }
  return issues;
}

// ─── Rows ──────────────────────────────────────────────────────────────────────────────────────────────────────

export type RowValues = Record<ImportField, string>;

export interface StagedRow {
  /** Stable key on screen. */
  key: string;
  /** The item's id, made here so that sending the same row twice never creates two items. */
  id: string;
  sheet: string;
  rowNumber: number;
  values: RowValues;
  /** How a value from the file was read (e.g. "read "₹1,250" as 1250", "read "Sets" as SET"). Cleared when edited. */
  notes: Partial<Record<ImportField, string>>;
  /** Problems found while reading the file (second sheet not found, merged cell…), cleared when the field is edited. */
  fileProblems: Partial<Record<ImportField, string>>;
  fileWarnings: Partial<Record<ImportField, string>>;
  /** From the server: this code already exists. Keyed by the code checked, so an edit re-checks. */
  exists?: { code: string; message: string };
  status: 'pending' | 'saved' | 'failed';
  saveMessage?: string;
}

export interface BuildInput {
  category: ImportCategory;
  sheets: Record<string, ParsedExcelResult>;
  mapping: Record<ImportField, FieldMatch>;
  defaults: Partial<Record<ImportField, string>>;
  /** For a second sheet: which of its columns holds the design code (to find the same design there). */
  linkColumns: Record<string, string>;
  makeId: () => string;
}

/** Text to put in a row field from a cell. Codes: as Excel shows them. Numbers: the exact value (float leftovers removed). */
function valueText(field: ImportField, cell: CellInfo | undefined): string {
  if (!cell) return '';
  if (field === 'item_id') return codeText(cell);
  if (field === 'unit') return cell.text.trim();
  if (typeof cell.v === 'number') return String(cleanFloat(cell.v));
  return cell.text.trim();
}

/** The column in another sheet that holds the design codes: the one sharing the most codes with the primary sheet. */
export function guessLinkColumn(sheets: Record<string, ParsedExcelResult>, primary: string, idColumn: string, other: string): string | null {
  const a = sheets[primary];
  const b = sheets[other];
  if (!a || !b) return null;
  const keys = new Set(a.rows.map((r) => itemKey(codeText(r.cells[idColumn]))).filter(Boolean));
  let best: string | null = null;
  let bestCount = 0;
  for (const col of b.detectedColumns) {
    let n = 0;
    for (const r of b.rows) if (keys.has(itemKey(codeText(r.cells[col])))) n++;
    if (n > bestCount) {
      bestCount = n;
      best = col;
    }
  }
  return best;
}

export function buildRows(input: BuildInput): StagedRow[] {
  const { category, sheets, mapping, defaults, linkColumns, makeId } = input;
  const fields = fieldsFor(category);
  const idTarget = splitTarget(mapping.item_id?.target);
  if (!idTarget) return [];
  const primary = sheets[idTarget.sheet];
  if (!primary) return [];

  // Second sheets: rows by design code (E1). A code found twice there is ambiguous and reported, never guessed.
  const lookups: Record<string, { col: string; byKey: Map<string, number[]> }> = {};
  for (const f of fields) {
    const t = splitTarget(mapping[f]?.target);
    if (!t || t.sheet === idTarget.sheet || lookups[t.sheet]) continue;
    const col = linkColumns[t.sheet];
    const byKey = new Map<string, number[]>();
    if (col) {
      sheets[t.sheet]?.rows.forEach((r, i) => {
        const k = itemKey(codeText(r.cells[col]));
        if (k) byKey.set(k, [...(byKey.get(k) || []), i]);
      });
    }
    lookups[t.sheet] = { col: col || '', byKey };
  }

  return primary.rows.map((row) => {
    const values = { item_id: '', quantity: '', unit: '', low_stock_threshold: '', cost_price: '' } as RowValues;
    const notes: StagedRow['notes'] = {};
    const fileProblems: StagedRow['fileProblems'] = {};
    const fileWarnings: StagedRow['fileWarnings'] = {};
    const code = codeText(row.cells[idTarget.column]);
    values.item_id = code;
    if (row.cells[idTarget.column]?.isDate) fileWarnings.item_id = `This code is formatted as a date in Excel ("${code}"); Excel may have changed it. Check it.`;

    for (const f of fields) {
      if (f === 'item_id') continue;
      const t = splitTarget(mapping[f]?.target);
      if (!t) {
        values[f] = (defaults[f] ?? '').trim();
        continue;
      }
      if (t.sheet === idTarget.sheet) {
        values[f] = valueText(f, row.cells[t.column]);
        const m = row.merged[t.column];
        if (m) {
          if (m.from === row.rowNumber) {
            fileWarnings[f] = `In Excel this ${FIELD_LABEL[f].toLowerCase()} (${m.text}) is one merged cell shared by rows ${m.from}–${m.to}. Check that ${m.text} is right for this design alone.`;
          } else {
            fileProblems[f] = `In Excel this row shares a merged ${FIELD_LABEL[f].toLowerCase()} cell with row ${m.from} (${m.text}). Enter this design's own ${FIELD_LABEL[f].toLowerCase()}.`;
          }
        }
        continue;
      }
      // From a second sheet: by design code only
      const lk = lookups[t.sheet];
      if (!lk?.col) {
        fileProblems[f] = `Can't find this design in sheet "${t.sheet}": choose which column there has the design codes.`;
        continue;
      }
      const hits = code ? lk.byKey.get(itemKey(code)) || [] : [];
      if (hits.length === 0) fileProblems[f] = `"${code || '(no code)'}" was not found in sheet "${t.sheet}" (column "${lk.col}"), so its ${FIELD_LABEL[f].toLowerCase()} is unknown.`;
      else if (hits.length > 1) fileProblems[f] = `"${code}" appears ${hits.length} times in sheet "${t.sheet}" (rows ${hits.map((i) => sheets[t.sheet].rows[i].rowNumber).join(', ')}), so it is unclear which ${FIELD_LABEL[f].toLowerCase()} to use.`;
      else values[f] = valueText(f, sheets[t.sheet].rows[hits[0]].cells[t.column]);
    }

    // Units (E3): blank = PC (agreed); known spellings read and shown; unknown = a problem
    const fu = fixedUnit(category);
    if (fu) values.unit = fu;
    else {
      const raw = values.unit;
      const u = readUnit(raw);
      if (u === null) {
        values.unit = 'PC';
        notes.unit = mapping.unit?.target ? 'No unit in the file for this row: set to PC.' : 'No unit column in the file: set to PC.';
      } else if (u !== 'unknown') {
        values.unit = u;
        if (raw.toUpperCase() !== u) notes.unit = `Read "${raw}" as ${u}.`;
      }
    }
    // Number notes ("₹1,250" read as 1250) are produced by checkRow from the text itself
    return { key: makeId(), id: makeId(), sheet: idTarget.sheet, rowNumber: row.rowNumber, values, notes, fileProblems, fileWarnings, status: 'pending' as const };
  });
}

export interface RowMessage {
  field: ImportField | 'row';
  message: string;
}

export interface RowCheck {
  problems: RowMessage[];
  warnings: RowMessage[];
  notes: RowMessage[];
  /** What will be sent to the server (only when there are no problems). */
  save?: { id: string; item_id: string; quantity: number; unit?: string; low_stock_threshold: number; cost_price?: number };
}

/** Rows of the same design code, for "Same design code as row 4". */
export function duplicateIndex(rows: StagedRow[]): Map<string, StagedRow> {
  const first = new Map<string, StagedRow>();
  for (const r of rows) {
    const k = itemKey(r.values.item_id);
    if (k && !first.has(k)) first.set(k, r);
  }
  return first;
}

/** Every problem / warning of a row, in plain words. Same rules as the server. */
export function checkRow(row: StagedRow, category: ImportCategory, firstByKey: Map<string, StagedRow>): RowCheck {
  const problems: RowMessage[] = [];
  const warnings: RowMessage[] = [];
  const notes: RowMessage[] = [];
  const label = CATEGORY_LABEL[category];
  const v = row.values;

  for (const [f, msg] of Object.entries(row.fileProblems)) if (msg) problems.push({ field: f as ImportField, message: msg });
  for (const [f, msg] of Object.entries(row.fileWarnings)) if (msg) warnings.push({ field: f as ImportField, message: msg });
  for (const [f, msg] of Object.entries(row.notes)) if (msg) notes.push({ field: f as ImportField, message: msg });
  const hasFileProblem = (f: ImportField) => !!row.fileProblems[f];

  // Design code
  const code = v.item_id.trim();
  if (!code) problems.push({ field: 'item_id', message: 'Design code is empty.' });
  else if (code.length > 255) problems.push({ field: 'item_id', message: 'Design code is too long (more than 255 characters).' });
  else {
    const first = firstByKey.get(itemKey(code));
    if (first && first.key !== row.key) {
      problems.push({ field: 'item_id', message: `Same design code as row ${first.rowNumber} ("${first.values.item_id.trim()}"). Codes that differ only in capitals, spaces or dashes are the same design; keep one row.` });
    }
    if (row.exists && itemKey(row.exists.code) === itemKey(code)) problems.push({ field: 'item_id', message: row.exists.message });
  }

  // Numbers
  const num = (f: 'quantity' | 'low_stock_threshold' | 'cost_price', required: boolean) => {
    if (hasFileProblem(f)) return undefined;
    const r = readNumber(v[f], FIELD_LABEL[f], f === 'quantity');
    if (!r.ok) {
      if (r.empty) {
        if (required) {
          problems.push({
            field: f,
            message:
              f === 'low_stock_threshold'
                ? 'Low stock level is empty. Type it here, or use "Fill empty cells" above to set one value for all rows.'
                : `${FIELD_LABEL[f]} is empty.`,
          });
        }
      } else problems.push({ field: f, message: r.message });
      return undefined;
    }
    if (r.note) notes.push({ field: f, message: r.note });
    let n = r.value;
    if (n < 0) {
      problems.push({ field: f, message: `${FIELD_LABEL[f]} can't be negative (${n}).` });
      return undefined;
    }
    if (f === 'cost_price') {
      if (decimalsOf(n) > 2) {
        const to = roundTo(n, 2);
        warnings.push({ field: f, message: `Cost price ₹${n} has more than 2 decimals; it will be saved as ₹${to.toFixed(2)}. Change it if that's not right.` });
        n = to;
      }
    } else if (!decimalsAllowed(category)) {
      if (!Number.isInteger(n)) {
        problems.push({ field: f, message: `${FIELD_LABEL[f]} has decimals (${n}). ${label} is counted in whole numbers; enter a whole number.` });
        return undefined;
      }
    } else if (decimalsOf(n) > 3) {
      const to = roundTo(n, 3);
      warnings.push({ field: f, message: `${FIELD_LABEL[f]} ${n} kg has more than 3 decimals; it will be saved as ${to}. Change it if that's not right.` });
      n = to;
    }
    return n;
  };
  const quantity = num('quantity', true);
  const low = num('low_stock_threshold', true);
  const cost = hasCost(category) ? num('cost_price', true) : undefined;

  // Unit
  let unit: string | undefined;
  const fu = fixedUnit(category);
  if (fu) unit = fu;
  else if (!hasFileProblem('unit')) {
    const u = readUnit(v.unit);
    if (u === null) problems.push({ field: 'unit', message: 'Unit is empty. Choose PC, KGS, SET, JODI or GRMS.' });
    else if (u === 'unknown') problems.push({ field: 'unit', message: `Unit "${v.unit}" is not one the app knows. Choose PC, KGS, SET, JODI or GRMS.` });
    else unit = u;
  }

  const save =
    problems.length === 0 && quantity !== undefined && low !== undefined && (!hasCost(category) || cost !== undefined)
      ? { id: row.id, item_id: code, quantity, unit, low_stock_threshold: low, ...(hasCost(category) ? { cost_price: cost } : {}) }
      : undefined;
  return { problems, warnings, notes, save };
}

// ─── Summary before saving ─────────────────────────────────────────────────────────────────────────────────────

export interface ImportSummary {
  category: ImportCategory;
  rowsInFile: number;
  ready: number;
  readyWithWarnings: number;
  problems: number;
  alreadySaved: number;
  quantityByUnit: Record<string, number>;
  totalValue: number | null;
  unitSetToPC: number;
  readNotes: number;
}

export function summarize(category: ImportCategory, rows: StagedRow[], checks: Map<string, RowCheck>): ImportSummary {
  const s: ImportSummary = {
    category,
    rowsInFile: rows.length,
    ready: 0,
    readyWithWarnings: 0,
    problems: 0,
    alreadySaved: 0,
    quantityByUnit: {},
    totalValue: hasCost(category) ? 0 : null,
    unitSetToPC: 0,
    readNotes: 0,
  };
  for (const r of rows) {
    if (r.status === 'saved') {
      s.alreadySaved++;
      continue;
    }
    const c = checks.get(r.key);
    if (!c?.save) {
      s.problems++;
      continue;
    }
    s.ready++;
    if (c.warnings.length) s.readyWithWarnings++;
    if (c.notes.length) s.readNotes++;
    if (r.notes.unit?.includes('set to PC')) s.unitSetToPC++;
    const u = c.save.unit || fixedUnit(category) || 'PC';
    s.quantityByUnit[u] = roundTo((s.quantityByUnit[u] || 0) + c.save.quantity, 3);
    if (s.totalValue !== null) s.totalValue = roundTo(s.totalValue + c.save.quantity * (c.save.cost_price ?? 0), 2);
  }
  return s;
}
