/**
 * costingExcel.ts
 * 
 * Local-only Excel Backup & Restoration engine for the Costing system.
 * Uses SheetJS (xlsx) strictly in-browser.
 * 
 * ZERO CLOUD DATA BOUNDARY:
 * No uploaded file or parsed costing data is EVER sent to any remote server.
 * 
 * ROUND-TRIP FIDELITY:
 * The export format is specifically designed so that importing the exact same
 * file on a different device reproduces identical data. The relational
 * "Costing_Material_Breakdown" sheet carries all machine-readable fields
 * including material IDs, category IDs, and weights. A hidden "_metadata"
 * sheet tags the file as a Poonam Creation backup for reliable detection.
 */

import * as XLSX from 'xlsx';
import type { CostingCategory, CostingMaterial, CostingJewelryRecord } from './costingDb';
import {
  saveJewelryCosting,
  upsertCostingMaterial,
  createCostingCategory,
  getCostingCategories,
  getCostingMaterialsByCategory,
} from './costingDb';
import { roundTo2, normalizeQuantity, type CostingMaterialEntry } from './costingEngine';
import { localDb } from './localDb';

// ── Constants ────────────────────────────────────────────────────

const BACKUP_SIGNATURE = 'poonam_creation_costing_backup';
const BACKUP_VERSION = 2;

// Deterministic column names used in the relational breakdown sheet
const BK = {
  JEWELRY_ID: 'Jewelry ID',
  PLATED_REF: 'Plated Jewelry Reference',
  WEIGHT: 'Jewelry Weight (gms)',
  CATEGORY_ID: 'Category ID',
  CATEGORY_NAME: 'Category Name',
  MATERIAL_ID: 'Material ID',
  MATERIAL_NAME: 'Material Name',
  QUANTITY: 'Quantity',
  UNIT_COST: 'Unit Cost (₹)',
  EXTENDED_COST: 'Extended Cost (₹)',
  HEPOXY_WEIGHT: 'Hepoxy Weight (gms)',
} as const;

// Deterministic column names for raw materials master sheet
const RM = {
  CATEGORY: 'Category',
  MATERIAL_NAME: 'Material Name / ID',
  WEIGHT: 'Weight (gms)',
  COST_PRICE: 'Cost Price (₹)',
} as const;

// ── Export 1: Jewelry Costing Excel ──────────────────────────────

