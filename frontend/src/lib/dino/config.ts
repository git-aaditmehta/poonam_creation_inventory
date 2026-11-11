/**
 * On-device visual search (DINOv2-small) — shared constants.
 * MUST match backend/src/routes/visual-search-dino.ts (DINO_MODEL_VERSION, dimensions).
 *
 * Changing ANY of these (model file, input size, padding, pooling) changes the fingerprints,
 * so bump DINO_MODEL_VERSION: every catalog photo then shows as "waiting to be learned" again.
 */
export const DINO_MODEL_VERSION = 'dinov2s-224-cls-v1';
export const DINO_DIMENSIONS = 384;
export const DINO_INPUT_SIZE = 224; // multiple of the 14px patch size
export const DINO_MODEL_FILE = 'model.onnx'; // fp32, 88.5 MB, served from our R2 via the backend
export const DINO_MODEL_BYTES = 88_532_934;
export const DINO_MODEL_SHA256 = 'f22797eabf810a75e41de68d378541ebea372122b25c4ce3ef25ff618250c20a';
export const DINO_CACHE_NAME = 'dino-model-v1';

// ImageNet normalisation used by DINOv2
export const DINO_MEAN = [0.485, 0.456, 0.406];
export const DINO_STD = [0.229, 0.224, 0.225];

/** Background used to pad photos to a square (never crop: pieces near the edge must stay in). */
export const DINO_PAD_COLOR = '#FFFFFF';
