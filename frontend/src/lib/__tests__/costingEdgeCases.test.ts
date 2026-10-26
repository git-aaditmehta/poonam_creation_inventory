import { describe, it, expect } from 'vitest';
import {
  calculateJewelryCost,
  normalizeQuantity,
  normalizeWeight,
  normalizeX,
  roundTo2,
  formatRupees,
} from '../costingEngine';

describe('Costing Edge Cases & Precision', () => {
  it('prevents floating-point accumulation drift across complex sums', () => {
    // 0.1 + 0.2 = 0.30000000000000004 in raw IEEE 754 float
    expect(roundTo2(0.1 + 0.2)).toBe(0.3);

    // Summing 10 items of 0.07 each
    const materials = Array(10).fill(null).map((_, i) => ({
      categoryId: 'ad_stone',
      materialId: `mat_${i}`,
      materialName: `Stone ${i}`,
      quantity: 1,
      unitCost: 0.07,
    }));

    // weight = 1.00, X = 10.00 -> weightCost = 10.00
    // materials: 10 * 0.07 = 0.70
    // total = 10.70
    const res = calculateJewelryCost(1.00, 10.00, materials);
    expect(res.weightCost).toBe(10.00);
    expect(res.materialsCost).toBe(0.70);
    expect(res.totalCost).toBe(10.70);
  });

  it('differentiates explicitly zero unit cost (₹0.00) from missing price (null)', () => {
    // Free promotional material: unitCost = 0.00
    const resFree = calculateJewelryCost(2.0, 10.0, [
      { categoryId: 'ad_stone', materialId: 'm1', materialName: 'Free Sample', quantity: 1, unitCost: 0.0 },
    ]);
    expect(resFree.isComplete).toBe(true);
    expect(resFree.materialsCost).toBe(0.0);
    expect(resFree.totalCost).toBe(20.0);
    expect(resFree.missingPriceMaterials).toHaveLength(0);

    // Missing price material: unitCost = null
    const resMissing = calculateJewelryCost(2.0, 10.0, [
      { categoryId: 'ad_stone', materialId: 'm2', materialName: 'Unpriced Stone', quantity: 1, unitCost: null },
    ]);
    expect(resMissing.isComplete).toBe(false);
    expect(resMissing.missingPriceMaterials).toContain('Unpriced Stone');
  });

  it('formats rupees consistently', () => {
    expect(formatRupees(86)).toBe('₹86.00');
    expect(formatRupees(1234.5)).toBe('₹1234.50');
    expect(formatRupees(0)).toBe('₹0.00');
    expect(formatRupees(null)).toBe('₹0.00');
    expect(formatRupees(undefined)).toBe('₹0.00');
    expect(formatRupees(NaN)).toBe('₹0.00');
  });

  it('handles empty and whitespace string inputs safely', () => {
    expect(normalizeQuantity('   ').quantity).toBe(1);
    expect(normalizeQuantity('\t\n').quantity).toBe(1);
    expect(normalizeWeight('   ').valid).toBe(false);
    expect(normalizeX('   ').valid).toBe(false);
  });
});
