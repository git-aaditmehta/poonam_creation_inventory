import { describe, it, expect } from 'vitest';
import {
  calculateJewelryCost,
  normalizeQuantity,
  normalizeWeight,
  normalizeX,
  roundTo2,
  calculateTableSummary,
} from '../costingEngine';

describe('costingEngine - Calculations & Validation', () => {
  it('calculates the exact example from the feature prompt', () => {
    // Jewelry weight = 3.50, X = 18.00
    // AD Stone A: cost = 2.50, qty = 2 -> 5.00
    // Kundan Stone B: cost = 4.00, qty = 3 -> 12.00
    // MOP A: cost = 6.00, qty = 1 -> 6.00
    // Total = 63.00 + 5.00 + 12.00 + 6.00 = 86.00
    const res = calculateJewelryCost(3.50, 18.00, [
      { categoryId: 'ad_stone', materialId: 'ad1', materialName: 'AD Stone A', quantity: 2, unitCost: 2.50 },
      { categoryId: 'kundan_stone', materialId: 'kd1', materialName: 'Kundan Stone B', quantity: 3, unitCost: 4.00 },
      { categoryId: 'mop', materialId: 'mop1', materialName: 'MOP A', quantity: 1, unitCost: 6.00 },
    ]);

    expect(res.weightCost).toBe(63.00);
    expect(res.materialsCost).toBe(23.00);
    expect(res.totalCost).toBe(86.00);
    expect(res.isComplete).toBe(true);
    expect(res.missingPriceMaterials).toHaveLength(0);
    expect(res.validationErrors).toHaveLength(0);
  });

  describe('Material Quantity Rules', () => {
    it('defaults empty, null, or undefined quantity to 1', () => {
      expect(normalizeQuantity('').quantity).toBe(1);
      expect(normalizeQuantity('  ').quantity).toBe(1);
      expect(normalizeQuantity(null).quantity).toBe(1);
      expect(normalizeQuantity(undefined).quantity).toBe(1);

      const res = calculateJewelryCost(2.0, 10.0, [
        { categoryId: 'ad_stone', materialId: 'ad1', materialName: 'AD Stone', quantity: '', unitCost: 5.0 },
      ]);
      expect(res.materials[0].quantity).toBe(1);
      expect(res.materials[0].extendedCost).toBe(5.0);
      expect(res.totalCost).toBe(25.0);
    });

    it('rejects zero, negative, and fractional quantities', () => {
      expect(normalizeQuantity(0).valid).toBe(false);
      expect(normalizeQuantity(-2).valid).toBe(false);
      expect(normalizeQuantity(1.5).valid).toBe(false);
      expect(normalizeQuantity('abc').valid).toBe(false);

      const res = calculateJewelryCost(2.0, 10.0, [
        { categoryId: 'ad_stone', materialId: 'ad1', materialName: 'AD Stone', quantity: 0, unitCost: 5.0 },
      ]);
      expect(res.validationErrors.length).toBeGreaterThan(0);
      expect(res.isComplete).toBe(false);
    });

    it('accepts valid whole number quantities', () => {
      expect(normalizeQuantity(5).valid).toBe(true);
      expect(normalizeQuantity(5).quantity).toBe(5);
      expect(normalizeQuantity('12').valid).toBe(true);
      expect(normalizeQuantity('12').quantity).toBe(12);
    });
  });

  describe('Missing Material Prices', () => {
    it('flags missing price and blocks complete status', () => {
      const res = calculateJewelryCost(2.0, 10.0, [
        { categoryId: 'ad_stone', materialId: 'ad1', materialName: 'AD Stone 1', quantity: 2, unitCost: null },
        { categoryId: 'mop', materialId: 'mop1', materialName: 'MOP 1', quantity: 1, unitCost: 15.0 },
      ]);

      expect(res.isComplete).toBe(false);
      expect(res.missingPriceMaterials).toContain('AD Stone 1');
      expect(res.materials[0].hasMissingPrice).toBe(true);
      expect(res.materials[0].extendedCost).toBeNull();
      // MOP 1 is valid
      expect(res.materials[1].hasMissingPrice).toBe(false);
      expect(res.materials[1].extendedCost).toBe(15.0);
    });

    it('recalculates immediately when missing price is provided', () => {
      const initial = calculateJewelryCost(2.0, 10.0, [
        { categoryId: 'ad_stone', materialId: 'ad1', materialName: 'AD Stone 1', quantity: 2, unitCost: null },
      ]);
      expect(initial.isComplete).toBe(false);

      const updated = calculateJewelryCost(2.0, 10.0, [
        { categoryId: 'ad_stone', materialId: 'ad1', materialName: 'AD Stone 1', quantity: 2, unitCost: 8.50 },
      ]);
      expect(updated.isComplete).toBe(true);
      expect(updated.totalCost).toBe(37.0); // 2*10 + 2*8.5 = 20 + 17 = 37
    });
  });

  describe('Dynamic Multiplier X and Weight Changes', () => {
    it('recalculates weight cost immediately when X changes', () => {
      const materials = [
        { categoryId: 'ad_stone', materialId: 'ad1', materialName: 'AD Stone', quantity: 2, unitCost: 5.0 },
      ];

      const withX18 = calculateJewelryCost(3.50, 18.00, materials);
      expect(withX18.weightCost).toBe(63.00);
      expect(withX18.totalCost).toBe(73.00);

      const withX19 = calculateJewelryCost(3.50, 19.00, materials);
      expect(withX19.weightCost).toBe(66.50);
      expect(withX19.totalCost).toBe(76.50);
    });

    it('handles negative or invalid X and weight safely', () => {
      expect(normalizeX(-5).valid).toBe(false);
      expect(normalizeWeight(-1).valid).toBe(false);
      expect(normalizeWeight(0).valid).toBe(false);

      const invalid = calculateJewelryCost(-3.5, -18, []);
      expect(invalid.isComplete).toBe(false);
      expect(invalid.validationErrors.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('Multiple Materials within and across Categories', () => {
    it('supports multiple materials within the same category', () => {
      const res = calculateJewelryCost(1.0, 10.0, [
        { categoryId: 'ad_stone', materialId: 'ad1', materialName: 'AD 1', quantity: 2, unitCost: 3.0 },
        { categoryId: 'ad_stone', materialId: 'ad2', materialName: 'AD 2', quantity: 1, unitCost: 4.0 },
        { categoryId: 'ad_stone', materialId: 'ad3', materialName: 'AD 3', quantity: 5, unitCost: 2.0 },
      ]);

      // weight cost = 10.0
      // materials: 2*3 + 1*4 + 5*2 = 6 + 4 + 10 = 20
      expect(res.weightCost).toBe(10.0);
      expect(res.materialsCost).toBe(20.0);
      expect(res.totalCost).toBe(30.0);
    });
  });

  describe('Table Summary & Aggregates', () => {
    it('accurately sums weight cost, category columns, and grand total', () => {
      const items = [
        {
          weightCost: 63.00,
          materials: [
            { categoryId: 'ad_stone', extendedCost: 5.00 },
            { categoryId: 'kundan_stone', extendedCost: 12.00 },
          ],
          totalCost: 80.00,
          isComplete: true,
        },
        {
          weightCost: 37.50,
          materials: [
            { categoryId: 'ad_stone', extendedCost: 10.00 },
            { categoryId: 'mop', extendedCost: 6.00 },
          ],
          totalCost: 53.50,
          isComplete: true,
        },
      ];

      const summary = calculateTableSummary(items, ['ad_stone', 'kundan_stone', 'mop', 'hepoxy']);

      expect(summary.totalJewelryCount).toBe(2);
      expect(summary.totalWeightCost).toBe(100.50);
      expect(summary.categoryTotals['ad_stone']).toBe(15.00);
      expect(summary.categoryTotals['kundan_stone']).toBe(12.00);
      expect(summary.categoryTotals['mop']).toBe(6.00);
      expect(summary.categoryTotals['hepoxy']).toBe(0.00);
      expect(summary.grandTotalCost).toBe(133.50);
      expect(summary.incompleteCount).toBe(0);
    });

    it('resolves category aliases (kundan_stones -> kundan_stone) and guarantees mathematical grand total consistency', () => {
      const items = [
        {
          weightCost: 150.00,
          materials: [
            // Aliased category names as might come from Excel
            { categoryId: 'kundan_stones', extendedCost: 25.50 },
            { categoryId: 'ad_stones', extendedCost: 14.50 },
            { categoryId: 'hepoxy', extendedCost: 30.00 },
          ],
          totalCost: 220.00,
          isComplete: true,
        },
      ];

      const categoryIds = ['ad_stone', 'kundan_stone', 'mop', 'hepoxy'];
      const summary = calculateTableSummary(items, categoryIds);

      // Verify category columns captured the aliased materials
      expect(summary.categoryTotals['kundan_stone']).toBe(25.50);
      expect(summary.categoryTotals['ad_stone']).toBe(14.50);
      expect(summary.categoryTotals['hepoxy']).toBe(30.00);
      expect(summary.totalWeightCost).toBe(150.00);

      // Verify sum of columns matches grand total EXACTLY: 150 + 25.50 + 14.50 + 30 = 220.00
      const columnSum = summary.totalWeightCost + 
        summary.categoryTotals['ad_stone'] + 
        summary.categoryTotals['kundan_stone'] + 
        summary.categoryTotals['mop'] + 
        summary.categoryTotals['hepoxy'];
      expect(summary.grandTotalCost).toBe(columnSum);
      expect(summary.grandTotalCost).toBe(220.00);
    });
  });
});
