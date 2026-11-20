import * as XLSX from 'xlsx';

/** One cell as Excel has it: its value, and the text Excel shows for it (used for design codes, so 00123 stays 00123). */
export interface CellInfo {
  v: string | number | boolean;
  text: string;
  /** The cell is formatted as a date in Excel (a design code like 10-12 may have been turned into a date by Excel). */
  isDate: boolean;
}

/** A data row with its real Excel row number (as shown at the left edge in Excel). */
export interface ParsedDataRow {
  rowNumber: number;
  cells: Record<string, CellInfo | undefined>;
  /** Columns where this row is part of a cell merged over several rows: the rows it covers and the shown value. */
  merged: Record<string, { from: number; to: number; text: string } | undefined>;
}

export interface ParsedExcelResult {
  sheetName: string;
  headerRowIndex: number;
  /** Excel row number of the header row. */
  headerRowNumber: number;
  detectedColumns: string[];
  columnSamples: Record<string, string[]>;
  rawRows: Record<string, any>[];
  rows: ParsedDataRow[];
  totalDataRows: number;
  skippedHeaderCount: number;
}

/**
 * Common inventory keywords used to score potential header rows.
 */
const HEADER_KEYWORDS = [
  'id', 'code', 'item', 'product', 'design', 'casting', 'stone', 'foil',
  'name', 'description', 'title', 'qty', 'quantity', 'stock', 'pcs', 'pieces',
  'kgs', 'kg', 'weight', 'set', 'jodi', 'grms', 'gms', 'grams', 'unit', 'uom', 'min', 'low', 'threshold',
  'safety', 'reorder', 'balance', 'closing', 'cost', 'price', 'rate', 'mrp',
  'amount', 'val', 'value', 'sr', 'no', 'sno', 'sales', 'purchase', 'status', 'date',
];

function cellInfo(cell: XLSX.CellObject | undefined): CellInfo | undefined {
  if (!cell || cell.v === undefined || cell.v === null) return undefined;
  if (cell.t === 'n') {
    const isDate = typeof cell.z === 'string' ? XLSX.SSF.is_date(cell.z) : false;
    const text = (cell.w ?? String(cell.v)).trim();
    return { v: cell.v as number, text, isDate };
  }
  if (cell.t === 'd') {
    const d = cell.v as unknown as Date;
    return { v: cell.w ?? String(d), text: (cell.w ?? String(d)).trim(), isDate: true };
  }
  if (cell.t === 'b') return { v: cell.v as boolean, text: String(cell.v), isDate: false };
  if (cell.t === 'e') return { v: cell.w ?? '#ERROR', text: cell.w ?? '#ERROR', isDate: false };
  const str = String(cell.v);
  if (str.trim() === '') return undefined;
  return { v: str, text: str, isDate: false };
}

/**
 * Intelligently parse an Excel worksheet:
 * 1. Finds the real column header row (titles/banners above it are skipped); 2-tier grouped headers supported
 * 2. Keeps every value exactly as in Excel (nothing is converted), with the real Excel row number of every row
 * 3. Merged cells: in the title/header area the merged text fills the whole range (grouped headers). In the DATA
 *    area nothing is copied: the value stays in its first row and every row of the range is marked, so the import
 *    can ask the user instead of guessing (agreed 2026-11-21, E8).
 */