export function buildJewelryCostingWorkbook(
  records: CostingJewelryRecord[],
  categories: CostingCategory[],
  multiplierX: number
): XLSX.WorkBook {
  const wb = XLSX.utils.book_new();

  // ── Sheet 1: Human-readable Expanded Spreadsheet View ──
  const summaryRows = records.map((r) => {
    const calc = r.calculated;
    const row: Record<string, any> = {
      'Jewelry ID / Design': r.item_id,
      'Jewelry Weight (gms)': r.weight,
      'Multiplier X (₹)': multiplierX,
      'Weight Cost (₹)': calc?.weightCost ?? roundTo2(r.weight * multiplierX),
    };

    // Add category columns
    for (const cat of categories) {
      const catMats = (calc?.materials || []).filter((m) => m.categoryId === cat.id);
      if (catMats.length === 0) {
        row[`${cat.name} Composition`] = '';
        row[`${cat.name} Cost (₹)`] = 0;
      } else {
        row[`${cat.name} Composition`] = catMats
          .map((m) => `${m.materialName} (Qty: ${m.quantity} @ ${m.unitCost !== null ? `₹${m.unitCost.toFixed(2)}` : 'No Price'})`)
          .join(', ');
        const catSum = catMats.reduce((acc, m) => acc + (m.extendedCost || 0), 0);
        row[`${cat.name} Cost (₹)`] = roundTo2(catSum);
      }
    }

    row['Total Manufacturing Cost (₹)'] = calc?.totalCost ?? r.cached_total_cost;
    row['Status'] = r.is_complete ? 'Complete' : 'Incomplete (Missing Prices)';
    return row;
  });

  const wsSummary = XLSX.utils.json_to_sheet(summaryRows);
  XLSX.utils.book_append_sheet(wb, wsSummary, 'Jewelry_Costing_Overview');

  // ── Sheet 2: Machine-readable Relational Material Breakdown ──
  // This is the CANONICAL sheet for 100% round-trip restoration.
  // Each row = one material usage in one jewelry design.
  // Jewelry with no materials gets a single row with empty material columns.
  const breakdownRows: any[] = [];
  for (const r of records) {
    if (!r.materials || r.materials.length === 0) {
      breakdownRows.push({
        [BK.JEWELRY_ID]: r.item_id,
        [BK.PLATED_REF]: r.plated_jewelry_id,
        [BK.WEIGHT]: r.weight,
        [BK.CATEGORY_ID]: '',
        [BK.CATEGORY_NAME]: '',
        [BK.MATERIAL_ID]: '',
        [BK.MATERIAL_NAME]: '',
        [BK.QUANTITY]: '',
        [BK.UNIT_COST]: '',
        [BK.EXTENDED_COST]: '',
        [BK.HEPOXY_WEIGHT]: '',
      });
    } else {
      for (const m of r.materials) {
        const cat = categories.find((c) => c.id === m.categoryId);
        const extCost = m.unitCost !== null && m.unitCost !== undefined
          ? roundTo2((typeof m.quantity === 'number' ? m.quantity : 1) * m.unitCost)
          : '';

        breakdownRows.push({
          [BK.JEWELRY_ID]: r.item_id,
          [BK.PLATED_REF]: r.plated_jewelry_id,
          [BK.WEIGHT]: r.weight,
          [BK.CATEGORY_ID]: m.categoryId,
          [BK.CATEGORY_NAME]: cat?.name || m.categoryId,
          [BK.MATERIAL_ID]: m.materialId,
          [BK.MATERIAL_NAME]: m.materialName,
          [BK.QUANTITY]: m.quantity ?? 1,
          [BK.UNIT_COST]: m.unitCost !== null && m.unitCost !== undefined ? m.unitCost : '',
          [BK.EXTENDED_COST]: extCost,
          [BK.HEPOXY_WEIGHT]: m.weight ?? '',
        });
      }
    }
  }

  const wsBreakdown = XLSX.utils.json_to_sheet(breakdownRows);
  XLSX.utils.book_append_sheet(wb, wsBreakdown, 'Costing_Material_Breakdown');

  // ── Sheet 3: Hidden _metadata for backup identification ──
  const metaRows = [
    { key: 'signature', value: BACKUP_SIGNATURE },
    { key: 'version', value: String(BACKUP_VERSION) },
    { key: 'type', value: 'jewelry_costing' },
    { key: 'exported_at', value: new Date().toISOString() },
    { key: 'record_count', value: String(records.length) },
    { key: 'multiplier_x', value: String(multiplierX) },
  ];
  const wsMeta = XLSX.utils.json_to_sheet(metaRows);
  XLSX.utils.book_append_sheet(wb, wsMeta, '_metadata');

  return wb;
}

export function exportJewelryCostingWorkbook(
  records: CostingJewelryRecord[],
  categories: CostingCategory[],
  multiplierX: number
): void {
  const wb = buildJewelryCostingWorkbook(records, categories, multiplierX);
  const filename = `Jewelry_Costing_Backup_${new Date().toISOString().slice(0, 10)}.xlsx`;
  XLSX.writeFile(wb, filename);
}

// ── Export 2: Raw Materials Excel ────────────────────────────────

