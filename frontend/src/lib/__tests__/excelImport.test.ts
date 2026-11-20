import { describe, it, expect } from 'vitest';
import * as XLSX from 'xlsx';
import { parseExcelWorksheet, type ParsedExcelResult } from '../../utils/excelParser';
import {
  autoMatch,
  mappingIssues,
  buildRows,
  checkRow,
  duplicateIndex,
  readNumber,
  readUnit,
  summarize,
  codeText,
  target,
  type ImportCategory,
  type FieldMatch,
  type ImportField,
} from '../../utils/excelImport';

let n = 0;
const makeId = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
const sheetOf = (aoa: unknown[][], name = 'S') => parseExcelWorksheet(XLSX.utils.aoa_to_sheet(aoa), name);
const cols = (m: Record<string, FieldMatch>) => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, v.target?.split('::')[1] ?? null]));

function stage(category: ImportCategory, sheets: Record<string, ParsedExcelResult>, primary: string, extra: Partial<Record<ImportField, FieldMatch>> = {}, linkColumns: Record<string, string> = {}) {
  const mapping = { ...autoMatch(category, sheets, primary), ...extra };
  const rows = buildRows({ category, sheets, mapping, defaults: {}, linkColumns, makeId });
  const first = duplicateIndex(rows);
  return { mapping, rows, checks: rows.map((r) => checkRow(r, category, first)) };
}

describe('column matching (E2)', () => {
  it('prefers Design Code over Item Name, Closing Qty over Low Stock Qty, never Sale Price as cost', () => {
    const s = sheetOf([['Item Name', 'Design Code', 'Low Stock Qty', 'Closing Qty', 'Unit', 'Sale Price'], ['Kundan Jhumka', 'JK 33', 5, 50, 'Sets', 900]]);
    const m = autoMatch('plated_jewelry', { S: s }, 'S');
    expect(cols(m)).toEqual({ item_id: 'Design Code', quantity: 'Closing Qty', unit: 'Unit', low_stock_threshold: 'Low Stock Qty', cost_price: null });
    expect(m.item_id.how).toBe('auto-sure');
  });
  it('marks guesses and conflicts for confirmation; blocks one column used twice', () => {
    const s = sheetOf([['Item Name', 'Stock', 'Rate'], ['Kundan Jhumka', 5, 10]]);
    const m = autoMatch('plated_jewelry', { S: s }, 'S');
    expect(m.item_id.how).toBe('auto-check');
    const issues = mappingIssues('plated_jewelry', { S: s }, m, {});
    expect(issues.some((i) => i.field === 'item_id' && /look like names/.test(i.message))).toBe(true);
    const twice = { ...m, low_stock_threshold: { target: target('S', 'Stock'), how: 'user' as const } };
    expect(mappingIssues('plated_jewelry', { S: s }, twice, {}).some((i) => i.level === 'block' && /already used/.test(i.message))).toBe(true);
  });
  it('warns when the user picks a selling price or a low-stock column', () => {
    const s = sheetOf([['Design Code', 'Min Stock', 'MRP'], ['PS 1', 5, 10]]);
    const m = { ...autoMatch('plated_jewelry', { S: s }, 'S'), quantity: { target: target('S', 'Min Stock'), how: 'user' as const }, cost_price: { target: target('S', 'MRP'), how: 'user' as const } };
    const msgs = mappingIssues('plated_jewelry', { S: s }, m, {}).map((i) => i.message).join('\n');
    expect(msgs).toMatch(/looks like a low-stock level/);
    expect(msgs).toMatch(/looks like a selling price/);
  });
  it('"In Stock" is a quantity, "Stock In" is not', () => {
    const s = sheetOf([['Design Code', 'Stock In', 'In Stock'], ['PS 1', 5, 10]]);
    expect(cols(autoMatch('plated_jewelry', { S: s }, 'S')).quantity).toBe('In Stock');
  });
});

