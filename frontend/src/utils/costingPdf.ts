import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import type { GeneratedPdfResult } from './pdfGenerator';

/**
 * Jewelry Costing PDF (requested 2026-11-21): the Spreadsheet view on paper. One row per design, one column per
 * material category; a category the design does not use is left blank. Owner-only data (costs).
 * Prices are written "Rs." because the PDF's built-in font has no rupee sign.
 */

export interface CostingPdfMaterial {
  name: string;
  quantity: number;
  /** null when the material has no price yet */
  cost: number | null;
}

export interface CostingPdfRow {
  itemId: string;
  weight: number;
  weightCost: number | null;
  /** category id -> the design's materials in that category (missing or empty = blank cell) */
  cells: Record<string, CostingPdfMaterial[]>;
  totalCost: number | null;
  incomplete: boolean;
}

export interface CostingPdfOptions {
  categories: { id: string; name: string }[];
  rows: CostingPdfRow[];
  multiplierX: number;
  totals: { weightCost: number; categoryTotals: Record<string, number>; grandTotal: number };
  /** The search the screen was filtered by, if any (printed so a partial list is never mistaken for all designs). */
  search?: string;
}

const rs = (n: number | null | undefined) =>
  n === null || n === undefined || !Number.isFinite(n)
    ? ''
    : `Rs. ${n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function generateCostingPdf({ categories, rows, multiplierX, totals, search }: CostingPdfOptions): GeneratedPdfResult {
  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
  const pageWidth = doc.internal.pageSize.getWidth();
  const now = new Date();
  const date = now.toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric' });
  const time = now.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: true });

  // Header
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(15);
  doc.setTextColor(15, 23, 42);
  doc.text('Poonam Creation - Jewelry Costing', 14, 16);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.setTextColor(71, 85, 105);
  const sub = [`Generated ${date}, ${time} (IST)`, `Multiplier X: ${rs(multiplierX)} per gm`, `${rows.length} design${rows.length === 1 ? '' : 's'}`];
  if (search?.trim()) sub.push(`Filtered by search: "${search.trim()}"`);
  doc.text(sub.join('   |   '), 14, 22);

  // Smaller text when there are many category columns, so every column fits the page width
  const columnCount = categories.length + 3;
  const fontSize = columnCount <= 7 ? 8.5 : columnCount <= 10 ? 7.5 : 6.5;

  const head = [['Jewelry ID / Design', 'Jewelry Weight', ...categories.map((c) => c.name.toUpperCase()), 'Total Cost']];
  const body = rows.map((r) => [
    r.incomplete ? `${r.itemId}\n(missing prices)` : r.itemId,
    `${r.weight.toFixed(2)} gms\n${rs(r.weightCost)}`,
    ...categories.map((c) =>
      (r.cells[c.id] || []).map((m) => `${m.name} (${m.quantity})  ${m.cost === null ? 'Missing price' : rs(m.cost)}`).join('\n'),
    ),
    rs(r.totalCost),
  ]);
  const foot = [[
    `Summary (${rows.length} Design${rows.length === 1 ? '' : 's'})`,
    rs(totals.weightCost),
    ...categories.map((c) => rs(totals.categoryTotals[c.id] ?? 0)),
    rs(totals.grandTotal),
  ]];

  autoTable(doc, {
    startY: 27,
    head,
    body,
    foot,
    showFoot: 'lastPage',
    theme: 'grid',
    styles: { fontSize, cellPadding: 1.8, valign: 'top', lineColor: [203, 213, 225], lineWidth: 0.2, overflow: 'linebreak' },
    headStyles: { fillColor: [30, 58, 74], textColor: [255, 255, 255], fontStyle: 'bold', fontSize },
    footStyles: { fillColor: [241, 245, 249], textColor: [15, 23, 42], fontStyle: 'bold', fontSize },
    columnStyles: {
      0: { fontStyle: 'bold', cellWidth: 30 },
      1: { cellWidth: 26 },
      [columnCount - 1]: { halign: 'right', fontStyle: 'bold', cellWidth: 26 },
    },
    didParseCell: (data) => {
      // "missing prices" notes in amber
      if (data.section === 'body' && typeof data.cell.raw === 'string' && /missing price/i.test(data.cell.raw)) {
        data.cell.styles.textColor = [180, 83, 9];
      }
    },
    margin: { left: 10, right: 10, bottom: 14 },
  });

  const pages = doc.getNumberOfPages();
  for (let i = 1; i <= pages; i++) {
    doc.setPage(i);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.5);
    doc.setTextColor(148, 163, 184);
    doc.text('Poonam Creation - Private costing record (owner only)', 10, doc.internal.pageSize.getHeight() - 6);
    doc.text(`Page ${i} of ${pages}`, pageWidth - 10, doc.internal.pageSize.getHeight() - 6, { align: 'right' });
  }

  const stamp = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  const filename = `Poonam_Creation_Jewelry_Costing_${stamp}.pdf`;
  const blob = doc.output('blob');
  return {
    doc,
    blob,
    url: URL.createObjectURL(blob),
    file: new File([blob], filename, { type: 'application/pdf' }),
    filename,
    totalItems: rows.length,
    unitTotals: {},
  };
}