export function buildRawMaterialsWorkbook(
  categories: CostingCategory[],
  materialsByCat: Record<string, CostingMaterial[]>
): XLSX.WorkBook {
  const wb = XLSX.utils.book_new();

  // 1. Unified Master Sheet: All_Materials
  const allRows: any[] = [];
  for (const cat of categories) {
    const list = materialsByCat[cat.id] || [];
    for (const m of list) {
      allRows.push({
        [RM.CATEGORY]: cat.name,
        [RM.MATERIAL_NAME]: m.name,
        [RM.WEIGHT]: m.weight !== null ? m.weight : '',
        [RM.COST_PRICE]: m.cost_price !== null ? m.cost_price : '',
      });
    }
  }
  const wsAll = XLSX.utils.json_to_sheet(allRows);
  XLSX.utils.book_append_sheet(wb, wsAll, 'All_Raw_Materials');

  // 2. Individual Category Sheets
  for (const cat of categories) {
    const list = materialsByCat[cat.id] || [];
    const catRows = list.map((m) => {
      const isHepoxy = cat.id === 'hepoxy';
      if (isHepoxy) {
        return {
          'Hepoxy Weight (gms)': m.weight !== null ? m.weight : m.name,
          [RM.COST_PRICE]: m.cost_price !== null ? m.cost_price : '',
        };
      }
      return {
        [RM.MATERIAL_NAME]: m.name,
        [RM.WEIGHT]: m.weight !== null ? m.weight : '',
        [RM.COST_PRICE]: m.cost_price !== null ? m.cost_price : '',
      };
    });

    const safeSheetName = cat.name.replace(/[/\\?*[\]]/g, '_').slice(0, 31);
    const ws = XLSX.utils.json_to_sheet(catRows);
    XLSX.utils.book_append_sheet(wb, ws, safeSheetName);
  }

  // 3. Hidden _metadata for backup identification
  const metaRows = [
    { key: 'signature', value: BACKUP_SIGNATURE },
    { key: 'version', value: String(BACKUP_VERSION) },
    { key: 'type', value: 'raw_materials' },
    { key: 'exported_at', value: new Date().toISOString() },
    { key: 'category_count', value: String(categories.length) },
  ];
  const wsMeta = XLSX.utils.json_to_sheet(metaRows);
  XLSX.utils.book_append_sheet(wb, wsMeta, '_metadata');

  return wb;
}

export function exportRawMaterialsWorkbook(
  categories: CostingCategory[],
  materialsByCat: Record<string, CostingMaterial[]>
): void {
  const wb = buildRawMaterialsWorkbook(categories, materialsByCat);
  const filename = `Costing_Raw_Materials_Backup_${new Date().toISOString().slice(0, 10)}.xlsx`;
  XLSX.writeFile(wb, filename);
}

// ── Restoration & Parsing ────────────────────────────────────────

export interface StagedJewelryCostingImport {
  plated_jewelry_id: string;
  itemId: string;
  weight: number;
  materials: CostingMaterialEntry[];
  isValid: boolean;
  isDuplicate: boolean;       // true if this jewelry already has costing in local DB
  existingCostingId?: string; // the existing costing record ID (for upsert)
  errors: string[];
  warnings: string[];
}

export interface StagedRawMaterialImport {
  categoryName: string;
  materialName: string;
  weight: number | null;
  costPrice: number | null;
  isValid: boolean;
  isDuplicate: boolean;       // true if material already exists in category
  errors: string[];
}

export interface CostingImportParseResult {
  importType: 'jewelry_costing' | 'raw_materials';
  stagedJewelry?: StagedJewelryCostingImport[];
  stagedMaterials?: StagedRawMaterialImport[];
  fileName: string;
  totalRows: number;
  validCount: number;
  invalidCount: number;
  duplicateCount: number;
  generalErrors: string[];
}

// ── Metadata Detection ───────────────────────────────────────────

interface BackupMeta {
  signature: string;
  version: number;
  type: 'jewelry_costing' | 'raw_materials';
}

function readBackupMetadata(wb: XLSX.WorkBook): BackupMeta | null {
  const metaSheet = wb.Sheets['_metadata'];
  if (!metaSheet) return null;

  const rows: any[] = XLSX.utils.sheet_to_json(metaSheet, { defval: '' });
  const map = new Map<string, string>();
  for (const r of rows) {
    const k = String(r['key'] || r['Key'] || '').trim();
    const v = String(r['value'] || r['Value'] || '').trim();
    if (k) map.set(k, v);
  }

  if (map.get('signature') !== BACKUP_SIGNATURE) return null;

  return {
    signature: BACKUP_SIGNATURE,
    version: parseInt(map.get('version') || '1', 10),
    type: (map.get('type') as any) || 'jewelry_costing',
  };
}