export function parseExcelWorksheet(worksheet: XLSX.WorkSheet, sheetName: string): ParsedExcelResult {
  const ref = worksheet['!ref'];
  if (!ref) throw new Error('The spreadsheet is empty.');
  const range = XLSX.utils.decode_range(ref);
  const merges = worksheet['!merges'] || [];

  // Text of every cell, header-area merges filled in (only used to find and name the columns)
  const mergedText = new Map<string, string>();
  for (const m of merges) {
    const top = cellInfo(worksheet[XLSX.utils.encode_cell(m.s)]);
    if (!top) continue;
    for (let R = m.s.r; R <= m.e.r; ++R) for (let C = m.s.c; C <= m.e.c; ++C) mergedText.set(`${R}:${C}`, top.text);
  }
  const textAt = (r: number, c: number) => {
    const info = cellInfo(worksheet[XLSX.utils.encode_cell({ r, c })]);
    return (info?.text ?? mergedText.get(`${r}:${c}`) ?? '').trim();
  };
  const textRow = (r: number) => {
    const out: string[] = [];
    for (let c = range.s.c; c <= range.e.c; c++) out.push(textAt(r, c));
    return out;
  };
  const isBlank = (cells: string[]) => cells.every((x) => x === '');

  // Find the true header row among the first 20 non-blank rows
  const candidates: number[] = [];
  for (let r = range.s.r; r <= range.e.r && candidates.length < 20; r++) if (!isBlank(textRow(r))) candidates.push(r);
  if (candidates.length === 0) throw new Error('The spreadsheet is empty.');

  let bestRow = candidates[0];
  let highestScore = -1000;
  for (const r of candidates) {
    const nonBlankCells = textRow(r).filter((val) => val.length > 0);
    if (nonBlankCells.length < 2) continue;
    const uniqueValues = new Set(nonBlankCells.map((c) => c.toLowerCase()));
    if (uniqueValues.size <= 1) continue; // a title merged across the sheet
    let stringCount = 0;
    let numberCount = 0;
    let keywordCount = 0;
    for (const cell of nonBlankCells) {
      if (!isNaN(Number(cell)) && cell !== '') numberCount++;
      else {
        stringCount++;
        const lower = cell.toLowerCase();
        if (HEADER_KEYWORDS.some((kw) => lower === kw || lower.includes(kw))) keywordCount++;
      }
    }
    if (numberCount > stringCount) continue; // data rows are mostly numbers
    const score = uniqueValues.size * 10 + keywordCount * 5 + stringCount * 2 - numberCount * 20;
    if (score > highestScore) {
      highestScore = score;
      bestRow = r;
    }
  }

  const headerRow = textRow(bestRow).map((v) => v.replace(/\s+/g, ' '));
  const prevIdx = candidates.indexOf(bestRow) - 1;
  const parentRow = prevIdx >= 0 ? textRow(candidates[prevIdx]).map((v) => v.replace(/\s+/g, ' ')) : null;
  const isParentGroupRow = parentRow
    ? (() => {
        const pUniq = new Set(parentRow.filter(Boolean).map((v) => v.toLowerCase()));
        return pUniq.size >= 2 && pUniq.size <= headerRow.length;
      })()
    : false;

  const detectedColumns: string[] = [];
  const columnIndexMap: { colName: string; c: number }[] = [];
  const seenNames = new Map<string, number>();
  headerRow.forEach((sub, i) => {
    const c = range.s.c + i;
    const parent = isParentGroupRow && parentRow ? parentRow[i] : '';
    if (!sub && !parent) return;
    let colName = sub;
    if (!colName) colName = parent;
    else if (parent && parent.toLowerCase() !== sub.toLowerCase() && !parent.toLowerCase().includes('tracker') && !parent.toLowerCase().includes('value>>')) {
      colName = `${parent} - ${sub}`; // "Stock Balance - Item Name"
    }
    const count = seenNames.get(colName.toLowerCase()) || 0;
    seenNames.set(colName.toLowerCase(), count + 1);
    const uniqueName = count > 0 ? `${colName} (${count + 1})` : colName;
    detectedColumns.push(uniqueName);
    columnIndexMap.push({ colName: uniqueName, c });
  });
  if (detectedColumns.length === 0) throw new Error('Could not identify any valid column headers in this spreadsheet.');

  // Data-area merges: which (row, column) cells belong to a merged range spanning several rows
  const dataMerge = new Map<string, { from: number; to: number; text: string }>();
  for (const m of merges) {
    if (m.e.r <= bestRow || m.e.r === m.s.r) continue;
    const top = cellInfo(worksheet[XLSX.utils.encode_cell(m.s)]);
    const info = { from: Math.max(m.s.r, bestRow + 1) + 1, to: m.e.r + 1, text: top?.text ?? '' };
    for (let R = Math.max(m.s.r, bestRow + 1); R <= m.e.r; ++R) for (let C = m.s.c; C <= m.e.c; ++C) dataMerge.set(`${R}:${C}`, info);
  }

  const rows: ParsedDataRow[] = [];
  const rawRows: Record<string, any>[] = [];
  const columnSamples: Record<string, string[]> = {};
  detectedColumns.forEach((col) => (columnSamples[col] = []));

  for (let r = bestRow + 1; r <= range.e.r; r++) {
    const cells: ParsedDataRow['cells'] = {};
    const merged: ParsedDataRow['merged'] = {};
    const rowObj: Record<string, any> = {};
    let hasData = false;
    for (const { colName, c } of columnIndexMap) {
      const info = cellInfo(worksheet[XLSX.utils.encode_cell({ r, c })]);
      const m = dataMerge.get(`${r}:${c}`);
      if (m) merged[colName] = m;
      if (info) {
        hasData = true;
        cells[colName] = info;
        rowObj[colName] = typeof info.v === 'number' ? info.v : info.text;
        if (columnSamples[colName].length < 3 && !columnSamples[colName].includes(info.text)) columnSamples[colName].push(info.text);
      } else {
        rowObj[colName] = '';
      }
    }
    if (!hasData) continue; // blank row (its number is simply skipped; the others keep their real numbers)
    const firstCell = (cells[columnIndexMap[0]?.colName]?.text ?? '').trim().toLowerCase();
    if (firstCell === 'total' || firstCell === 'grand total' || firstCell === 'totals' || firstCell.startsWith('total ')) continue;
    rows.push({ rowNumber: r + 1, cells, merged });
    rawRows.push(rowObj);
  }

  return {
    sheetName,
    headerRowIndex: bestRow,
    headerRowNumber: bestRow + 1,
    detectedColumns,
    columnSamples,
    rawRows,
    rows,
    totalDataRows: rows.length,
    skippedHeaderCount: candidates.indexOf(bestRow),
  };
}

