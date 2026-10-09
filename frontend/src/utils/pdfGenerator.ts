import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';

export interface ExportStockItem {
  item_id: string;
  quantity: number;
  unit: string;
  low_stock_threshold: number;
  updated_at: string;
}

export interface GeneratePdfOptions {
  category: 'plated-jewelry' | 'raw-jewelry' | 'stones' | 'foil';
  categoryTitle: string;
  items: ExportStockItem[];
  generatedBy: string;
}

export interface GeneratedPdfResult {
  doc: jsPDF;
  blob: Blob;
  url: string;
  file: File;
  filename: string;
  totalItems: number;
  unitTotals: Record<string, number>;
}

export function generateStockPdf({
  categoryTitle,
  items,
  generatedBy,
}: GeneratePdfOptions): GeneratedPdfResult {
  const doc = new jsPDF({
    orientation: 'portrait',
    unit: 'mm',
    format: 'a4',
  });

  const now = new Date();
  const dateFormatted = now.toLocaleDateString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
  const timeFormatted = now.toLocaleTimeString('en-IN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  });

  // Calculate totals by unit
  const unitTotals: Record<string, number> = {};
  items.forEach((item) => {
    const unit = item.unit || 'PC';
    unitTotals[unit] = (unitTotals[unit] || 0) + Number(item.quantity || 0);
  });

  const filenameSafeCategory = categoryTitle.toLowerCase().replace(/[^a-z0-9]+/g, '_');
  const filename = `Poonam_Creation_${filenameSafeCategory}_Stock_${now.toISOString().split('T')[0]}.pdf`;

  // --- Document Header ---
  const pageWidth = doc.internal.pageSize.getWidth();

  // Top header banner
  doc.setFillColor(30, 41, 59); // Slate-800 (#1E293B)
  doc.rect(0, 0, pageWidth, 26, 'F');

  // Title
  doc.setTextColor(255, 255, 255);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(16);
  doc.text('POONAM CREATION', 14, 12);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.setTextColor(203, 213, 225); // Slate-300
  doc.text('INVENTORY STOCK STATEMENT', 14, 19);

  // Date/Time in top-right
  doc.setFontSize(8.5);
  doc.setTextColor(226, 232, 240);
  doc.text(`Date: ${dateFormatted} | ${timeFormatted}`, pageWidth - 14, 12, { align: 'right' });
  doc.text(`Staff: ${generatedBy}`, pageWidth - 14, 19, { align: 'right' });

  // Sub-header Info Section
  doc.setTextColor(30, 41, 59);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(12);
  doc.text(categoryTitle.toUpperCase(), 14, 34);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.setTextColor(100, 116, 139);
  doc.text(`Total Designs / Items Listed: ${items.length}`, 14, 40);

  // Table Data
  const tableRows = items.map((item, index) => {
    const isLowStock = item.quantity <= item.low_stock_threshold;
    const formattedQty = item.unit === 'KGS' 
      ? Number(item.quantity).toFixed(3)
      : Number(item.quantity).toLocaleString('en-IN');

    return [
      (index + 1).toString(),
      item.item_id,
      formattedQty,
      item.unit,
      isLowStock ? 'Low Stock' : 'In Stock',
    ];
  });

  // Render Table
  autoTable(doc, {
    startY: 44,
    head: [['#', 'Item / Design Code', 'Current Stock', 'Unit', 'Status']],
    body: tableRows,
    theme: 'striped',
    headStyles: {
      fillColor: [51, 65, 85], // Slate-700
      textColor: [255, 255, 255],
      fontStyle: 'bold',
      fontSize: 9,
      halign: 'left',
    },
    bodyStyles: {
      fontSize: 8.5,
      textColor: [30, 41, 59],
      cellPadding: 2.5,
    },
    alternateRowStyles: {
      fillColor: [248, 250, 252], // Slate-50
    },
    columnStyles: {
      0: { cellWidth: 12, halign: 'center' },
      1: { cellWidth: 'auto', fontStyle: 'bold' },
      2: { cellWidth: 32, halign: 'right' },
      3: { cellWidth: 20, halign: 'center' },
      4: { cellWidth: 28, halign: 'center' },
    },
    didParseCell: (data) => {
      // Highlight Low Stock in Red
      if (data.column.index === 4 && data.cell.raw === 'Low Stock') {
        data.cell.styles.textColor = [185, 28, 28]; // Red-700
        data.cell.styles.fontStyle = 'bold';
      }
    },
    margin: { left: 14, right: 14, bottom: 25 },
  });

  // Calculate final Y after table
  const finalY = (doc as any).lastAutoTable?.finalY || 100;
  let summaryY = finalY + 8;

  // If near bottom of page, add page for summary
  if (summaryY > doc.internal.pageSize.getHeight() - 35) {
    doc.addPage();
    summaryY = 20;
  }

  // --- Total Units Summary Box ---
  doc.setFillColor(241, 245, 249); // Slate-100
  doc.setDrawColor(203, 213, 225); // Slate-300
  doc.roundedRect(14, summaryY, pageWidth - 28, 16, 2, 2, 'FD');

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9);
  doc.setTextColor(30, 41, 59);
  doc.text('STOCK TOTALS SUMMARY:', 18, summaryY + 6);

  const unitStrings = Object.entries(unitTotals).map(([u, total]) => {
    const formatted = u === 'KGS' ? total.toFixed(3) : total.toLocaleString('en-IN');
    return `${formatted} ${u}`;
  });

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.setTextColor(15, 23, 42);
  doc.text(
    `Total Designs: ${items.length}   |   ${unitStrings.join('   |   ')}`,
    18,
    summaryY + 12
  );

  // --- Page Numbering Footers ---
  const totalPages = doc.getNumberOfPages();
  for (let i = 1; i <= totalPages; i++) {
    doc.setPage(i);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.5);
    doc.setTextColor(148, 163, 184); // Slate-400
    doc.text(
      'Poonam Creation Inventory System — Confidential Stock Record (No Commercial Values)',
      14,
      doc.internal.pageSize.getHeight() - 8
    );
    doc.text(
      `Page ${i} of ${totalPages}`,
      pageWidth - 14,
      doc.internal.pageSize.getHeight() - 8,
      { align: 'right' }
    );
  }

  const blob = doc.output('blob');
  const url = URL.createObjectURL(blob);
  const file = new File([blob], filename, { type: 'application/pdf' });

  return {
    doc,
    blob,
    url,
    file,
    filename,
    totalItems: items.length,
    unitTotals,
  };
}