/**
 * Intelligently parse a local Excel workbook and determine whether it's a
 * Jewelry Costing backup or Raw Materials backup.
 * 
 * Detection priority:
 * 1. _metadata sheet signature (from our own backups)
 * 2. Sheet name heuristics (Costing_Material_Breakdown, All_Raw_Materials)
 * 3. Column header heuristics
 */
export async function parseCostingWorkbook(
  data: ArrayBuffer,
  fileName: string,
  existingPlatedJewelryMap: Map<string, string>, // itemId -> id
  existingCategories: CostingCategory[]
): Promise<CostingImportParseResult> {
  const wb = XLSX.read(data, { type: 'array' });
  const sheetNames = wb.SheetNames || [];

  if (sheetNames.length === 0) {
    throw new Error('Excel workbook contains no sheets.');
  }

  // 1. Check for our backup metadata signature
  const meta = readBackupMetadata(wb);
  if (meta) {
    if (meta.type === 'jewelry_costing') {
      return parseJewelryCostingImport(wb, fileName, sheetNames, existingPlatedJewelryMap, existingCategories);
    } else {
      return parseRawMaterialsImport(wb, fileName, sheetNames, existingCategories);
    }
  }

  // 2. Heuristic detection by sheet names
  const hasBreakdownSheet = sheetNames.some((s) => s.toLowerCase().includes('breakdown'));
  const hasCostingSheet = sheetNames.some((s) => s.toLowerCase().includes('costing'));
  const isJewelryCosting = hasBreakdownSheet || hasCostingSheet;

  if (isJewelryCosting) {
    return parseJewelryCostingImport(wb, fileName, sheetNames, existingPlatedJewelryMap, existingCategories);
  } else {
    return parseRawMaterialsImport(wb, fileName, sheetNames, existingCategories);
  }
}

// ── Jewelry Costing Import Parser ────────────────────────────────

