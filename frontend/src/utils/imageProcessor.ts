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
          // Process Full (Max 1200px)
          const { canvas: fullCanvas } = resizeToCanvas(img, 1200, 1200);
          let fullDataUrl = '';
          try {
            fullDataUrl = fullCanvas.toDataURL('image/webp', 0.85);
          } catch {
            fullDataUrl = fullCanvas.toDataURL('image/jpeg', 0.85);
          }

          // Process Thumb (Max 240px aspect fit)
          const { canvas: thumbCanvas } = resizeToCanvas(img, 240, 240);
          let thumbDataUrl = '';
          try {
            thumbDataUrl = thumbCanvas.toDataURL('image/webp', 0.80);
          } catch {
            thumbDataUrl = thumbCanvas.toDataURL('image/jpeg', 0.80);
          }

          canvasToBlobSafe(fullCanvas, 0.85)
            .then((fullBlob) => {
              canvasToBlobSafe(thumbCanvas, 0.80)
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

function canvasToBlobSafe(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) return resolve(blob);
      // Fallback to JPEG if WebP is unsupported or fails
      canvas.toBlob((jpegBlob) => {
        if (jpegBlob) return resolve(jpegBlob);
        reject(new Error('Failed to generate image blob from canvas'));
      }, 'image/jpeg', quality);
    }, 'image/webp', quality);
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
