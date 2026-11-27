import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import type { GeneratedPdfResult } from './pdfGenerator';
import type { Transaction } from '../types';
import { formatIST } from './time';

/**
 * Transaction history PDF (requested 2026-11-21): every stock movement matching the filters on screen (all pages,
 * not only the 50 shown), with the filters printed at the top so the paper says exactly what it covers.
 */

const CATEGORY_LABEL: Record<string, string> = {
  plated_jewelry: 'Plated Jewelry',
  raw_jewelry: 'Raw Jewelry',
  stones: 'Kundan Stone',
  foil: 'Foil',
};

export interface HistoryPdfOptions {
  rows: Transaction[];
  filters: { category?: string; dateFrom?: string; dateTo?: string; itemSearch?: string; remarkSearch?: string };
  /** false = offline copy on this phone (recent entries only): printed on the PDF. */
  complete: boolean;
}

const day = (d: string) =>
  new Date(`${d}T00:00:00+05:30`).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric' });
const num = (n: number) => (Number.isInteger(n) ? n.toLocaleString('en-IN') : n.toLocaleString('en-IN', { maximumFractionDigits: 3 }));

export function filtersText(f: HistoryPdfOptions['filters']): string {
  const parts = [`Category: ${f.category ? CATEGORY_LABEL[f.category] || f.category : 'All'}`];
  if (f.dateFrom && f.dateTo) parts.push(`Dates: ${day(f.dateFrom)} to ${day(f.dateTo)}`);
  else if (f.dateFrom) parts.push(`Dates: from ${day(f.dateFrom)}`);
  else if (f.dateTo) parts.push(`Dates: up to ${day(f.dateTo)}`);
  else parts.push('Dates: all');
  if (f.itemSearch?.trim()) parts.push(`Item code: "${f.itemSearch.trim()}"`);
  if (f.remarkSearch?.trim()) parts.push(`Remarks contain: "${f.remarkSearch.trim()}"`);
  return parts.join('   |   ');
}

export function generateHistoryPdf({ rows, filters, complete }: HistoryPdfOptions): GeneratedPdfResult {
  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
  const W = doc.internal.pageSize.getWidth();
  const H = doc.internal.pageSize.getHeight();
  const now = new Date();

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(15);
  doc.setTextColor(15, 23, 42);
  doc.text('Poonam Creation - Stock Movement History', 12, 15);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.setTextColor(71, 85, 105);
  doc.text(filtersText(filters), 12, 21);
  doc.text(`Generated ${formatIST(now)} (IST)   |   ${rows.length} movement${rows.length === 1 ? '' : 's'}`, 12, 26);
  let y = 31;
  if (!complete) {
    doc.setTextColor(180, 83, 9);
    doc.text('Made offline from this phone: only the recent movements stored on the phone are included.', 12, y);
    y += 5;
  }

  // Totals per unit (pieces, grams and kg are never added together)
  const byUnit = new Map<string, { in: number; out: number }>();
  for (const t of rows) {
    const u = byUnit.get(t.unit) || { in: 0, out: 0 };
    if (t.operation === 'add') u.in += Number(t.quantity_change) || 0;
    else u.out += Number(t.quantity_change) || 0;
    byUnit.set(t.unit, u);
  }
  const totals = [...byUnit.entries()].sort(([a], [b]) => a.localeCompare(b));
  doc.setTextColor(15, 23, 42);
  doc.setFont('helvetica', 'bold');
  doc.text(
    `Stock in: ${totals.filter(([, v]) => v.in).map(([u, v]) => `+${num(v.in)} ${u}`).join('  ') || '0'}      Stock out: ${
      totals.filter(([, v]) => v.out).map(([u, v]) => `-${num(v.out)} ${u}`).join('  ') || '0'
    }`,
    12,
    y,
  );

  autoTable(doc, {
    startY: y + 4,
    head: [['#', 'Date & time (IST)', 'Category', 'Item code', 'Operation', 'Qty', 'Unit', 'Before', 'After', 'Done by', 'Remarks']],
    body: rows.map((t, i) => [
      String(i + 1),
      formatIST(t.created_at),
      CATEGORY_LABEL[t.category] || t.category,
      t.item_display_id,
      `${t.operation === 'add' ? 'STOCK IN' : 'STOCK OUT'}${t.reverses_id ? '\n(undo)' : ''}${t.undone_by ? `\n(undone by ${t.undone_by})` : ''}`,
      `${t.operation === 'add' ? '+' : '-'}${num(Number(t.quantity_change))}`,
      t.unit,
      num(Number(t.quantity_before)),
      num(Number(t.quantity_after)),
      t.performer_name || t.performed_by || '',
      t.remarks || '',
    ]),
    theme: 'striped',
    styles: { fontSize: 8, cellPadding: 1.6, overflow: 'linebreak' },
    headStyles: { fillColor: [30, 58, 74], textColor: [255, 255, 255], fontStyle: 'bold' },
    alternateRowStyles: { fillColor: [248, 250, 252] },
    columnStyles: {
      0: { cellWidth: 10, halign: 'center' },
      1: { cellWidth: 40 },
      3: { fontStyle: 'bold' },
      5: { halign: 'right' },
      7: { halign: 'right' },
      8: { halign: 'right' },
    },
    didParseCell: (d) => {
      if (d.section === 'body' && (d.column.index === 4 || d.column.index === 5)) {
        d.cell.styles.textColor = String((d.row.raw as string[])[4]).startsWith('STOCK IN') ? [4, 120, 87] : [185, 28, 28];
      }
    },
    margin: { left: 12, right: 12, bottom: 14 },
  });

  const pages = doc.getNumberOfPages();
  for (let i = 1; i <= pages; i++) {
    doc.setPage(i);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.5);
    doc.setTextColor(148, 163, 184);
    doc.text('Poonam Creation - Stock movement record', 12, H - 6);
    doc.text(`Page ${i} of ${pages}`, W - 12, H - 6, { align: 'right' });
  }

  const stamp = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  const filename = `Poonam_Stock_History_${stamp}.pdf`;
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