export interface SystemFieldDef {
  key: string;
  label: string;
  required: boolean;
  description: string;
  unitHint?: string;
  aliases: string[];
}

export const CATEGORY_FIELDS: Record<string, SystemFieldDef[]> = {
  plated_jewelry: [
    {
      key: 'item_id',
      label: 'Design Code / Item ID',
      required: true,
      description: 'Unique design identifier (e.g. 10101, PLT-001)',
      aliases: ['design code', 'item id', 'design id', 'design no', 'item name', 'item code', 'id', 'code', 'design', 'name', 'model', 'style'],
    },
    {
      key: 'quantity',
      label: 'Current Quantity',
      required: true,
      description: 'Physical stock in warehouse/store',
      aliases: ['balance qty', 'stock balance', 'current stock', 'quantity', 'qty', 'stock', 'pcs', 'balance', 'closing balance', 'closing stock', 'total pcs', 'avail qty'],
    },
    {
      key: 'unit',
      label: 'Measurement Unit',
      required: true,
      description: 'PC, KGS, SET, JODI or GRMS',
      unitHint: 'Defaults to PC if not present in Excel',
      aliases: ['unit', 'uom', 'unit of measure', 'units', 'measurement'],
    },
    {
      key: 'low_stock_threshold',
      label: 'Low Stock Threshold',
      required: true,
      description: 'Alert level for restock reminder',
      aliases: ['safety stock', 'safety', 'min threshold', 'minimum threshold', 'low stock threshold', 'min stock', 'threshold', 'low stock', 'min qty', 'minimum', 'reorder level', 'reorder', 'buffer'],
    },
    {
      key: 'cost_price',
      label: 'Cost Price (₹)',
      required: true,
      description: 'Purchase or manufacturing cost per unit in Rupees',
      aliases: ['cost price', 'cost', 'purchase price', 'price', 'rate', 'unit price', 'cost/pc', 'rate/pc', 'buying price', 'cost (rs)'],
    },
  ],
  raw_jewelry: [
    {
      key: 'item_id',
      label: 'Raw Casting Code / ID',
      required: true,
      description: 'Raw casting design code (e.g. RAW-001)',
      aliases: ['casting code', 'raw code', 'casting id', 'design code', 'casting no', 'item name', 'item id', 'id', 'code', 'name'],
    },
    {
      key: 'quantity',
      label: 'Current Quantity',
      required: true,
      description: 'Raw casting physical inventory',
      aliases: ['balance qty', 'stock balance', 'current stock', 'quantity', 'qty', 'stock', 'pcs', 'balance', 'closing balance', 'total pcs'],
    },
    {
      key: 'unit',
      label: 'Measurement Unit',
      required: true,
      description: 'PC, KGS, SET, JODI or GRMS',
      unitHint: 'Defaults to PC if not present in Excel',
      aliases: ['unit', 'uom', 'unit of measure', 'units', 'measurement'],
    },
    {
      key: 'low_stock_threshold',
      label: 'Low Stock Threshold',
      required: true,
      description: 'Alert level for casting restock',
      aliases: ['safety stock', 'safety', 'min threshold', 'minimum threshold', 'low stock threshold', 'min stock', 'threshold', 'low stock', 'min qty', 'minimum', 'reorder level', 'reorder', 'buffer'],
    },
  ],
  stones: [
    {
      key: 'item_id',
      label: 'Stone Code / Variety',
      required: true,
      description: 'Stone name or variety code (e.g. CZ-ROUND-2MM)',
      aliases: ['stone code', 'stone name', 'item name', 'stone id', 'variety', 'item id', 'id', 'stone', 'name', 'code', 'type'],
    },
    {
      key: 'quantity',
      label: 'Current Quantity (PC)',
      required: true,
      description: 'Stone count in pieces (unit is fixed to PC)',
      aliases: ['balance qty', 'stock balance', 'current stock', 'quantity', 'qty', 'stock', 'pcs', 'pieces', 'balance', 'total pcs'],
    },
    {
      key: 'low_stock_threshold',
      label: 'Low Stock Threshold',
      required: true,
      description: 'Minimum pieces before alert',
      aliases: ['safety stock', 'safety', 'min threshold', 'minimum threshold', 'low stock threshold', 'min stock', 'threshold', 'min pcs', 'min', 'reorder level', 'reorder', 'buffer'],
    },
    {
      key: 'cost_price',
      label: 'Cost Price per PC (₹)',
      required: true,
      description: 'Purchase cost per stone piece in Rupees',
      aliases: ['cost price', 'cost', 'purchase price', 'price', 'rate', 'unit price', 'rate/pc', 'cost/pc', 'rate (rs)'],
    },
  ],
  foil: [
    {
      key: 'item_id',
      label: 'Foil Code / Type',
      required: true,
      description: 'Silver or metal foil roll code (e.g. SIL-FOIL-999)',
      aliases: ['foil code', 'foil name', 'foil id', 'item name', 'item id', 'id', 'foil', 'name', 'code', 'type'],
    },
    {
      key: 'quantity',
      label: 'Current Quantity (KGS)',
      required: true,
      description: 'Weight in kilograms (unit is fixed to KGS)',
      aliases: ['balance qty', 'stock balance', 'current stock', 'quantity', 'qty', 'weight', 'stock', 'kgs', 'kg', 'balance', 'wt'],
    },
    {
      key: 'low_stock_threshold',
      label: 'Low Stock Threshold (KGS)',
      required: true,
      description: 'Minimum weight in kilograms before alert',
      aliases: ['safety stock', 'safety', 'min threshold', 'minimum threshold', 'low stock threshold', 'min stock', 'threshold', 'min kg', 'min', 'reorder level', 'reorder', 'buffer'],
    },
    {
      key: 'cost_price',
      label: 'Cost Price per KG (₹)',
      required: true,
      description: 'Purchase cost per kilogram in Rupees',
      aliases: ['cost price', 'cost', 'purchase price', 'price', 'rate', 'rate/kg', 'unit price', 'rate (rs)'],
    },
  ],
};

