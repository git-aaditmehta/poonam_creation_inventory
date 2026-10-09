import React, { useState } from 'react';
import { X, Download, Share2, ExternalLink, FileText } from 'lucide-react';
import type { GeneratedPdfResult } from '../utils/pdfGenerator';

interface StockPdfModalProps {
  pdfResult: GeneratedPdfResult | null;
  categoryTitle: string;
  onClose: () => void;
  showToast?: (type: 'success' | 'error' | 'info', title: string, message?: string) => void;
}

export const StockPdfModal: React.FC<StockPdfModalProps> = ({
  pdfResult,
  categoryTitle,
  onClose,
  showToast,
}) => {
  const [isSharing, setIsSharing] = useState(false);

  if (!pdfResult) return null;

  const handleDownload = () => {
    const a = document.createElement('a');
    a.href = pdfResult.url;
    a.download = pdfResult.filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    showToast?.('success', 'PDF Downloaded', pdfResult.filename);
  };

  const handleShare = async () => {
    setIsSharing(true);
    try {
      // 1. Try standard Web Share API with File (Supported on iOS Safari, Android Chrome, Mac Safari)
      if (
        navigator.share &&
        navigator.canShare &&
        navigator.canShare({ files: [pdfResult.file] })
      ) {
        await navigator.share({
          files: [pdfResult.file],
          title: `Poonam Creation — ${categoryTitle} Stock`,
          text: `Current stock statement for ${categoryTitle} (${pdfResult.totalItems} items).`,
        });
        showToast?.('success', 'Shared Successfully');
        return;
      }

      // 2. If navigator.share without file support exists, try sharing text
      if (navigator.share) {
        // Download file first so they have it
        handleDownload();
        await navigator.share({
          title: `Poonam Creation — ${categoryTitle} Stock`,
          text: `Current stock statement for ${categoryTitle} (${pdfResult.totalItems} items).`,
        });
        return;
      }

      // 3. Fallback: Download file and open WhatsApp Web/App
      handleDownload();
      const whatsappText = encodeURIComponent(
        `*Poonam Creation Stock Statement*\nCategory: ${categoryTitle}\nTotal Items: ${pdfResult.totalItems}\nGenerated on: ${new Date().toLocaleDateString('en-IN')}`
      );
      window.open(`https://api.whatsapp.com/send?text=${whatsappText}`, '_blank');
      showToast?.(
        'info',
        'PDF Downloaded',
        'Opening WhatsApp. You can attach the downloaded PDF in your chat!'
      );
    } catch (err: any) {
      if (err.name !== 'AbortError') {
        showToast?.('error', 'Share Cancelled or Failed', err.message);
      }
    } finally {
      setIsSharing(false);
    }
  };

  const handlePrint = () => {
    const printWindow = window.open(pdfResult.url, '_blank');
    if (printWindow) {
      printWindow.focus();
    }
  };

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9999,
        backgroundColor: 'rgba(15, 23, 42, 0.75)',
        backdropFilter: 'blur(4px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '16px',
      }}
      onClick={onClose}
    >
      <div
        style={{
          backgroundColor: '#FFFFFF',
          borderRadius: '16px',
          width: '100%',
          maxWidth: '920px',
          maxHeight: '94vh',
          display: 'flex',
          flexDirection: 'column',
          boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.25)',
          overflow: 'hidden',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Modal Header */}
        <div
          style={{
            padding: '16px 20px',
            borderBottom: '1px solid #E2E8F0',
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
            backgroundColor: '#F8FAFC',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div
              style={{
                width: 40,
                height: 40,
                borderRadius: 10,
                backgroundColor: '#0F172A',
                color: '#FFFFFF',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <FileText size={20} />
            </div>
            <div>
              <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: '#0F172A' }}>
                {categoryTitle} — Stock Statement
              </h3>
              <p style={{ margin: 0, fontSize: 12, color: '#64748B', marginTop: 2 }}>
                {pdfResult.totalItems} items listed • No price values included
              </p>
            </div>
          </div>

          {/* Action Buttons */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            {/* Share Button (Primary / WhatsApp style) */}
            <button
              onClick={handleShare}
              disabled={isSharing}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                padding: '8px 14px',
                borderRadius: 8,
                backgroundColor: '#25D366', // WhatsApp Green
                color: '#FFFFFF',
                border: 'none',
                fontWeight: 600,
                fontSize: 13,
                cursor: 'pointer',
                transition: 'all 0.15s ease',
              }}
              title="Share via WhatsApp or Device Share Sheet"
            >
              <Share2 size={15} />
              <span>Share PDF</span>
            </button>

            {/* Download Button */}
            <button
              onClick={handleDownload}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                padding: '8px 14px',
                borderRadius: 8,
                backgroundColor: '#0F172A',
                color: '#FFFFFF',
                border: 'none',
                fontWeight: 600,
                fontSize: 13,
                cursor: 'pointer',
              }}
              title="Download PDF directly"
            >
              <Download size={15} />
              <span>Download</span>
            </button>

            {/* Print Button */}
            <button
              onClick={handlePrint}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                padding: '8px 12px',
                borderRadius: 8,
                backgroundColor: '#FFFFFF',
                color: '#334155',
                border: '1px solid #CBD5E1',
                fontWeight: 500,
                fontSize: 13,
                cursor: 'pointer',
              }}
              title="Open print view"
            >
              <ExternalLink size={15} />
            </button>

            {/* Close Button */}
            <button
              onClick={onClose}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: 34,
                height: 34,
                borderRadius: 8,
                backgroundColor: '#F1F5F9',
                color: '#64748B',
                border: 'none',
                cursor: 'pointer',
              }}
              title="Close preview"
            >
              <X size={18} />
            </button>
          </div>
        </div>

        {/* PDF Viewer Body */}
        <div
          style={{
            flex: 1,
            backgroundColor: '#334155',
            padding: '12px',
            overflow: 'hidden',
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          <iframe
            src={`${pdfResult.url}#toolbar=0`}
            style={{
              width: '100%',
              height: '66vh',
              border: 'none',
              borderRadius: 8,
              backgroundColor: '#FFFFFF',
            }}
            title="PDF Preview"
          />
        </div>

        {/* Modal Footer Info */}
        <div
          style={{
            padding: '10px 20px',
            backgroundColor: '#F8FAFC',
            borderTop: '1px solid #E2E8F0',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            fontSize: 12,
            color: '#64748B',
          }}
        >
          <span>File: <strong>{pdfResult.filename}</strong></span>
          <span>Tip: Tap <strong>Share PDF</strong> to send directly to WhatsApp.</span>
        </div>
      </div>
    </div>
  );
};