async function parseJewelryCostingImport(
  wb: XLSX.WorkBook,
  fileName: string,
  sheetNames: string[],
  existingPlatedJewelryMap: Map<string, string>,
  existingCategories: CostingCategory[]
): Promise<CostingImportParseResult> {
  // Prefer the detailed breakdown sheet
  const breakdownSheetName = sheetNames.find((s) => s.toLowerCase().includes('breakdown')) || sheetNames[0];
  const ws = wb.Sheets[breakdownSheetName];
  const rawRows: any[] = XLSX.utils.sheet_to_json(ws, { defval: '' });

  // Build category lookup
  const catMap = new Map<string, CostingCategory>();
  for (const c of existingCategories) {
    catMap.set(c.id.toLowerCase(), c);
    catMap.set(c.name.toLowerCase(), c);
    catMap.set(c.name.toLowerCase().replace(/\s+/g, '_'), c);
    catMap.set(c.id.toLowerCase().replace(/\s+/g, '_'), c);

    // Aliases
    if (c.id === 'kundan_stone' || c.name.toLowerCase().includes('kundan')) {
      catMap.set('kundan_stones', c);
      catMap.set('kundan stones', c);
      catMap.set('stones', c);
      catMap.set('kundan', c);
    }
    if (c.id === 'ad_stone' || c.name.toLowerCase().includes('ad')) {
      catMap.set('ad_stones', c);
      catMap.set('ad stones', c);
      catMap.set('ad', c);
    }
    if (c.id === 'mop') {
      catMap.set('mops', c);
    }
  }

  // Build existing costing lookup for duplicate detection
  const existingCostingMap = new Map<string, string>(); // item_id (lowercase) -> costing ID
  try {
    await localDb.ready;
    const existingCostings = await localDb.query<{ id: string; plated_jewelry_id: string; item_id?: string }>(
      `SELECT jc.id, jc.plated_jewelry_id, pj.item_id 
       FROM jewelry_costing jc
       LEFT JOIN plated_jewelry pj ON jc.plated_jewelry_id = pj.id OR jc.plated_jewelry_id = pj.item_id`
    );
    for (const ec of existingCostings) {
      const itemId = ec.item_id || ec.plated_jewelry_id;
      existingCostingMap.set(itemId.toLowerCase(), ec.id);
      existingCostingMap.set(ec.plated_jewelry_id.toLowerCase(), ec.id);
    }
  } catch {
    // If DB query fails, skip duplicate detection
  }

  // Group rows by Jewelry ID
  const groupedByJewelry = new Map<string, any[]>();
  for (const row of rawRows) {
    const jewelryId = String(
      row[BK.JEWELRY_ID] || row['Jewelry ID / Design'] || row['Item ID'] || row['item_id'] || ''
    ).trim();
    if (!jewelryId) continue;

    if (!groupedByJewelry.has(jewelryId)) {
      groupedByJewelry.set(jewelryId, []);
    }
    groupedByJewelry.get(jewelryId)!.push(row);
  }

  const stagedJewelry: StagedJewelryCostingImport[] = [];
  let validCount = 0;
  let invalidCount = 0;
  let duplicateCount = 0;

  for (const [jewelryId, rows] of groupedByJewelry.entries()) {
    const errors: string[] = [];
    const warnings: string[] = [];

    // Cross-reference with plated jewelry
    const platedId = existingPlatedJewelryMap.get(jewelryId) || existingPlatedJewelryMap.get(jewelryId.toLowerCase()) || jewelryId;
    if (!existingPlatedJewelryMap.has(jewelryId) && !existingPlatedJewelryMap.has(jewelryId.toLowerCase())) {
      warnings.push(`Design "${jewelryId}" not in Plated Jewelry inventory.`);
    }

    // Check for existing costing record (duplicate detection)
    const existingCostingId = existingCostingMap.get(jewelryId.toLowerCase()) || existingCostingMap.get(platedId.toLowerCase());
    const isDuplicate = Boolean(existingCostingId);
    if (isDuplicate) {
      warnings.push(`Costing record already exists — will UPDATE.`);
      duplicateCount++;
    }

    // Extract weight
    const firstRow = rows[0];
    const rawWeight = firstRow[BK.WEIGHT] || firstRow['Jewelry Weight'] || firstRow['weight'] || '';
    const weightNum = parseFloat(rawWeight);
    if (isNaN(weightNum) || weightNum <= 0) {
      errors.push('Invalid jewelry weight (must be > 0)');
    }

    // Extract materials
    const materials: CostingMaterialEntry[] = [];

    for (const r of rows) {
      const matName = String(r[BK.MATERIAL_NAME] || r['Material'] || r['material_name'] || '').trim();
      const catName = String(r[BK.CATEGORY_NAME] || r[BK.CATEGORY_ID] || r['Category'] || '').trim();

      if (!matName && !catName) continue;

      const cat = catMap.get(catName.toLowerCase()) || catMap.get(catName.toLowerCase().replace(/\s+/g, '_'));
      const catId = cat ? cat.id : catName ? catName.toLowerCase().replace(/\s+/g, '_') : 'kundan_stone';

      // Use actual material ID from the backup if available; otherwise generate one
      const rawMatId = String(r[BK.MATERIAL_ID] || '').trim();
      const materialId = rawMatId || `mat_${matName.replace(/\s+/g, '_')}`;

      const rawQty = r[BK.QUANTITY] || r['qty'] || '1';
      const qtyNorm = normalizeQuantity(rawQty);
      if (!qtyNorm.valid && qtyNorm.error) {
        errors.push(`${matName || 'Material'}: ${qtyNorm.error}`);
      }

      const rawCost = r[BK.UNIT_COST] || r['Unit Cost'] || r['unit_cost'] || '';
      const unitCost = rawCost !== '' && !isNaN(Number(rawCost)) ? roundTo2(Number(rawCost)) : null;

      const rawHepoxyWeight = r[BK.HEPOXY_WEIGHT] || r['Hepoxy Weight'] || '';
      const hepoxyWeight = rawHepoxyWeight !== '' && !isNaN(Number(rawHepoxyWeight)) ? roundTo2(Number(rawHepoxyWeight)) : null;

      materials.push({
        categoryId: catId,
        materialId,
        materialName: matName,
        quantity: qtyNorm.quantity,
        unitCost,
        weight: hepoxyWeight,
      });
    }

    const isValid = errors.length === 0;
    if (isValid) validCount++;
    else invalidCount++;

    stagedJewelry.push({
      plated_jewelry_id: platedId,
      itemId: jewelryId,
      weight: isNaN(weightNum) ? 0 : roundTo2(weightNum),
      materials,
      isValid,
      isDuplicate,
      existingCostingId,
      errors,
      warnings,
    });
  }

  return {
    importType: 'jewelry_costing',
    stagedJewelry,
    fileName,
    totalRows: stagedJewelry.length,
    validCount,
    invalidCount,
    duplicateCount,
    generalErrors: [],
  };
}

