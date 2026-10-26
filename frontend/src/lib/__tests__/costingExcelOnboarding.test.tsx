import React from 'react';
import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  COSTING_SECTION_FIELDS,
  autoMatchCostingColumns,
  CostingExcelRestoreModal,
} from '../../components/CostingExcelRestoreModal';
import { ToastProvider } from '../../context/ToastContext';

describe('Costing Excel Onboarding & Auto-Matching Engine', () => {
  it('defines valid field definitions for both jewelry costing and raw materials', () => {
    expect(COSTING_SECTION_FIELDS.jewelry_costing).toBeDefined();
    expect(COSTING_SECTION_FIELDS.raw_materials).toBeDefined();

    const costingKeys = COSTING_SECTION_FIELDS.jewelry_costing.map((f) => f.key);
    expect(costingKeys).toContain('item_id');
    expect(costingKeys).toContain('weight');

    const materialKeys = COSTING_SECTION_FIELDS.raw_materials.map((f) => f.key);
    expect(materialKeys).toContain('category_name');
    expect(materialKeys).toContain('material_name');
    expect(materialKeys).toContain('cost_price');
  });

  it('accurately auto-matches standard system backup columns for Jewelry Costing', () => {
    const backupCols = [
      'Jewelry ID / Design',
      'Jewelry Weight (gms)',
      'Multiplier X (₹)',
      'Weight Cost (₹)',
      'Total Manufacturing Cost (₹)',
    ];

    const matches = autoMatchCostingColumns('jewelry_costing', backupCols);
    expect(matches['item_id']).toBe('Jewelry ID / Design');
    expect(matches['weight']).toBe('Jewelry Weight (gms)');
  });

  it('accurately auto-matches detailed breakdown backup columns for Jewelry Costing', () => {
    const breakdownCols = [
      'Jewelry ID',
      'Plated Jewelry Reference',
      'Jewelry Weight (gms)',
      'Category ID',
      'Category Name',
      'Material ID',
      'Material Name',
      'Quantity',
      'Unit Cost (₹)',
      'Extended Cost (₹)',
      'Hepoxy Weight (gms)',
    ];

    const matches = autoMatchCostingColumns('jewelry_costing', breakdownCols);
    expect(matches['item_id']).toBe('Jewelry ID');
    expect(matches['weight']).toBe('Jewelry Weight (gms)');
    expect(matches['material_name']).toBe('Material Name');
    expect(matches['category_name']).toBe('Category Name');
    expect(matches['quantity']).toBe('Quantity');
    expect(matches['unit_cost']).toBe('Unit Cost (₹)');
    expect(matches['material_weight']).toBe('Hepoxy Weight (gms)');
  });

  it('accurately auto-matches standard system backup columns for Raw Materials', () => {
    const masterCols = [
      'Category',
      'Material Name / ID',
      'Weight (gms)',
      'Cost Price (₹)',
    ];

    const matches = autoMatchCostingColumns('raw_materials', masterCols);
    expect(matches['category_name']).toBe('Category');
    expect(matches['material_name']).toBe('Material Name / ID');
    expect(matches['cost_price']).toBe('Cost Price (₹)');
    expect(matches['weight']).toBe('Weight (gms)');
  });

  it('handles fuzzy variations in column headers for both sections', () => {
    const customCostingCols = [
      'DESIGN CODE',
      'Gross Wt',
      'Stone Variety',
      'Rate',
      'PCS',
    ];

    const cMatches = autoMatchCostingColumns('jewelry_costing', customCostingCols);
    expect(cMatches['item_id']).toBe('DESIGN CODE');
    expect(cMatches['weight']).toBe('Gross Wt');
    expect(cMatches['material_name']).toBe('Stone Variety');

    const customMatCols = [
      'Item Group',
      'Stone Name',
      'Rate/pc',
      'Total Stock',
    ];

    const mMatches = autoMatchCostingColumns('raw_materials', customMatCols);
    expect(mMatches['category_name']).toBe('Item Group');
    expect(mMatches['material_name']).toBe('Stone Name');
    expect(mMatches['cost_price']).toBe('Rate/pc');
  });

  it('renders CostingExcelRestoreModal without throwing when toggling between closed and open states', () => {
    // 1. Render when isOpen is false
    const htmlClosed = renderToStaticMarkup(
      <ToastProvider>
        <CostingExcelRestoreModal
          isOpen={false}
          onClose={() => {}}
          onRestoreSuccess={() => {}}
        />
      </ToastProvider>
    );
    expect(htmlClosed).not.toContain('Costing Excel Data Onboarding');

    // 2. Render when isOpen is true
    const htmlOpen = renderToStaticMarkup(
      <ToastProvider>
        <CostingExcelRestoreModal
          isOpen={true}
          onClose={() => {}}
          onRestoreSuccess={() => {}}
        />
      </ToastProvider>
    );
    expect(htmlOpen).toContain('Costing Excel Data Onboarding');
  });
});
