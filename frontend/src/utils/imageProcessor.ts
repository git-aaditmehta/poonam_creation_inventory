/**
 * Client-side high performance image resizing using Canvas API.
 * Produces crisp WebP/JPEG thumbnails and compressed full images
 * without requiring heavy WASM/Sharp bundles in Cloudflare Workers.
 */

export interface ProcessedImages {
  fullBlob: Blob;
  thumbBlob: Blob;
  fullDataUrl: string;
  thumbDataUrl: string;
}

export async function processJewelryImage(file: File): Promise<ProcessedImages> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Failed to read image file'));
    reader.onload = (e) => {
      const img = new Image();
      img.onerror = () => reject(new Error('Failed to load image into DOM'));
      img.onload = () => {
        try {
          // Detect if WebP export is supported by browser; if not, use JPEG
          const format = isWebPExportSupported() ? 'image/webp' : 'image/jpeg';

          // Process Full (Max 900px — crisp 2x retina on all mobile & laptops, ~50-70KB)
          const { canvas: fullCanvas } = resizeToCanvas(img, 900, 900);
          const fullDataUrl = fullCanvas.toDataURL(format, 0.75);

          // Process Thumb (Max 200px aspect fit, ~10KB)
          const { canvas: thumbCanvas } = resizeToCanvas(img, 200, 200);
          const thumbDataUrl = thumbCanvas.toDataURL(format, 0.70);

          canvasToBlobSafe(fullCanvas, 0.75, format)
            .then((fullBlob) => {
              canvasToBlobSafe(thumbCanvas, 0.70, format)
                .then((thumbBlob) => {
                  resolve({
                    fullBlob,
                    thumbBlob,
                    fullDataUrl,
                    thumbDataUrl,
                  });
                })
                .catch(reject);
            })
            .catch(reject);
        } catch (err) {
          reject(err);
        }
      };
      img.src = e.target?.result as string;
    };
    reader.readAsDataURL(file);
  });
}

/** Check if the current browser's canvas natively encodes WebP */
function isWebPExportSupported(): boolean {
  try {
    const testCanvas = document.createElement('canvas');
    testCanvas.width = 1;
    testCanvas.height = 1;
    return testCanvas.toDataURL('image/webp').startsWith('data:image/webp');
  } catch {
    return false;
  }
}

function canvasToBlobSafe(canvas: HTMLCanvasElement, quality: number, preferredFormat: string): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      // If browser respected the format and didn't fall back to uncompressed PNG
      if (blob && (blob.type === 'image/webp' || blob.type === 'image/jpeg')) {
        return resolve(blob);
      }
      // If browser silently fell back to uncompressed image/png, re-encode as image/jpeg
      canvas.toBlob((jpegBlob) => {
        if (jpegBlob) return resolve(jpegBlob);
        reject(new Error('Failed to generate compressed image blob from canvas'));
      }, 'image/jpeg', quality);
    }, preferredFormat, quality);
  });
}

function resizeToCanvas(img: HTMLImageElement, maxWidth: number, maxHeight: number): { canvas: HTMLCanvasElement; width: number; height: number } {
  let { width, height } = img;

  if (width > maxWidth || height > maxHeight) {
    const ratio = Math.min(maxWidth / width, maxHeight / height);
    width = Math.round(width * ratio);
    height = Math.round(height * ratio);
  }

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;

  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not get canvas 2D context');

  // High quality interpolation
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, width, height);

  return { canvas, width, height };
}