// ── Raw Materials Import Parser ──────────────────────────────────

async function parseRawMaterialsImport(
  wb: XLSX.WorkBook,
  fileName: string,
  sheetNames: string[],
  existingCategories: CostingCategory[]
): Promise<CostingImportParseResult> {
  const stagedMaterials: StagedRawMaterialImport[] = [];
  let validCount = 0;
  let invalidCount = 0;
  let duplicateCount = 0;

  // Build existing materials lookup for duplicate detection
  const existingMaterialsMap = new Map<string, Set<string>>(); // catNameLower -> Set<matNameLower>
  try {
    for (const cat of existingCategories) {
      const mats = await getCostingMaterialsByCategory(cat.id);
      const nameSet = new Set<string>();
      for (const m of mats) {
        nameSet.add(m.name.toLowerCase().trim());
      }
      existingMaterialsMap.set(cat.name.toLowerCase(), nameSet);
      existingMaterialsMap.set(cat.id.toLowerCase(), nameSet);
    }
  } catch {
    // Skip if DB fails
  }

  // Filter out _metadata sheet
  const dataSheets = sheetNames.filter((s) => s !== '_metadata');

  // If there's an 'All_Raw_Materials' or 'All_Materials' sheet, use that
  const allSheetName = dataSheets.find((s) => s.toLowerCase().includes('all'));
  if (allSheetName) {
    const rows: any[] = XLSX.utils.sheet_to_json(wb.Sheets[allSheetName], { defval: '' });
    for (const r of rows) {
      const cat = String(r[RM.CATEGORY] || r['category'] || '').trim();
      const name = String(r[RM.MATERIAL_NAME] || r['Material'] || r['Name'] || r['name'] || '').trim();
      const rawPrice = r[RM.COST_PRICE] || r['Cost Price'] || r['cost_price'] || '';
      const rawWeight = r[RM.WEIGHT] || r['Weight'] || r['weight'] || '';

      if (!cat && !name) continue;

      const errors: string[] = [];
      if (!cat) errors.push('Category is required');
      if (!name) errors.push('Material name/ID is required');

      const costPrice = rawPrice !== '' && !isNaN(Number(rawPrice)) ? roundTo2(Number(rawPrice)) : null;
      const weight = rawWeight !== '' && !isNaN(Number(rawWeight)) ? roundTo2(Number(rawWeight)) : null;

      // Duplicate detection
      const existingSet = existingMaterialsMap.get(cat.toLowerCase());
      const isDuplicate = existingSet ? existingSet.has(name.toLowerCase()) : false;
      if (isDuplicate) duplicateCount++;

      const isValid = errors.length === 0;
      if (isValid) validCount++;
      else invalidCount++;

      stagedMaterials.push({
        categoryName: cat,
        materialName: name,
        weight,
        costPrice,
        isValid,
        isDuplicate,
        errors,
      });
    }
  } else {
    // Parse each sheet as a category
    for (const sName of dataSheets) {
      const rows: any[] = XLSX.utils.sheet_to_json(wb.Sheets[sName], { defval: '' });
      for (const r of rows) {
        const name = String(r[RM.MATERIAL_NAME] || r['Hepoxy Weight (gms)'] || r['Name'] || r['name'] || '').trim();
        const rawPrice = r[RM.COST_PRICE] || r['Cost Price'] || r['cost_price'] || '';
        const rawWeight = r[RM.WEIGHT] || r['Hepoxy Weight (gms)'] || r['Weight'] || '';

        if (!name && rawWeight === '') continue;

        const errors: string[] = [];
        const costPrice = rawPrice !== '' && !isNaN(Number(rawPrice)) ? roundTo2(Number(rawPrice)) : null;
        const weight = rawWeight !== '' && !isNaN(Number(rawWeight)) ? roundTo2(Number(rawWeight)) : null;

        const matName = name || (weight !== null ? weight.toFixed(2) : '');
        if (!matName) errors.push('Material identifier is required');

        // Duplicate detection
        const existingSet = existingMaterialsMap.get(sName.toLowerCase());
        const isDuplicate = existingSet ? existingSet.has(matName.toLowerCase()) : false;
        if (isDuplicate) duplicateCount++;

        const isValid = errors.length === 0;
        if (isValid) validCount++;
        else invalidCount++;

        stagedMaterials.push({
          categoryName: sName,
          materialName: matName,
          weight,
          costPrice,
          isValid,
          isDuplicate,
          errors,
        });
      }
    }
  }

  return {
    importType: 'raw_materials',
    stagedMaterials,
    fileName,
    totalRows: stagedMaterials.length,
    validCount,
    invalidCount,
    duplicateCount,
    generalErrors: [],
  };
}

