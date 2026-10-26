/**
 * costingEngine.ts
 * 
 * Core calculation and validation engine for the Private Local-Only Costing System.
 * All calculations use integer-paisa or strict 2-decimal arithmetic to prevent
 * floating-point drift.
 * 
 * Formula:
 *   Jewelry Cost = (Jewelry Weight × X) + Sum(Material Quantity × Material Unit Cost)
 */

export interface CostingMaterialEntry {
  id?: string;
  categoryId: string;
  materialId: string;
  materialName: string;
  /** Quantity used in this jewelry design. Defaults to 1 if blank/omitted. */
  quantity?: number | string | null;
  /** Cost price in Rupees (e.g. 2.50). Can be null/undefined if price is not set. */
  unitCost?: number | null;
  /** For Hepoxy: weight is its identifying value */
  weight?: number | null;
}

export interface CalculatedMaterialEntry {
  categoryId: string;
  materialId: string;
  materialName: string;
  quantity: number;
  unitCost: number | null;
  extendedCost: number | null;
  hasMissingPrice: boolean;
  weight?: number | null;
}

export interface CalculatedJewelryCost {
  jewelryWeight: number;
  multiplierX: number;
  weightCost: number;
  materials: CalculatedMaterialEntry[];
  materialsCost: number;
  totalCost: number;
  isComplete: boolean;
  missingPriceMaterials: string[];
  validationErrors: string[];
}

export interface CostingTableSummary {
  totalJewelryCount: number;
  totalWeightCost: number;
  categoryTotals: Record<string, number>;
  grandTotalCost: number;
  incompleteCount: number;
}

/** Round a rupee value to exactly 2 decimal places without float drift */
export function roundTo2(val: number): number {
  if (!Number.isFinite(val)) return 0;
  return Math.round((val + Number.EPSILON) * 100) / 100;
}

/** Format currency in INR (₹) */
export function formatRupees(amount: number | null | undefined): string {
  if (amount === null || amount === undefined || isNaN(amount)) return '₹0.00';
  return `₹${amount.toFixed(2)}`;
}

/** Parse and normalize material quantity: blank/empty/undefined -> 1, otherwise strictly positive integer */
export function normalizeQuantity(qty: number | string | null | undefined): {
  valid: boolean;
  quantity: number;
  error?: string;
} {
  if (qty === null || qty === undefined || qty === '' || (typeof qty === 'string' && qty.trim() === '')) {
    return { valid: true, quantity: 1 };
  }

  const num = typeof qty === 'number' ? qty : Number(qty);
  if (isNaN(num)) {
    return { valid: false, quantity: 1, error: 'Quantity must be a number' };
  }

  if (!Number.isInteger(num)) {
    return { valid: false, quantity: 1, error: 'Quantity must be a whole number' };
  }

  if (num <= 0) {
    return { valid: false, quantity: 1, error: 'Quantity must be greater than zero' };
  }

  return { valid: true, quantity: num };
}

/** Validate jewelry weight (must be > 0 and finite) */
export function normalizeWeight(weight: number | string | null | undefined): {
  valid: boolean;
  weight: number;
  error?: string;
} {
  if (weight === null || weight === undefined || weight === '' || (typeof weight === 'string' && weight.trim() === '')) {
    return { valid: false, weight: 0, error: 'Jewelry weight is required' };
  }

  const num = typeof weight === 'number' ? weight : Number(weight);
  if (isNaN(num) || !Number.isFinite(num)) {
    return { valid: false, weight: 0, error: 'Jewelry weight must be a valid number' };
  }

  if (num <= 0) {
    return { valid: false, weight: 0, error: 'Jewelry weight must be greater than 0' };
  }

  return { valid: true, weight: roundTo2(num) };
}

/** Validate X multiplier (must be >= 0 and finite) */
export function normalizeX(x: number | string | null | undefined): {
  valid: boolean;
  x: number;
  error?: string;
} {
  if (x === null || x === undefined || x === '' || (typeof x === 'string' && x.trim() === '')) {
    return { valid: false, x: 0, error: 'Multiplier X is required' };
  }

  const num = typeof x === 'number' ? x : Number(x);
  if (isNaN(num) || !Number.isFinite(num)) {
    return { valid: false, x: 0, error: 'Multiplier X must be a valid number' };
  }

  if (num < 0) {
    return { valid: false, x: 0, error: 'Multiplier X cannot be negative' };
  }

  return { valid: true, x: roundTo2(num) };
}

/**
 * Calculate jewelry design cost.
 * Evaluates (weight * X) + Sum(qty * unitCost).
 * Detects missing prices and marks isComplete = false if any material has missing price.
 */
