import { describe, it, expect, vi } from 'vitest';
import * as XLSX from 'xlsx';

// ── Mocks must come BEFORE imports ──────────────────────────────

// Mock localDb (used by costingExcel.ts and costingDb.ts)
vi.mock('../localDb', () => ({
  localDb: {
    ready: Promise.resolve(),
    query: vi.fn().mockResolvedValue([]),
    get: vi.fn().mockResolvedValue(null),
    exec: vi.fn().mockResolvedValue(undefined),
  },
}));

// Mock costingDb functions that hit SQLite (called by costingExcel.ts import)
vi.mock('../costingDb', async () => {
  // We can't use importActual for costingDb because it also uses localDb
  // Instead, provide minimal stubs for the functions costingExcel needs
  return {
    getCostingCategories: vi.fn().mockResolvedValue([]),
    getCostingMaterialsByCategory: vi.fn().mockResolvedValue([]),
    createCostingCategory: vi.fn().mockResolvedValue({ id: 'new_cat', name: 'New Category' }),
    upsertCostingMaterial: vi.fn().mockResolvedValue({ material: { id: 'mat_1' }, wasUpdated: false }),
    saveJewelryCosting: vi.fn().mockResolvedValue({ id: 'jc_1' }),
    addCostingMaterial: vi.fn().mockResolvedValue({ id: 'mat_1' }),
  };
});

// ── Now import the module under test ────────────────────────────

import {
  buildJewelryCostingWorkbook,
  buildRawMaterialsWorkbook,
  parseCostingWorkbook,
} from '../costingExcel';
import type { CostingCategory, CostingJewelryRecord, CostingMaterial } from '../costingDb';

