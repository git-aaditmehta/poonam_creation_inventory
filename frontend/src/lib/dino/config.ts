/**
 * On-device visual search (DINOv2-small) — shared constants.
 * MUST match backend/src/routes/visual-search-dino.ts (DINO_MODEL_VERSION, dimensions).
 *
 * Changing ANY of these (model file, input size, padding, pooling) changes the fingerprints,
 * so bump DINO_MODEL_VERSION: every catalog photo then shows as "waiting to be learned" again.
 */
// v3: catalog photos cleaned (red ID text removed) + cropped to the jewelry at 900px; scans send only the gold box.
export const DINO_MODEL_VERSION = 'dinov2s-q8-224-cls-crop900-v3';
export const DINO_DIMENSIONS = 384;
export const DINO_INPUT_SIZE = 224; // multiple of the 14px patch size
/**
 * Compact int8 model (24 MB). The fp32 model (88 MB) crashed iPhone Safari (memory); offline tests on the
 * catalog photos showed the same accuracy (phone-like 99% vs 100% #1, one-piece 94% vs 94% #1).
 */
export const DINO_MODEL_FILE = 'model_quantized.onnx';
export const DINO_MODEL_BYTES = 24_446_700;
export const DINO_MODEL_SHA256 = 'c179f8f7f592449c4c1bca4cd124a7538021428c5ffb89afde9503935b197efb';
export const DINO_CACHE_NAME = 'dino-model-q8-v2';
/** int8 ops run on the CPU kernels; using the CPU everywhere also makes every device compute identical fingerprints. */
export const DINO_FORCE_WASM = true;

// ImageNet normalisation used by DINOv2
export const DINO_MEAN = [0.485, 0.456, 0.406];
export const DINO_STD = [0.229, 0.224, 0.225];

/** Background used to pad photos to a square (never crop: pieces near the edge must stay in). */
export const DINO_PAD_COLOR = '#FFFFFF';

/**
 * Catalog photo clean-up + crop (catalogCrop.ts) always runs on a copy of this size (long side), whether the photo
 * comes from an upload (original) or from re-learning (stored 900px photo), so both give the same fingerprint.
 * Validated on the 79 sample photos: same crops as full size (overlap 1.00), 91-92% correct first.
 */
export const DINO_CATALOG_WORK_SIDE = 900;
/**
 * The gold box on the scan screen covers the middle of the square viewfinder, leaving this fraction on each side.
 * MUST match `.sj-reticle { inset: 12% }` in ScanDinoView. Only the inside of the box is sent (agreed #3).
 */
export const DINO_SCAN_BOX_INSET = 0.12;