export function calculateJewelryCost(
  rawWeight: number | string | null | undefined,
  rawX: number | string | null | undefined,
  rawMaterials: CostingMaterialEntry[]
): CalculatedJewelryCost {
  const validationErrors: string[] = [];
  const missingPriceMaterials: string[] = [];

  const weightResult = normalizeWeight(rawWeight);
  if (!weightResult.valid && weightResult.error) {
    validationErrors.push(weightResult.error);
  }

  const xResult = normalizeX(rawX);
  if (!xResult.valid && xResult.error) {
    validationErrors.push(xResult.error);
  }

  const jewelryWeight = weightResult.weight;
  const multiplierX = xResult.x;
  const weightCost = roundTo2(jewelryWeight * multiplierX);

  let materialsCostPaisa = 0;
  const calculatedMaterials: CalculatedMaterialEntry[] = [];
  let hasAnyMissingPrice = false;

  for (const m of rawMaterials) {
    const qtyResult = normalizeQuantity(m.quantity);
    if (!qtyResult.valid && qtyResult.error) {
      validationErrors.push(`${m.materialName || 'Material'}: ${qtyResult.error}`);
    }
    const qty = qtyResult.quantity;

    const unitCost = (m.unitCost !== null && m.unitCost !== undefined && !isNaN(m.unitCost) && m.unitCost >= 0)
      ? roundTo2(m.unitCost)
      : null;

    if (unitCost === null) {
      hasAnyMissingPrice = true;
      missingPriceMaterials.push(m.materialName || m.materialId || 'Unknown Material');
      calculatedMaterials.push({
        categoryId: m.categoryId,
        materialId: m.materialId,
        materialName: m.materialName,
        quantity: qty,
        unitCost: null,
        extendedCost: null,
        hasMissingPrice: true,
        weight: m.weight ?? null,
      });
    } else {
      const extCost = roundTo2(qty * unitCost);
      materialsCostPaisa += Math.round(extCost * 100);

      calculatedMaterials.push({
        categoryId: m.categoryId,
        materialId: m.materialId,
        materialName: m.materialName,
        quantity: qty,
        unitCost,
        extendedCost: extCost,
        hasMissingPrice: false,
        weight: m.weight ?? null,
      });
    }
  }

  const materialsCost = roundTo2(materialsCostPaisa / 100);
  const totalCost = roundTo2(weightCost + materialsCost);
  const isComplete = validationErrors.length === 0 && !hasAnyMissingPrice;

  return {
    jewelryWeight,
    multiplierX,
    weightCost,
    materials: calculatedMaterials,
    materialsCost,
    totalCost,
    isComplete,
    missingPriceMaterials,
    validationErrors,
  };
}

/** Helper to resolve category ID against available category IDs with normalization and aliases */
export function resolveCategoryId(rawCatId: string, availableCategoryIds: string[]): string | undefined {
  if (!rawCatId) return undefined;
  if (availableCategoryIds.includes(rawCatId)) return rawCatId;

  const normalized = rawCatId.toLowerCase().trim().replace(/[\s-]+/g, '_');
  const direct = availableCategoryIds.find(
    (id) => id.toLowerCase().trim().replace(/[\s-]+/g, '_') === normalized
  );
  if (direct) return direct;

  // Handle plural / singular variants: e.g. kundan_stones <-> kundan_stone, ad_stones <-> ad_stone
  const singular = normalized.endsWith('s') ? normalized.slice(0, -1) : normalized;
  const matchSingular = availableCategoryIds.find((id) => {
    const idNorm = id.toLowerCase().trim().replace(/[\s-]+/g, '_');
    const idSingular = idNorm.endsWith('s') ? idNorm.slice(0, -1) : idNorm;
    return idSingular === singular;
  });
  if (matchSingular) return matchSingular;

  // Known domain aliases
  if (normalized === 'stones' || normalized === 'kundan') {
    return availableCategoryIds.find((id) => id.includes('kundan'));
  }
  if (normalized === 'ad') {
    return availableCategoryIds.find((id) => id.includes('ad'));
  }

  return undefined;
}

/**
 * Compute bottom-of-table column aggregates from a list of calculated jewelry items.
 */
export function calculateTableSummary(
  items: Array<{
    weightCost: number;
    materials: Array<{ categoryId: string; extendedCost: number | null }>;
    totalCost: number;
    isComplete: boolean;
  }>,
  categoryIds: string[]
): CostingTableSummary {
  let totalWeightCostPaisa = 0;
  let incompleteCount = 0;

  const categoryTotalsPaisa: Record<string, number> = {};
  for (const catId of categoryIds) {
    categoryTotalsPaisa[catId] = 0;
  }

  for (const item of items) {
    if (!item.isComplete) {
      incompleteCount++;
    }

    totalWeightCostPaisa += Math.round((item.weightCost || 0) * 100);

    for (const mat of item.materials) {
      if (mat.extendedCost !== null && !isNaN(mat.extendedCost) && mat.extendedCost > 0) {
        const resolvedId = resolveCategoryId(mat.categoryId, categoryIds);
        if (resolvedId && categoryTotalsPaisa[resolvedId] !== undefined) {
          categoryTotalsPaisa[resolvedId] += Math.round(mat.extendedCost * 100);
        }
      }
    }
  }

  let totalCategoriesPaisa = 0;
  const categoryTotals: Record<string, number> = {};
  for (const catId of categoryIds) {
    const paisa = categoryTotalsPaisa[catId] || 0;
    categoryTotals[catId] = roundTo2(paisa / 100);
    totalCategoriesPaisa += paisa;
  }

  // Grand total cost is the exact mathematical sum of total weight cost and all category column totals
  const grandTotalCost = roundTo2((totalWeightCostPaisa + totalCategoriesPaisa) / 100);

  return {
    totalJewelryCount: items.length,
    totalWeightCost: roundTo2(totalWeightCostPaisa / 100),
    categoryTotals,
    grandTotalCost,
    incompleteCount,
  };
}
