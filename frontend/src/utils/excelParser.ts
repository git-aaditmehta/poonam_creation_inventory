import * as XLSX from 'xlsx';

export interface ParsedExcelResult {
  sheetName: string;
  headerRowIndex: number;
  detectedColumns: string[];
  columnSamples: Record<string, string[]>;
  rawRows: Record<string, any>[];
  totalDataRows: number;
  skippedHeaderCount: number;
}

/**
 * Common inventory keywords used to score potential header rows.
 */
const HEADER_KEYWORDS = [
  'id', 'code', 'item', 'product', 'design', 'casting', 'stone', 'foil',
  'name', 'description', 'title', 'qty', 'quantity', 'stock', 'pcs', 'pieces',
  'kgs', 'kg', 'weight', 'set', 'jodi', 'unit', 'uom', 'min', 'low', 'threshold',
  'safety', 'reorder', 'balance', 'closing', 'cost', 'price', 'rate', 'mrp',
  'amount', 'val', 'value', 'sr', 'no', 'sno', 'sales', 'purchase', 'status', 'date',
];

/**
 * Propagate values of merged cells across the entire merge range.
 * This ensures vertically and horizontally merged cells (e.g. "Safety Stock" and "Stock Status")
 * are not lost as empty cells in SheetJS 2D output.
 */
function applyWorksheetMerges(worksheet: XLSX.WorkSheet): any[][] {
  const merges = worksheet['!merges'] || [];
  if (merges.length > 0) {
    for (const m of merges) {
      const startCellAddr = XLSX.utils.encode_cell(m.s);
      const startCell = worksheet[startCellAddr];
      if (!startCell || startCell.v === undefined || startCell.v === '') continue;

      for (let R = m.s.r; R <= m.e.r; ++R) {
        for (let C = m.s.c; C <= m.e.c; ++C) {
          if (R === m.s.r && C === m.s.c) continue;
          const cellAddr = XLSX.utils.encode_cell({ r: R, c: C });
          if (!worksheet[cellAddr] || worksheet[cellAddr].v === undefined || worksheet[cellAddr].v === '') {
            worksheet[cellAddr] = { ...startCell };
          }
        }
      }
    }
  }

  return XLSX.utils.sheet_to_json(worksheet, {
    header: 1,
    defval: '',
    blankrows: false,
  });
}

/**
 * Intelligently parse an Excel worksheet:
 * 1. Propagates merged cells (e.g. vertical merges spanning multiple header rows)
 * 2. Distinguishes titles/headings from the real column header row
 * 3. Supports 2-tier grouped headers (e.g. "Stock Balance - Balance Qty", "Safety Stock")
 * 4. Extracts only the genuine column names (no top titles)
 * 5. Extracts sample preview values for each column
 * 6. Returns parsed data rows mapped by detected column names
 */
