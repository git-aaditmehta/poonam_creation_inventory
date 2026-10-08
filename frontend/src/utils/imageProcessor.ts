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
          const fullDataUrl = fullCanvas.toDataURL('image/webp', 0.85);

          // Process Thumb (Max 200px square crop or aspect fit)
          const { canvas: thumbCanvas } = resizeToCanvas(img, 240, 240);
          const thumbDataUrl = thumbCanvas.toDataURL('image/webp', 0.80);

          fullCanvas.toBlob(
            (fullBlob) => {
              if (!fullBlob) return reject(new Error('Failed to generate full image blob'));
              thumbCanvas.toBlob(
                (thumbBlob) => {
                  if (!thumbBlob) return reject(new Error('Failed to generate thumb blob'));
                  resolve({
                    fullBlob,
                    thumbBlob,
                    fullDataUrl,
                    thumbDataUrl,
                  });
                },
                'image/webp',
                0.80
              );
            },
            'image/webp',
            0.85
          );
        } catch (err) {
          reject(err);
        }
      };
      img.src = e.target?.result as string;
    };
    reader.readAsDataURL(file);
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