// ── Commit Imported Records into Local SQLite ────────────────────

/**
 * Commit jewelry costing imports using UPSERT semantics.
 * If a costing record already exists for a plated_jewelry_id, it will be
 * updated (not duplicated).
 */
export async function commitJewelryCostingImport(
  staged: StagedJewelryCostingImport[]
): Promise<{ committedCount: number; updatedCount: number; skippedCount: number }> {
  let committedCount = 0;
  let updatedCount = 0;
  let skippedCount = 0;

  for (const item of staged) {
    if (!item.isValid) {
      skippedCount++;
      continue;
    }

    // saveJewelryCosting already does UPSERT via ON CONFLICT
    // and checks for existing costing by plated_jewelry_id
    await saveJewelryCosting({
      plated_jewelry_id: item.plated_jewelry_id,
      weight: item.weight,
      materials: item.materials,
    });

    if (item.isDuplicate) {
      updatedCount++;
    } else {
      committedCount++;
    }
  }

  return { committedCount, updatedCount, skippedCount };
}

/**
 * Commit raw materials imports using UPSERT semantics.
 * If a material with the same name already exists in a category,
 * it will be updated (not duplicated).
 */
export async function commitRawMaterialsImport(
  staged: StagedRawMaterialImport[]
): Promise<{ categoriesCreated: number; materialsRestored: number; materialsUpdated: number }> {
  const existingCats = await getCostingCategories();
  const catNameToId = new Map<string, string>();
  for (const c of existingCats) {
    catNameToId.set(c.name.toLowerCase(), c.id);
  }

  let categoriesCreated = 0;
  let materialsRestored = 0;
  let materialsUpdated = 0;

  for (const item of staged) {
    if (!item.isValid) continue;

    const lowerCat = item.categoryName.toLowerCase();
    let catId = catNameToId.get(lowerCat);

    // Auto-create category if does not exist
    if (!catId) {
      const newCat = await createCostingCategory(item.categoryName);
      catId = newCat.id;
      catNameToId.set(lowerCat, catId);
      categoriesCreated++;
    }

    // Upsert material (prevents duplicates)
    const result = await upsertCostingMaterial({
      category_id: catId,
      name: item.materialName,
      weight: item.weight,
      cost_price: item.costPrice,
    });

    if (result.wasUpdated) {
      materialsUpdated++;
    } else {
      materialsRestored++;
    }
  }

  return { categoriesCreated, materialsRestored, materialsUpdated };
}