function scoreColumnMatch(colName: string, fieldKey: string, aliases: string[]): number {
  const cleanCol = colName.toLowerCase().replace(/[^a-z0-9]/g, ' ').trim();
  const subPart = colName.includes(' - ')
    ? colName.split(' - ')[1].toLowerCase().replace(/[^a-z0-9]/g, ' ').trim()
    : cleanCol;

  let bestScore = 0;
  for (const alias of aliases) {
    const cleanAlias = alias.toLowerCase().replace(/[^a-z0-9]/g, ' ').trim();

    // 1. Exact match with sub-header
    if (subPart === cleanAlias) {
      bestScore = Math.max(bestScore, 100);
    }
    // 2. Exact match with full column name
    else if (cleanCol === cleanAlias) {
      bestScore = Math.max(bestScore, 90);
    }
    // 3. Sub-part starts/ends with alias
    else if (subPart.endsWith(cleanAlias) || subPart.startsWith(cleanAlias)) {
      bestScore = Math.max(bestScore, 75);
    }
    // 4. Word boundary match
    else {
      const words = cleanCol.split(/\s+/);
      if (words.includes(cleanAlias)) {
        // Guard: if alias is "stock" and column is "Stock IN" or "Stock Out", penalize
        if (cleanAlias === 'stock' && (words.includes('in') || words.includes('out'))) {
          bestScore = Math.max(bestScore, 15);
        } else {
          bestScore = Math.max(bestScore, 50);
        }
      }
    }
  }

  // Bonus for Stock Balance columns over Stock IN/OUT for inventory masters
  if (bestScore > 0 && cleanCol.includes('balance') && (fieldKey === 'quantity' || fieldKey === 'item_id')) {
    bestScore += 20;
  }

  return bestScore;
}