describe('costingExcel - Local Backup & Restoration', () => {
  const mockCategories: CostingCategory[] = [
    { id: 'ad_stone', name: 'AD Stone', sort_order: 1, is_system: 1, created_at: '', updated_at: '' },
    { id: 'kundan_stone', name: 'Kundan Stone', sort_order: 2, is_system: 1, created_at: '', updated_at: '' },
    { id: 'mop', name: 'MOP', sort_order: 3, is_system: 1, created_at: '', updated_at: '' },
    { id: 'hepoxy', name: 'Hepoxy', sort_order: 4, is_system: 1, created_at: '', updated_at: '' },
  ];

  const mockRecords: CostingJewelryRecord[] = [
    {
      id: 'jc_1',
      plated_jewelry_id: 'pj_ring_1',
      item_id: 'RING-001',
      weight: 3.50,
      cached_total_cost: 86.00,
      is_complete: true,
      created_at: '',
      updated_at: '',
      materials: [
        { categoryId: 'ad_stone', materialId: 'ad1', materialName: 'AD Stone A', quantity: 2, unitCost: 2.50 },
        { categoryId: 'kundan_stone', materialId: 'kd1', materialName: 'Kundan Stone B', quantity: 3, unitCost: 4.00 },
        { categoryId: 'mop', materialId: 'mop1', materialName: 'MOP A', quantity: 1, unitCost: 6.00 },
      ],
      calculated: {
        jewelryWeight: 3.50,
        multiplierX: 18.00,
        weightCost: 63.00,
        materialsCost: 23.00,
        totalCost: 86.00,
        isComplete: true,
        missingPriceMaterials: [],
        validationErrors: [],
        materials: [
          { categoryId: 'ad_stone', materialId: 'ad1', materialName: 'AD Stone A', quantity: 2, unitCost: 2.50, extendedCost: 5.00, hasMissingPrice: false },
          { categoryId: 'kundan_stone', materialId: 'kd1', materialName: 'Kundan Stone B', quantity: 3, unitCost: 4.00, extendedCost: 12.00, hasMissingPrice: false },
          { categoryId: 'mop', materialId: 'mop1', materialName: 'MOP A', quantity: 1, unitCost: 6.00, extendedCost: 6.00, hasMissingPrice: false },
        ],
      },
    },
  ];

  it('exports Jewelry Costing workbook with overview, breakdown, and metadata sheets', () => {
    const wb = buildJewelryCostingWorkbook(mockRecords, mockCategories, 18.00);
    expect(wb).toBeDefined();
    expect(wb.SheetNames).toContain('Jewelry_Costing_Overview');
    expect(wb.SheetNames).toContain('Costing_Material_Breakdown');
    expect(wb.SheetNames).toContain('_metadata');

    // Verify metadata sheet
    const metaRows: any[] = XLSX.utils.sheet_to_json(wb.Sheets['_metadata'], { defval: '' });
    const metaMap = new Map<string, string>();
    for (const r of metaRows) {
      metaMap.set(r.key, r.value);
    }
    expect(metaMap.get('signature')).toBe('poonam_creation_costing_backup');
    expect(metaMap.get('type')).toBe('jewelry_costing');
  });

  it('exports breakdown with exact material IDs for round-trip', () => {
    const wb = buildJewelryCostingWorkbook(mockRecords, mockCategories, 18.00);
    const breakdownRows: any[] = XLSX.utils.sheet_to_json(wb.Sheets['Costing_Material_Breakdown'], { defval: '' });

    expect(breakdownRows.length).toBe(3);

    const adRow = breakdownRows.find((r: any) => r['Material Name'] === 'AD Stone A');
    expect(adRow).toBeDefined();
    expect(adRow['Material ID']).toBe('ad1');
    expect(adRow['Jewelry ID']).toBe('RING-001');
    expect(adRow['Quantity']).toBe(2);
    expect(adRow['Unit Cost (₹)']).toBe(2.50);
    expect(adRow['Category ID']).toBe('ad_stone');
  });

  it('round-trip: export then parse produces identical jewelry data', async () => {
    const wb = buildJewelryCostingWorkbook(mockRecords, mockCategories, 18.00);
    const binary = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });

    const platedMap = new Map<string, string>();
    platedMap.set('RING-001', 'pj_ring_1');

    const parseResult = await parseCostingWorkbook(
      binary,
      'Jewelry_Costing_Backup.xlsx',
      platedMap,
      mockCategories
    );

    expect(parseResult.importType).toBe('jewelry_costing');
    expect(parseResult.stagedJewelry?.length).toBe(1);

    const staged = parseResult.stagedJewelry![0];
    expect(staged.itemId).toBe('RING-001');
    expect(staged.weight).toBe(3.50);
    expect(staged.isValid).toBe(true);
    expect(staged.materials.length).toBe(3);

    // Verify exact material data round-trip (material IDs preserved!)
    const adMat = staged.materials.find((m) => m.materialName === 'AD Stone A');
    expect(adMat).toBeDefined();
    expect(adMat?.materialId).toBe('ad1');
    expect(adMat?.quantity).toBe(2);
    expect(adMat?.unitCost).toBe(2.50);
    expect(adMat?.categoryId).toBe('ad_stone');

    const kdMat = staged.materials.find((m) => m.materialName === 'Kundan Stone B');
    expect(kdMat?.materialId).toBe('kd1');
    expect(kdMat?.quantity).toBe(3);
    expect(kdMat?.unitCost).toBe(4.00);
  });

  it('exports Raw Materials workbook with metadata', () => {
    const materialsByCat: Record<string, CostingMaterial[]> = {
      ad_stone: [
        { id: '1', category_id: 'ad_stone', name: 'AD 1', weight: null, cost_price: 2.50, is_deleted: 0, created_at: '', updated_at: '' },
      ],
    };

    const wb = buildRawMaterialsWorkbook(mockCategories, materialsByCat);
    expect(wb.SheetNames).toContain('All_Raw_Materials');
    expect(wb.SheetNames).toContain('_metadata');

    const metaRows: any[] = XLSX.utils.sheet_to_json(wb.Sheets['_metadata'], { defval: '' });
    const metaMap = new Map<string, string>();
    for (const r of metaRows) {
      metaMap.set(r.key, r.value);
    }
    expect(metaMap.get('type')).toBe('raw_materials');
  });

  it('round-trip: export then parse raw materials preserves null prices', async () => {
    const materialsByCat: Record<string, CostingMaterial[]> = {
      ad_stone: [
        { id: '1', category_id: 'ad_stone', name: 'AD 1', weight: null, cost_price: 2.50, is_deleted: 0, created_at: '', updated_at: '' },
        { id: '2', category_id: 'ad_stone', name: 'AD Blank', weight: null, cost_price: null, is_deleted: 0, created_at: '', updated_at: '' },
      ],
      hepoxy: [
        { id: '3', category_id: 'hepoxy', name: '0.45', weight: 0.45, cost_price: 30.00, is_deleted: 0, created_at: '', updated_at: '' },
      ],
    };

    const wb = buildRawMaterialsWorkbook(mockCategories, materialsByCat);
    const binary = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });

    const parseResult = await parseCostingWorkbook(
      binary,
      'Raw_Materials.xlsx',
      new Map(),
      mockCategories
    );

    expect(parseResult.importType).toBe('raw_materials');
    expect(parseResult.stagedMaterials?.length).toBe(3);

    const blankMat = parseResult.stagedMaterials?.find((m) => m.materialName === 'AD Blank');
    expect(blankMat).toBeDefined();
    expect(blankMat?.costPrice).toBeNull();

    const hepoxyMat = parseResult.stagedMaterials?.find((m) => m.materialName === '0.45');
    expect(hepoxyMat?.weight).toBe(0.45);
    expect(hepoxyMat?.costPrice).toBe(30.00);
  });

  it('identifies and reports invalid rows in import', async () => {
    const wb = XLSX.utils.book_new();
    const badRows = [
      {
        'Jewelry ID': 'BAD-001',
        'Jewelry Weight (gms)': -5,
        'Category Name': 'AD Stone',
        'Material Name': 'AD 1',
        'Quantity': -2,
      },
    ];
    const ws = XLSX.utils.json_to_sheet(badRows);
    XLSX.utils.book_append_sheet(wb, ws, 'Costing_Breakdown');

    const binary = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });

    const parseResult = await parseCostingWorkbook(
      binary,
      'Bad_File.xlsx',
      new Map(),
      mockCategories
    );

    expect(parseResult.invalidCount).toBe(1);
    expect(parseResult.stagedJewelry![0].isValid).toBe(false);
    expect(parseResult.stagedJewelry![0].errors.length).toBeGreaterThan(0);
  });

  it('detects backup type from _metadata signature', async () => {
    const materialsByCat: Record<string, CostingMaterial[]> = {
      ad_stone: [
        { id: '1', category_id: 'ad_stone', name: 'AD 1', weight: null, cost_price: 2.50, is_deleted: 0, created_at: '', updated_at: '' },
      ],
    };

    const wb = buildRawMaterialsWorkbook(mockCategories, materialsByCat);
    const binary = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });

    const parseResult = await parseCostingWorkbook(
      binary,
      'Raw_Materials_Backup.xlsx',
      new Map(),
      mockCategories
    );

    expect(parseResult.importType).toBe('raw_materials');
  });
});