describe('reading values', () => {
  it('units (E3): spellings, blank = PC, unknown is a problem', () => {
    expect(['Sets', 'Pcs', 'Pair', 'Jodis', 'Kilo', 'Gr', 'kg.', 'nos'].map((u) => readUnit(u))).toEqual(['SET', 'PC', 'JODI', 'JODI', 'KGS', 'GRMS', 'KGS', 'PC']);
    expect(readUnit('')).toBeNull();
    expect(readUnit('Dozen')).toBe('unknown');
    const { rows, checks } = stage('plated_jewelry', { S: sheetOf([['Design Code', 'Qty', 'Unit', 'Min', 'Cost'], ['PS 1', 5, 'Sets', 1, 10], ['PS 2', 5, '', 1, 10], ['PS 3', 5, 'Dozen', 1, 10]]) }, 'S');
    expect(rows.map((r) => r.values.unit)).toEqual(['SET', 'PC', 'Dozen']);
    expect(rows[0].notes.unit).toMatch(/Read "Sets" as SET/);
    expect(rows[1].notes.unit).toMatch(/set to PC/);
    expect(checks[2].problems.map((p) => p.message).join()).toMatch(/Unit "Dozen" is not one the app knows/);
    expect(checks[0].save?.unit).toBe('SET');
  });
  it('numbers (E7): ₹, Rs, commas, /-, unit words read with a note; anything else is a problem', () => {
    expect(readNumber('1,25,000', 'Quantity')).toMatchObject({ ok: true, value: 125000 });
    expect(readNumber('₹1,250.00', 'Cost price')).toMatchObject({ ok: true, value: 1250 });
    expect(readNumber('Rs. 99/-', 'Cost price')).toMatchObject({ ok: true, value: 99 });
    expect(readNumber('50 pcs', 'Quantity', true)).toMatchObject({ ok: true, value: 50 });
    expect((readNumber('₹1,250.00', 'Cost price') as { note: string }).note).toMatch(/read "₹1,250.00" as 1250/);
    expect(readNumber('50-60', 'Quantity')).toMatchObject({ ok: false, empty: false });
    expect(readNumber('approx 50', 'Quantity')).toMatchObject({ ok: false, empty: false });
    expect(readNumber(0.1 + 0.2, 'Quantity')).toMatchObject({ ok: true, value: 0.3 }); // E9 float leftover
  });
  it('decimals and negatives get a clear message (whole numbers except Foil)', () => {
    const { checks } = stage('plated_jewelry', { S: sheetOf([['Design Code', 'Qty', 'Unit', 'Min', 'Cost'], ['PS 1', 12.5, 'PC', -1, 10]]) }, 'S');
    const m = checks[0].problems.map((p) => p.message).join('\n');
    expect(m).toMatch(/Quantity has decimals \(12.5\). Plated Jewelry is counted in whole numbers/);
    expect(m).toMatch(/Low stock level can't be negative/);
    const foil = stage('foil', { S: sheetOf([['Foil Code', 'Qty', 'Min', 'Cost'], ['F1', 1.23456, 0.5, 10.555]]) }, 'S');
    expect(foil.checks[0].problems).toEqual([]);
    expect(foil.checks[0].save).toMatchObject({ quantity: 1.235, cost_price: 10.56 });
    expect(foil.checks[0].warnings.map((w) => w.message).join('\n')).toMatch(/will be saved as 1.235[\s\S]*will be saved as ₹10.56/);
  });
});

describe('design codes (E4) and rows (E6, E8)', () => {
  it('codes stay exactly as Excel shows them; CSV text is never converted', () => {
    const ws = XLSX.utils.aoa_to_sheet([['Design Code', 'Qty'], [123, 5]]);
    ws.A2.z = '00000';
    ws.A2.w = '00123';
    expect(codeText(parseExcelWorksheet(ws, 'S').rows[0].cells['Design Code'])).toBe('00123');
    const csv = 'Design Code,Qty\n00123,5\n10-12,5\n1/2,5\n1E5,5\n';
    const wb = XLSX.read(csv, { type: 'string', raw: true });
    const p = parseExcelWorksheet(wb.Sheets[wb.SheetNames[0]], 'csv');
    expect(p.rows.map((r) => codeText(r.cells['Design Code']))).toEqual(['00123', '10-12', '1/2', '1E5']);
  });
  it('real Excel row numbers, blank rows and title rows included', () => {
    const p = sheetOf([['Poonam stock'], [], ['Design Code', 'Qty'], ['PS 1', 1], [], ['PS 2', 2], ['', ''], ['PS 3', 3]]);
    expect(p.rows.map((r) => r.rowNumber)).toEqual([4, 6, 8]);
  });
  it('a merged quantity is not copied to the next row: top row warned, other row must be filled', () => {
    const ws = XLSX.utils.aoa_to_sheet([['Design Code', 'Qty', 'Unit', 'Min', 'Cost'], ['PS 1', 10, 'PC', 1, 1], ['PS 2', null, 'PC', 1, 1]]);
    ws['!merges'] = [{ s: { r: 1, c: 1 }, e: { r: 2, c: 1 } }];
    const { rows, checks } = stage('plated_jewelry', { S: parseExcelWorksheet(ws, 'S') }, 'S');
    expect(rows.map((r) => r.values.quantity)).toEqual(['10', '']);
    expect(checks[0].warnings[0].message).toMatch(/merged cell shared by rows 2–3/);
    expect(checks[1].problems[0].message).toMatch(/shares a merged quantity cell with row 2/);
  });
  it('duplicate codes in the file (capitals, spaces, dashes ignored)', () => {
    const { checks } = stage('plated_jewelry', { S: sheetOf([['Design Code', 'Qty', 'Unit', 'Min', 'Cost'], ['PS 1', 1, 'PC', 1, 1], ['ps-1', 1, 'PC', 1, 1]]) }, 'S');
    expect(checks[0].problems).toEqual([]);
    expect(checks[1].problems[0].message).toMatch(/Same design code as row 2 \("PS 1"\)/);
  });
});

describe('second sheet (E1): by design code only, never by row position', () => {
  const stock = sheetOf([['Design Code', 'Qty', 'Unit', 'Min'], ['PS 1', 5, 'PC', 1], ['PS 2', 6, 'PC', 1], ['PS 3', 7, 'PC', 1]], 'Stock');
  const prices = sheetOf([['Design', 'Cost'], ['ps-2', 200], ['PS 1', 100], ['PS 9', 900]], 'Prices');
  const sheets = { Stock: stock, Prices: prices };
  it('finds each design in the other sheet in any order; a missing one is a problem', () => {
    const { rows, checks } = stage('plated_jewelry', sheets, 'Stock', { cost_price: { target: target('Prices', 'Cost'), how: 'user' } }, { Prices: 'Design' });
    expect(rows.map((r) => r.values.cost_price)).toEqual(['100', '200', '']);
    expect(checks[2].problems[0].message).toMatch(/"PS 3" was not found in sheet "Prices"/);
    expect(checks[2].save).toBeUndefined();
  });
  it('a code twice in the other sheet is ambiguous, not guessed', () => {
    const dup = sheetOf([['Design', 'Cost'], ['PS 1', 100], ['PS 1', 150]], 'Prices');
    const { checks } = stage('plated_jewelry', { Stock: stock, Prices: dup }, 'Stock', { cost_price: { target: target('Prices', 'Cost'), how: 'user' } }, { Prices: 'Design' });
    expect(checks[0].problems[0].message).toMatch(/appears 2 times in sheet "Prices"/);
  });
});

describe('summary before saving', () => {
  it('counts ready / problem rows, quantity per unit and value', () => {
    const { rows, checks } = stage('plated_jewelry', { S: sheetOf([['Design Code', 'Qty', 'Unit', 'Min', 'Cost'], ['PS 1', 10, 'PC', 1, 100], ['PS 2', 2, 'SET', 1, 50], ['PS 3', 1.5, 'PC', 1, 10]]) }, 'S');
    const map = new Map(rows.map((r, i) => [r.key, checks[i]]));
    expect(summarize('plated_jewelry', rows, map)).toMatchObject({ rowsInFile: 3, ready: 2, problems: 1, quantityByUnit: { PC: 10, SET: 2 }, totalValue: 1100 });
  });
});