/**
 * Automatically match detected Excel columns to system fields using smart heuristic scoring.
 */
export function autoMatchColumns(
  category: string,
  detectedColumns: string[]
): Record<string, string | null> {
  const fields = CATEGORY_FIELDS[category] || [];
  const mapping: Record<string, string | null> = {};
  const assignedCols = new Set<string>();

  for (const field of fields) {
    let bestCol: string | null = null;
    let highestScore = 0;

    for (const col of detectedColumns) {
      if (assignedCols.has(col)) continue;
      const score = scoreColumnMatch(col, field.key, field.aliases);
      if (score > highestScore && score >= 40) {
        highestScore = score;
        bestCol = col;
      }
    }

    if (bestCol) {
      mapping[field.key] = bestCol;
      assignedCols.add(bestCol);
    } else {
      mapping[field.key] = null;
    }
  }

  return mapping;
}

export interface ColumnTarget {
  sheet: string;
  column: string;
}

export function serializeTarget(sheet: string, column: string): string {
  return `${sheet}::${column}`;
}

export function parseTarget(val: string | null | undefined): ColumnTarget | null {
  if (!val) return null;
  const idx = val.indexOf('::');
  if (idx === -1) {
    return { sheet: '', column: val };
  }
  return {
    sheet: val.slice(0, idx),
    column: val.slice(idx + 2),
  };
}

export interface SheetLinkDef {
  sheetA: string;
  colA: string;
  sheetB: string;
  colB: string;
  matchCount: number;
  overlapPercent: number;
}

/**
 * Automatically detect common/similar bridge columns between sheets (e.g. Item ID / Name across Sheet 1 & Sheet 2).
 * Compares actual non-numeric cell values across columns to calculate intersection overlap and content similarity.
 */
export function detectSheetLinks(
  parsedSheets: Record<string, ParsedExcelResult>,
  primarySheetName: string
): Record<string, SheetLinkDef> {
  const links: Record<string, SheetLinkDef> = {};
  const sA = parsedSheets[primarySheetName];
  if (!sA) return links;

  for (const [sheetB, sB] of Object.entries(parsedSheets)) {
    if (sheetB === primarySheetName) continue;

    let bestLink: SheetLinkDef | null = null;
    let highestScore = 0;

    for (const colA of sA.detectedColumns) {
      const valsA = sA.rawRows
        .map((r) => String(r[colA] ?? '').trim())
        .filter((v) => v.length > 0 && isNaN(Number(v)));
      if (valsA.length === 0) continue;
      const setA = new Set(valsA.map((v) => v.toLowerCase()));

      for (const colB of sB.detectedColumns) {
        const valsB = sB.rawRows
          .map((r) => String(r[colB] ?? '').trim())
          .filter((v) => v.length > 0 && isNaN(Number(v)));
        if (valsB.length === 0) continue;

        let matchCount = 0;
        for (const v of valsB) {
          if (setA.has(v.toLowerCase())) matchCount++;
        }

        if (matchCount > 0) {
          let bonus = 0;
          const lowerA = colA.toLowerCase();
          const lowerB = colB.toLowerCase();
          if (lowerA.includes('balance') || lowerB.includes('balance')) bonus += 15;
          if (lowerA.includes('item') || lowerA.includes('product') || lowerA.includes('desc') || lowerA.includes('name')) bonus += 10;
          if (lowerB.includes('item') || lowerB.includes('product') || lowerB.includes('desc') || lowerB.includes('name')) bonus += 10;

          const score = matchCount * 10 + bonus;
          if (score > highestScore) {
            highestScore = score;
            bestLink = {
              sheetA: primarySheetName,
              colA,
              sheetB,
              colB,
              matchCount,
              overlapPercent: Math.round((matchCount / Math.min(setA.size, valsB.length)) * 100),
            };
          }
        }
      }
    }

    if (bestLink) {
      links[sheetB] = bestLink;
    }
  }

  return links;
}