export function parseExcelWorksheet(worksheet: XLSX.WorkSheet, sheetName: string): ParsedExcelResult {
  // Read as raw 2D array with merged cells populated
  const rawGrid = applyWorksheetMerges(worksheet);

  if (!rawGrid || rawGrid.length === 0) {
    throw new Error('The spreadsheet is empty.');
  }

  // Find the true header row among the first 20 rows
  const maxScanRows = Math.min(20, rawGrid.length);
  let bestRowIndex = 0;
  let highestScore = -1000;

  for (let r = 0; r < maxScanRows; r++) {
    const row = rawGrid[r] || [];
    const nonBlankCells = row
      .map((val) => String(val ?? '').trim())
      .filter((val) => val.length > 0);

    // A header row must have at least 2 distinct non-empty column titles
    if (nonBlankCells.length < 2) {
      continue;
    }

    // If all non-blank cells have the exact same text, it's a merged title/banner across the sheet
    const uniqueValues = new Set(nonBlankCells.map((c) => c.toLowerCase()));
    if (uniqueValues.size <= 1) {
      continue;
    }

    let stringCount = 0;
    let numberCount = 0;
    let keywordCount = 0;

    for (const cell of nonBlankCells) {
      if (!isNaN(Number(cell)) && cell !== '') {
        numberCount++;
      } else {
        stringCount++;
        const lower = cell.toLowerCase();
        for (const kw of HEADER_KEYWORDS) {
          if (lower === kw || lower.includes(kw)) {
            keywordCount++;
            break;
          }
        }
      }
    }

    // Data rows have mostly numbers (quantities, dates, balances); header rows have labels
    if (numberCount > stringCount) {
      continue;
    }

    const score = uniqueValues.size * 10 + keywordCount * 5 + stringCount * 2 - numberCount * 20;

    if (score > highestScore) {
      highestScore = score;
      bestRowIndex = r;
    }
  }

  const headerRow = rawGrid[bestRowIndex] || [];
  // Check if there is a parent group header row immediately above
  const parentRow = bestRowIndex > 0 ? rawGrid[bestRowIndex - 1] || [] : null;

  // Verify if parentRow is a genuine group header row (has multiple distinct group labels)
  const isParentGroupRow = parentRow
    ? (() => {
        const pCells = parentRow.map((v: any) => String(v ?? '').trim()).filter(Boolean);
        const pUniq = new Set(pCells.map((v: string) => v.toLowerCase()));
        return pUniq.size >= 2 && pUniq.size <= headerRow.length;
      })()
    : false;

  const detectedColumns: string[] = [];
  const columnIndexMap: { colName: string; rawIdx: number }[] = [];
  const seenNames = new Map<string, number>();

  for (let c = 0; c < headerRow.length; c++) {
    const sub = String(headerRow[c] ?? '').trim().replace(/\s+/g, ' ');
    const parent = isParentGroupRow && parentRow ? String(parentRow[c] ?? '').trim().replace(/\s+/g, ' ') : '';

    if (!sub && !parent) continue;

    let colName = sub;
    if (!colName) {
      colName = parent;
    } else if (
      parent &&
      parent.toLowerCase() !== sub.toLowerCase() &&
      !parent.toLowerCase().includes('tracker') &&
      !parent.toLowerCase().includes('value>>')
    ) {
      // Disambiguate multi-level headers: e.g. "Stock Balance - Item Name"
      colName = `${parent} - ${sub}`;
    }

    // Handle duplicate column names
    const count = seenNames.get(colName.toLowerCase()) || 0;
    seenNames.set(colName.toLowerCase(), count + 1);

    const uniqueName = count > 0 ? `${colName} (${count + 1})` : colName;
    detectedColumns.push(uniqueName);
    columnIndexMap.push({ colName: uniqueName, rawIdx: c });
  }

  if (detectedColumns.length === 0) {
    throw new Error('Could not identify any valid column headers in this spreadsheet.');
  }

  // Parse data rows starting after the header row
  const rawRows: Record<string, any>[] = [];
  const columnSamples: Record<string, string[]> = {};
  detectedColumns.forEach((col) => {
    columnSamples[col] = [];
  });

  for (let r = bestRowIndex + 1; r < rawGrid.length; r++) {
    const row = rawGrid[r] || [];

    // Check if row has any non-empty data in the mapped columns
    let hasData = false;
    const rowObj: Record<string, any> = {};

    for (const { colName, rawIdx } of columnIndexMap) {
      const val = row[rawIdx];
      const stringVal = val !== undefined && val !== null ? String(val).trim() : '';

      if (stringVal.length > 0) {
        hasData = true;
        rowObj[colName] = typeof val === 'number' ? val : stringVal;

        // Collect sample values (up to 3 distinct samples)
        if (
          columnSamples[colName].length < 3 &&
          !columnSamples[colName].includes(stringVal)
        ) {
          columnSamples[colName].push(stringVal);
        }
      } else {
        rowObj[colName] = '';
      }
    }

    // Check for summary/total rows at the end of the sheet
    const firstCell = String(row[columnIndexMap[0]?.rawIdx] ?? '').trim().toLowerCase();
    const isTotalRow =
      firstCell === 'total' ||
      firstCell === 'grand total' ||
      firstCell === 'totals' ||
      firstCell.startsWith('total ');

    if (hasData && !isTotalRow) {
      rawRows.push(rowObj);
    }
  }

  return {
    sheetName,
    headerRowIndex: bestRowIndex,
    detectedColumns,
    columnSamples,
    rawRows,
    totalDataRows: rawRows.length,
    skippedHeaderCount: bestRowIndex,
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
      description: 'PC, KGS, SET, or JODI',
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
      description: 'PC, KGS, SET, or JODI',
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
