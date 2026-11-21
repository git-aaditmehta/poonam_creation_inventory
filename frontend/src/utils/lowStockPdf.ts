import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import type { GeneratedPdfResult } from './pdfGenerator';
import { formatIST } from './time';

/**
 * Low stock PDF (requested 2026-11-21): the items below their minimum, for the filters on screen (or everything).
 * Owner and staff: no cost prices anywhere.
 */
export interface LowStockPdfRow {
  category_name: string;
  item_id: string;
  quantity: number;
  low_stock_threshold: number;
  unit: string;
}

const num = (n: number) => (Number.isInteger(n) ? n.toLocaleString('en-IN') : n.toLocaleString('en-IN', { maximumFractionDigits: 3 }));

export function generateLowStockPdf(rows: LowStockPdfRow[], filterText: string): GeneratedPdfResult {
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const W = doc.internal.pageSize.getWidth();
  const H = doc.internal.pageSize.getHeight();
  const now = new Date();

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(15);
  doc.setTextColor(15, 23, 42);
  doc.text('Poonam Creation - Low Stock List', 14, 16);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.setTextColor(71, 85, 105);
  doc.text(filterText, 14, 22);
  doc.text(`Generated ${formatIST(now)} (IST)   |   ${rows.length} item${rows.length === 1 ? '' : 's'} below minimum`, 14, 27);

  autoTable(doc, {
    startY: 32,
    head: [['#', 'Category', 'Item code', 'In stock', 'Minimum', 'Short by', 'Unit']],
    body: rows.map((r, i) => [
      String(i + 1),
      r.category_name,
      r.item_id,
      num(r.quantity),
      num(r.low_stock_threshold),
      num(Math.max(0, r.low_stock_threshold - r.quantity)),
      r.unit,
    ]),
    theme: 'striped',
    styles: { fontSize: 8.5, cellPadding: 2 },
    headStyles: { fillColor: [146, 64, 14], textColor: [255, 255, 255], fontStyle: 'bold' },
    alternateRowStyles: { fillColor: [255, 251, 235] },
    columnStyles: {
      0: { cellWidth: 10, halign: 'center' },
      2: { fontStyle: 'bold' },
      3: { halign: 'right', textColor: [185, 28, 28], fontStyle: 'bold' },
      4: { halign: 'right' },
      5: { halign: 'right' },
      6: { cellWidth: 16, halign: 'center' },
    },
    margin: { left: 14, right: 14, bottom: 14 },
  });

  const pages = doc.getNumberOfPages();
  for (let i = 1; i <= pages; i++) {
    doc.setPage(i);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.5);
    doc.setTextColor(148, 163, 184);
    doc.text('Poonam Creation - Low stock list (no prices)', 14, H - 7);
    doc.text(`Page ${i} of ${pages}`, W - 14, H - 7, { align: 'right' });
  }

  const stamp = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  const filename = `Poonam_Low_Stock_${stamp}.pdf`;
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
