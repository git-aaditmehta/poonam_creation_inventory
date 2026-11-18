import React, { useState } from 'react';
import { FileText, Loader2 } from 'lucide-react';
import { api } from '../api';
import { localDb } from '../lib/localDb';
import type { ExportStockItem, GeneratedPdfResult } from '../utils/pdfGenerator';
import { StockPdfModal } from './StockPdfModal';

interface GeneratePdfButtonProps {
  category: 'plated-jewelry' | 'raw-jewelry' | 'stones' | 'foil';
  categoryTitle: string;
  username: string;
  showToast?: (type: 'success' | 'error' | 'info', title: string, message?: string) => void;
  className?: string;
  style?: React.CSSProperties;
}

export const GeneratePdfButton: React.FC<GeneratePdfButtonProps> = ({
  category,
  categoryTitle,
  username,
  showToast,
  className = 'btn btn-secondary',
  style,
}) => {
  const [isGenerating, setIsGenerating] = useState(false);
  const [pdfResult, setPdfResult] = useState<GeneratedPdfResult | null>(null);

  const handleGenerate = async () => {
    setIsGenerating(true);
    try {
      // The phone's own copy first: instant and works offline. The cloud only if this phone has no copy yet.
      const table = category.replace('-', '_') as 'plated_jewelry' | 'raw_jewelry' | 'stones' | 'foil';
      let items: ExportStockItem[] = [];
      try {
        items = await localDb.getAllItems<ExportStockItem>(table);
      } catch {
        items = [];
      }
      if (items.length === 0 && navigator.onLine) {
        const res = await api.inventory.getExportAll(category);
        items = res.items || [];
      }
      // The PDF library is only downloaded when a PDF is actually made (keeps the app's startup small)
      const { generateStockPdf } = await import('../utils/pdfGenerator');
      const res = { items };
      if (!res.items || res.items.length === 0) {
        showToast?.('info', 'No Stock Found', `There are no active items in ${categoryTitle} to generate a statement.`);
        return;
      }

      const result = generateStockPdf({
        category,
        categoryTitle,
        items: res.items,
        generatedBy: username,
      });

      setPdfResult(result);
    } catch (err: any) {
      showToast?.('error', 'PDF Generation Failed', err.message);
    } finally {
      setIsGenerating(false);
    }
  };

  const handleCloseModal = () => {
    if (pdfResult?.url) {
      URL.revokeObjectURL(pdfResult.url);
    }
    setPdfResult(null);
  };

  return (
    <>
      <button
        type="button"
        onClick={handleGenerate}
        disabled={isGenerating}
        className={className}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          ...style,
        }}
        title={`Generate PDF stock statement for ${categoryTitle}`}
      >
        {isGenerating ? (
          <Loader2 size={15} className="animate-spin" />
        ) : (
          <FileText size={15} />
        )}
        <span>{isGenerating ? 'Generating...' : 'Generate PDF'}</span>
      </button>

      {pdfResult && (
        <StockPdfModal
          pdfResult={pdfResult}
          categoryTitle={categoryTitle}
          onClose={handleCloseModal}
          showToast={showToast}
        />
      )}
    </>
  );
};
