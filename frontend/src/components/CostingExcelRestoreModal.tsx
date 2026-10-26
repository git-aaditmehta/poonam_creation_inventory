import React, { useState, useEffect, useMemo } from 'react';
import {
  Upload,
  FileSpreadsheet,
  CheckCircle2,
  AlertCircle,
  AlertTriangle,
  Loader2,
  X,
  ArrowRight,
  ArrowLeft,
  Sparkles,
  Layers,
  Database,
  Check,
  RefreshCw,
} from 'lucide-react';
import * as XLSX from 'xlsx';
import {
  parseExcelWorksheet,
  serializeTarget,
  parseTarget,
  type ParsedExcelResult,
} from '../utils/excelParser';
import {
  saveJewelryCosting,
  upsertCostingMaterial,
  createCostingCategory,
  getCostingCategories,
  getCostingMaterialsByCategory,
  type CostingCategory,
} from '../lib/costingDb';
import {
  roundTo2,
  normalizeQuantity,
  formatRupees,
  type CostingMaterialEntry,
} from '../lib/costingEngine';
import { localDb } from '../lib/localDb';
import { useToast } from '../context/ToastContext';

export type CostingOnboardingSection = 'jewelry_costing' | 'raw_materials';

interface CostingFieldDef {
  key: string;
  label: string;
  required: boolean;
  description: string;
  hint?: string;
  aliases: string[];
}

export const COSTING_SECTION_FIELDS: Record<CostingOnboardingSection, CostingFieldDef[]> = {
  jewelry_costing: [
    {
      key: 'item_id',
      label: 'Jewelry ID / Design Code',
      required: true,
      description: 'Plated jewelry design code (e.g. RING-001, ER-104)',
      aliases: [
        'jewelry id / design',
        'jewelry id',
        'item id',
        'design code',
        'design id',
        'design no',
        'item name',
        'id',
        'code',
        'design',
        'plated jewelry reference',
        'style',
        'model',
      ],
    },
    {
      key: 'weight',
      label: 'Jewelry Gross Weight (gms)',
      required: true,
      description: 'Gross weight of jewelry piece in grams',
      aliases: [
        'jewelry weight (gms)',
        'jewelry weight',
        'weight (gms)',
        'weight',
        'wt',
        'gross weight',
        'gross wt',
        'gross wt.',
        'gms',
        'casting weight',
        'net weight',
      ],
    },
    {
      key: 'material_name',
      label: 'Material Name (Optional)',
      required: false,
      description: 'Raw material identifier (for breakdown / BOM rows)',
      aliases: [
        'material name',
        'material name / id',
        'material',
        'material id',
        'stone name',
        'stone',
        'variety',
        'item',
      ],
    },
    {
      key: 'category_name',
      label: 'Category Name (Optional)',
      required: false,
      description: 'Category (e.g. Kundan Stones, AD Stones, Hepoxy)',
      aliases: ['category name', 'category', 'category id', 'group', 'type'],
    },
    {
      key: 'quantity',
      label: 'Material Quantity / Count (Optional)',
      required: false,
      description: 'Pieces/count used (defaults to 1 if blank)',
      aliases: ['quantity', 'qty', 'count', 'pcs', 'pieces'],
    },
    {
      key: 'unit_cost',
      label: 'Material Unit Cost (₹) (Optional)',
      required: false,
      description: 'Unit cost in Rupees per piece/stone',
      aliases: [
        'unit cost (₹)',
        'unit cost',
        'cost price',
        'cost',
        'rate',
        'price',
        'rate/pc',
        'unit price',
      ],
    },
    {
      key: 'material_weight',
      label: 'Hepoxy / Stone Weight (gms) (Optional)',
      required: false,
      description: 'Hepoxy weight or unit stone weight in grams',
      aliases: ['hepoxy weight (gms)', 'hepoxy weight', 'stone weight', 'mat weight'],
    },
    {
      key: 'material_id',
      label: 'Material ID (Optional)',
      required: false,
      description: 'Database material ID for exact round-trip restoration',
      aliases: ['material id', 'mat_id', 'materialid'],
    },
  ],
  raw_materials: [
    {
      key: 'category_name',
      label: 'Category Name',
      required: true,
      description: 'Category group (e.g. Kundan Stones, AD Stones, Hepoxy)',
      hint: 'Defaults to sheet name if sheet represents category',
      aliases: ['category', 'category name', 'category id', 'group', 'type', 'section'],
    },
    {
      key: 'material_name',
      label: 'Material Name / Identifier',
      required: true,
      description: 'Stone name, size code, or Hepoxy dimension',
      aliases: [
        'material name / id',
        'material name',
        'material',
        'item name',
        'item',
        'name',
        'variety',
        'stone',
        'code',
        'size',
        'dimension',
        'hepoxy weight (gms)',
      ],
    },
    {
      key: 'cost_price',
      label: 'Cost Price (₹)',
      required: true,
      description: 'Purchase cost or unit price per piece/gram',
      aliases: [
        'cost price (₹)',
        'cost price',
        'cost',
        'purchase price',
        'price',
        'rate',
        'rate/pc',
        'unit cost',
        'unit cost (₹)',
        'cost/pc',
        'rate (rs)',
      ],
    },
    {
      key: 'weight',
      label: 'Material Weight (gms) (Optional)',
      required: false,
      description: 'Hepoxy weight or unit stone weight in grams',
      aliases: ['weight (gms)', 'weight', 'hepoxy weight (gms)', 'hepoxy weight', 'wt', 'gms'],
    },
  ],
};

export function autoMatchCostingColumns(
  section: CostingOnboardingSection,
  detectedColumns: string[]
): Record<string, string | null> {
  const fields = COSTING_SECTION_FIELDS[section] || [];
  const matches: Record<string, string | null> = {};
  const used = new Set<string>();

  for (const field of fields) {
    let bestCol: string | null = null;
    let highestScore = -1;

    for (let aIdx = 0; aIdx < field.aliases.length; aIdx++) {
      const alias = field.aliases[aIdx];
      const cleanAlias = alias.toLowerCase().replace(/[^a-z0-9]/g, '');
      const priorityBonus = (field.aliases.length - aIdx);

      for (const col of detectedColumns) {
        if (used.has(col)) continue;
        const cleanCol = col.toLowerCase().replace(/[^a-z0-9]/g, '');

        if (cleanCol === cleanAlias) {
          const score = 1000 + priorityBonus;
          if (score > highestScore) {
            highestScore = score;
            bestCol = col;
          }
        } else if (cleanCol.startsWith(cleanAlias)) {
          const score = 500 + priorityBonus;
          if (score > highestScore) {
            highestScore = score;
            bestCol = col;
          }
        } else if (cleanCol.includes(cleanAlias)) {
          const score = 200 + priorityBonus;
          if (score > highestScore) {
            highestScore = score;
            bestCol = col;
          }
        }
      }
    }

    if (bestCol) {
      matches[field.key] = bestCol;
      used.add(bestCol);
    } else {
      matches[field.key] = null;
    }
  }

  return matches;
}

export interface StagedJewelryCostingRow {
  rowNumber: number;
  plated_jewelry_id: string;
  itemId: string;
  weight: number;
  materials: CostingMaterialEntry[];
  isValid: boolean;
  isDuplicate: boolean;
  existingCostingId?: string;
  errors: string[];
  warnings: string[];
}

export interface StagedRawMaterialRow {
  rowNumber: number;
  categoryName: string;
  materialName: string;
  weight: number | null;
  costPrice: number | null;
  isValid: boolean;
  isDuplicate: boolean;
  errors: string[];
}

interface CostingExcelRestoreModalProps {
  isOpen: boolean;
  onClose: () => void;
  onRestoreSuccess: () => void;
  initialSection?: CostingOnboardingSection;
}

export const CostingExcelRestoreModal: React.FC<CostingExcelRestoreModalProps> = ({
  isOpen,
  onClose,
  onRestoreSuccess,
  initialSection = 'jewelry_costing',
}) => {
  const { showToast } = useToast();

  // Section Selector: 'jewelry_costing' vs 'raw_materials'
  const [section, setSection] = useState<CostingOnboardingSection>(initialSection);

  // Workflow Step: 'upload' | 'mapping' | 'staging'
  const [step, setStep] = useState<'upload' | 'mapping' | 'staging'>('upload');

  // Workbook parsing state
  const [fileName, setFileName] = useState('');
  const [parsedSheets, setParsedSheets] = useState<Record<string, ParsedExcelResult>>({});
  const [sheetNames, setSheetNames] = useState<string[]>([]);
  const [activeSheet, setActiveSheet] = useState<string>('');
  const [isReadingFile, setIsReadingFile] = useState(false);

  // Field Mapping State: fieldKey -> serialized target "sheet::col" or null
  const [fieldMapping, setFieldMapping] = useState<Record<string, string | null>>({});
  const [manualDefaults, setManualDefaults] = useState<Record<string, string>>({});

  // Staging state
  const [stagedJewelry, setStagedJewelry] = useState<StagedJewelryCostingRow[]>([]);
  const [stagedMaterials, setStagedMaterials] = useState<StagedRawMaterialRow[]>([]);
  const [isValidating, setIsValidating] = useState(false);
  const [isCommitting, setIsCommitting] = useState(false);
  const [filterMode, setFilterMode] = useState<'all' | 'valid' | 'issues' | 'duplicates'>('all');

  // Existing database catalog caches
  const [existingPlatedMap, setExistingPlatedMap] = useState<Map<string, string>>(new Map());
  const [existingCategories, setExistingCategories] = useState<CostingCategory[]>([]);
  const [existingCostingMap, setExistingCostingMap] = useState<Map<string, string>>(new Map());
  const [existingMaterialsMap, setExistingMaterialsMap] = useState<Map<string, Set<string>>>(new Map());

  // Load database metadata when modal opens
  useEffect(() => {
    if (!isOpen) return;

    (async () => {
      try {
        await localDb.ready;
        // Cache plated jewelry
        const platedRows = await localDb.query<any>(
          'SELECT id, item_id FROM plated_jewelry WHERE is_deleted = 0'
        );
        const pMap = new Map<string, string>();
        for (const p of platedRows) {
          pMap.set(p.item_id, p.id);
          pMap.set(p.item_id.toLowerCase(), p.id);
          pMap.set(p.id, p.id);
        }
        setExistingPlatedMap(pMap);

        // Cache categories
        const cats = await getCostingCategories();
        setExistingCategories(cats);

        // Cache existing costing records for duplicate detection
        const costingRows = await localDb.query<any>(
          `SELECT jc.id, jc.plated_jewelry_id, pj.item_id 
           FROM jewelry_costing jc
           LEFT JOIN plated_jewelry pj ON jc.plated_jewelry_id = pj.id OR jc.plated_jewelry_id = pj.item_id`
        );
        const cMap = new Map<string, string>();
        for (const c of costingRows) {
          const itemId = c.item_id || c.plated_jewelry_id;
          cMap.set(itemId.toLowerCase(), c.id);
          cMap.set(c.plated_jewelry_id.toLowerCase(), c.id);
        }
        setExistingCostingMap(cMap);

        // Cache existing materials per category for raw material duplicate detection
        const mMap = new Map<string, Set<string>>();
        for (const cat of cats) {
          try {
            const mats = await getCostingMaterialsByCategory(cat.id);
            const nameSet = new Set<string>();
            for (const m of mats) {
              nameSet.add(m.name.toLowerCase().trim());
            }
            mMap.set(cat.name.toLowerCase(), nameSet);
            mMap.set(cat.id.toLowerCase(), nameSet);
          } catch {
            // skip
          }
        }
        setExistingMaterialsMap(mMap);
      } catch (err: any) {
        console.warn('Could not cache existing inventory items:', err.message);
      }
    })();
  }, [isOpen]);

  // Reset when closed
  useEffect(() => {
    if (!isOpen) {
      setStep('upload');
      setFileName('');
      setParsedSheets({});
      setSheetNames([]);
      setActiveSheet('');
      setFieldMapping({});
      setManualDefaults({});
      setStagedJewelry([]);
      setStagedMaterials([]);
      setFilterMode('all');
    }
  }, [isOpen]);

  const activeParsed = parsedSheets[activeSheet];
  const detectedColumns = activeParsed?.detectedColumns || [];
  const rawRows = activeParsed?.rawRows || [];
  const currentFields = COSTING_SECTION_FIELDS[section] || [];

  // ── Switch Section (Costing vs Raw Materials) ─────────────────────

  const handleSectionChange = (newSec: CostingOnboardingSection) => {
    setSection(newSec);
    setStagedJewelry([]);
    setStagedMaterials([]);

    if (Object.keys(parsedSheets).length > 0) {
      // Re-run auto match for new section
      const targetSheet = activeSheet || Object.keys(parsedSheets)[0];
      const sParsed = parsedSheets[targetSheet];
      if (sParsed) {
        const matches = autoMatchCostingColumns(newSec, sParsed.detectedColumns);
        const newMap: Record<string, string | null> = {};
        for (const f of COSTING_SECTION_FIELDS[newSec]) {
          newMap[f.key] = matches[f.key] ? serializeTarget(targetSheet, matches[f.key]!) : null;
        }
        setFieldMapping(newMap);
      }
      setStep('mapping');
    }
  };

  // ── File Selection & Parsing ──────────────────────────────────────

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setIsReadingFile(true);
    setFileName(file.name);
    setStagedJewelry([]);
    setStagedMaterials([]);

    try {
      const data = await file.arrayBuffer();
      const wb = XLSX.read(data, { type: 'array' });
      const names = (wb.SheetNames || []).filter((s) => s !== '_metadata');

      if (names.length === 0) {
        showToast('error', 'Empty Workbook', 'No sheets found in this file.');
        setIsReadingFile(false);
        return;
      }

      setSheetNames(names);

      // Parse each sheet with smart header detection
      const map: Record<string, ParsedExcelResult> = {};
      for (const name of names) {
        const ws = wb.Sheets[name];
        if (ws) {
          try {
            const parsed = parseExcelWorksheet(ws, name);
            if (parsed.detectedColumns.length > 0) {
              map[name] = parsed;
            }
          } catch (err: any) {
            console.warn(`Could not parse sheet "${name}":`, err.message);
          }
        }
      }

      const parsedKeys = Object.keys(map);
      if (parsedKeys.length === 0) {
        showToast('error', 'No Valid Columns', 'Could not detect column headers in any sheet.');
        setIsReadingFile(false);
        return;
      }

      setParsedSheets(map);

      // Auto-detect section from _metadata sheet if present
      const metaSheet = wb.Sheets['_metadata'];
      if (metaSheet) {
        const metaRows: any[] = XLSX.utils.sheet_to_json(metaSheet, { defval: '' });
        const metaMap = new Map<string, string>();
        for (const r of metaRows) {
          metaMap.set(String(r['key'] || '').trim(), String(r['value'] || '').trim());
        }
        if (metaMap.get('signature') === 'poonam_creation_costing_backup') {
          const detectedType = metaMap.get('type');
          if (detectedType === 'raw_materials' && section !== 'raw_materials') {
            setSection('raw_materials');
          } else if (detectedType === 'jewelry_costing' && section !== 'jewelry_costing') {
            setSection('jewelry_costing');
          }
        }
      }

      // Intelligently pick best starting sheet based on current section
      let initialSheet = parsedKeys[0];
      if (section === 'jewelry_costing') {
        const bestCostingSheet = parsedKeys.find(
          (k) => k.toLowerCase().includes('breakdown') || k.toLowerCase().includes('costing')
        );
        if (bestCostingSheet) initialSheet = bestCostingSheet;
      } else {
        const bestMatSheet = parsedKeys.find(
          (k) => k.toLowerCase().includes('material') || k.toLowerCase().includes('all')
        );
        if (bestMatSheet) initialSheet = bestMatSheet;
      }

      setActiveSheet(initialSheet);

      // Auto-match columns
      const effectiveSection = section;
      const sMatches = autoMatchCostingColumns(effectiveSection, map[initialSheet].detectedColumns);
      const newMap: Record<string, string | null> = {};
      for (const field of COSTING_SECTION_FIELDS[effectiveSection]) {
        newMap[field.key] = sMatches[field.key]
          ? serializeTarget(initialSheet, sMatches[field.key]!)
          : null;
      }

      setFieldMapping(newMap);
      setManualDefaults({});
      setStep('mapping');

      showToast(
        'info',
        'Excel Loaded',
        `Workbook "${file.name}" loaded with ${parsedKeys.length} sheet(s). Active sheet: "${initialSheet}".`
      );
    } catch (err: any) {
      showToast('error', 'Failed to read Excel', err.message);
    } finally {
      setIsReadingFile(false);
    }
  };

  // ── Switch Active Sheet (Preserving Previous Mappings) ────────────

  const handleSelectSheet = (newSheetName: string) => {
    setActiveSheet(newSheetName);
    const newSheetParsed = parsedSheets[newSheetName];
    if (!newSheetParsed) return;

    setFieldMapping((prev) => {
      const updated = { ...prev };
      const unmappedFields = currentFields.filter((f) => !updated[f.key]);

      if (unmappedFields.length > 0) {
        const newMatches = autoMatchCostingColumns(section, newSheetParsed.detectedColumns);
        for (const f of unmappedFields) {
          if (newMatches[f.key]) {
            updated[f.key] = serializeTarget(newSheetName, newMatches[f.key]!);
          }
        }
      }
      return updated;
    });
  };

  // ── Helper to Read Mapped Field Value ─────────────────────────────

  const getFieldValue = (
    fieldKey: string,
    row: Record<string, any>,
    rowSheetName: string
  ): any => {
    const rawTarget = fieldMapping[fieldKey];
    const target = parseTarget(rawTarget);

    if (!target || !target.column) {
      return manualDefaults[fieldKey] || '';
    }

    if (target.sheet === rowSheetName) {
      const val = row[target.column];
      return val !== undefined && val !== null ? val : manualDefaults[fieldKey] || '';
    }

    return manualDefaults[fieldKey] || '';
  };

  // ── Step 2 -> Step 3: Validate and Build Staging Queue ─────────────

  const handleProceedToStaging = async () => {
    // Check required fields
    const missingRequired = currentFields.filter((f) => f.required && !fieldMapping[f.key]);
    if (missingRequired.length > 0) {
      showToast(
        'error',
        'Required Field Missing',
        `Please map: ${missingRequired.map((f) => f.label).join(', ')}`
      );
      return;
    }

    setIsValidating(true);

    try {
      const targetSheet = activeSheet || Object.keys(parsedSheets)[0];
      const parsedSheet = parsedSheets[targetSheet];
      if (!parsedSheet) {
        throw new Error('Active sheet not found.');
      }

      // Map categories for fast lookup
      const catMap = new Map<string, CostingCategory>();
      for (const c of existingCategories) {
        catMap.set(c.id.toLowerCase(), c);
        catMap.set(c.name.toLowerCase(), c);
        catMap.set(c.name.toLowerCase().replace(/\s+/g, '_'), c);
      }

      if (section === 'jewelry_costing') {
        // Build Jewelry Costing Staging Rows
        const grouped = new Map<string, any[]>();
        const itemTarget = parseTarget(fieldMapping['item_id']);

        parsedSheet.rawRows.forEach((row, idx) => {
          let itemId = '';
          if (itemTarget && itemTarget.column) {
            itemId = String(row[itemTarget.column] || '').trim();
          }
          if (!itemId) {
            itemId = String(manualDefaults['item_id'] || '').trim();
          }

          if (!itemId) return; // Skip blank spacer rows

          if (!grouped.has(itemId)) {
            grouped.set(itemId, []);
          }
          grouped.get(itemId)!.push({ row, idx });
        });

        if (grouped.size === 0) {
          showToast('warning', 'No Rows Found', 'No valid jewelry design rows found in this sheet.');
          setIsValidating(false);
          return;
        }

        const stagedList: StagedJewelryCostingRow[] = [];

        for (const [itemId, entries] of grouped.entries()) {
          const errors: string[] = [];
          const warnings: string[] = [];

          // Cross-reference with existing plated jewelry inventory
          const platedId =
            existingPlatedMap.get(itemId) ||
            existingPlatedMap.get(itemId.toLowerCase()) ||
            itemId;

          if (!existingPlatedMap.has(itemId) && !existingPlatedMap.has(itemId.toLowerCase())) {
            warnings.push(
              `Design "${itemId}" not in Plated Jewelry inventory (will still save costing).`
            );
          }

          // Duplicate detection: check if costing already exists
          const existingCostingId =
            existingCostingMap.get(itemId.toLowerCase()) ||
            existingCostingMap.get(platedId.toLowerCase());
          const isDuplicate = Boolean(existingCostingId);
          if (isDuplicate) {
            warnings.push('Costing already exists — will UPDATE existing record.');
          }

          // Extract weight from first entry
          const firstRow = entries[0].row;
          const rawWeight = getFieldValue('weight', firstRow, targetSheet);
          const weightNum = parseFloat(String(rawWeight).replace(/[^0-9.-]/g, ''));

          if (isNaN(weightNum) || weightNum <= 0) {
            errors.push('Invalid gross weight (must be > 0)');
          }

          // Extract materials
          const materials: CostingMaterialEntry[] = [];

          // Check if single-row materials or multiple breakdown rows
          for (const { row } of entries) {
            const matName = String(
              getFieldValue('material_name', row, targetSheet) || ''
            ).trim();
            const catName = String(
              getFieldValue('category_name', row, targetSheet) || ''
            ).trim();

            if (matName || catName) {
              const cat =
                catMap.get(catName.toLowerCase()) ||
                catMap.get(catName.toLowerCase().replace(/\s+/g, '_'));
              const catId = cat ? cat.id : catName ? catName.toLowerCase().replace(/\s+/g, '_') : 'kundan_stones';

              // Use actual material ID from backup if available
              const rawMatId = String(getFieldValue('material_id', row, targetSheet) || '').trim();
              const materialId = rawMatId || `mat_${matName.replace(/\s+/g, '_')}`;

              const rawQty = getFieldValue('quantity', row, targetSheet) || '1';
              const qtyNorm = normalizeQuantity(rawQty);
              if (!qtyNorm.valid && qtyNorm.error) {
                errors.push(`${matName || 'Material'}: ${qtyNorm.error}`);
              }

              const rawCost = getFieldValue('unit_cost', row, targetSheet);
              const costNum =
                rawCost !== '' && !isNaN(Number(String(rawCost).replace(/[^0-9.-]/g, '')))
                  ? roundTo2(Number(String(rawCost).replace(/[^0-9.-]/g, '')))
                  : null;

              const rawHepoxy = getFieldValue('material_weight', row, targetSheet);
              const hepoxyWeight =
                rawHepoxy !== '' && !isNaN(Number(String(rawHepoxy).replace(/[^0-9.-]/g, '')))
                  ? roundTo2(Number(String(rawHepoxy).replace(/[^0-9.-]/g, '')))
                  : null;

              materials.push({
                categoryId: catId,
                materialId,
                materialName: matName || 'Material',
                quantity: qtyNorm.quantity,
                unitCost: costNum,
                weight: hepoxyWeight,
              });
            }
          }

          // Also check for category columns if matrix sheet (e.g. Kundan Stones Composition)
          if (materials.length === 0) {
            for (const col of parsedSheet.detectedColumns) {
              const matchedCat = existingCategories.find(
                (c) =>
                  col.toLowerCase().includes(c.name.toLowerCase()) ||
                  col.toLowerCase().includes(c.id.toLowerCase())
              );
              if (matchedCat && !col.toLowerCase().includes('cost')) {
                const cellVal = String(firstRow[col] || '').trim();
                if (cellVal && cellVal !== '—' && cellVal !== '-') {
                  // Parse entries like "Pear 4x6 (12), Round 3mm (24)" or "Pear 4x6 (Qty: 12 @ ₹15.00)"
                  const parts = cellVal.split(/[,;]+/);
                  for (const part of parts) {
                    const trimmed = part.trim();
                    if (!trimmed) continue;

                    // Match pattern: "Name (Qty: 12 @ ₹15.00)" or "Name (12)"
                    const fullMatch = trimmed.match(/^([^(]+)(?:\((?:Qty:\s*)?([0-9.]+)(?:\s*@\s*₹?([0-9.]+))?\))?/i);
                    if (fullMatch) {
                      const mName = fullMatch[1].trim();
                      const mQty = fullMatch[2] ? parseFloat(fullMatch[2]) : 1;
                      const mCost = fullMatch[3] ? parseFloat(fullMatch[3]) : null;

                      materials.push({
                        categoryId: matchedCat.id,
                        materialId: `mat_${mName.replace(/\s+/g, '_')}`,
                        materialName: mName,
                        quantity: isNaN(mQty) ? 1 : mQty,
                        unitCost: mCost !== null && !isNaN(mCost) ? roundTo2(mCost) : null,
                        weight: null,
                      });
                    }
                  }
                }
              }
            }
          }

          const isValid = errors.length === 0;

          stagedList.push({
            rowNumber: entries[0].idx + 1 + parsedSheet.skippedHeaderCount + 1,
            plated_jewelry_id: platedId,
            itemId,
            weight: isNaN(weightNum) ? 0 : roundTo2(weightNum),
            materials,
            isValid,
            isDuplicate,
            existingCostingId,
            errors,
            warnings,
          });
        }

        setStagedJewelry(stagedList);
      } else {
        // Build Raw Materials Staging Rows
        const stagedList: StagedRawMaterialRow[] = [];

        parsedSheet.rawRows.forEach((row, idx) => {
          let cat = String(getFieldValue('category_name', row, targetSheet) || '').trim();
          if (!cat) {
            // Default to sheet name if sheet name looks like a category name
            cat = targetSheet;
          }

          const name = String(getFieldValue('material_name', row, targetSheet) || '').trim();
          const rawPrice = getFieldValue('cost_price', row, targetSheet);
          const rawWeight = getFieldValue('weight', row, targetSheet);

          if (!cat && !name) return; // Skip blank spacer row

          const errors: string[] = [];
          if (!cat) errors.push('Category name is required');
          if (!name) errors.push('Material name/ID is required');

          const cleanPrice = String(rawPrice).replace(/[^0-9.-]/g, '');
          const priceNum =
            rawPrice !== '' && !isNaN(Number(cleanPrice)) ? roundTo2(Number(cleanPrice)) : null;

          if (priceNum === null || priceNum < 0) {
            errors.push('Valid cost price (₹) is required');
          }

          const cleanWeight = String(rawWeight).replace(/[^0-9.-]/g, '');
          const weightNum =
            rawWeight !== '' && !isNaN(Number(cleanWeight)) ? roundTo2(Number(cleanWeight)) : null;

          // Duplicate detection
          const existingSet = existingMaterialsMap.get(cat.toLowerCase());
          const isDuplicate = existingSet ? existingSet.has(name.toLowerCase()) : false;

          const isValid = errors.length === 0;

          stagedList.push({
            rowNumber: idx + 1 + parsedSheet.skippedHeaderCount + 1,
            categoryName: cat,
            materialName: name,
            weight: weightNum,
            costPrice: priceNum,
            isValid,
            isDuplicate,
            errors,
          });
        });

        if (stagedList.length === 0) {
          showToast('warning', 'No Rows Found', 'No raw material rows detected in this sheet.');
          setIsValidating(false);
          return;
        }

        setStagedMaterials(stagedList);
      }

      setStep('staging');
    } catch (err: any) {
      showToast('error', 'Staging Failed', err.message);
    } finally {
      setIsValidating(false);
    }
  };

  // ── Step 3 -> Atomic Commit to Local SQLite ───────────────────────

  const handleCommit = async () => {
    setIsCommitting(true);

    try {
      if (section === 'jewelry_costing') {
        const validRows = stagedJewelry.filter((r) => r.isValid);
        if (validRows.length === 0) {
          showToast('error', 'No Valid Rows', 'There are no valid rows to commit.');
          setIsCommitting(false);
          return;
        }

        let newCount = 0;
        let updatedCount = 0;

        for (const item of validRows) {
          // saveJewelryCosting already does UPSERT via ON CONFLICT
          await saveJewelryCosting({
            plated_jewelry_id: item.plated_jewelry_id,
            weight: item.weight,
            materials: item.materials,
          });

          if (item.isDuplicate) {
            updatedCount++;
          } else {
            newCount++;
          }
        }

        const parts: string[] = [];
        if (newCount > 0) parts.push(`${newCount} new`);
        if (updatedCount > 0) parts.push(`${updatedCount} updated`);

        showToast(
          'success',
          'Jewelry Costing Restored',
          `Successfully saved ${parts.join(', ')} jewelry costing record(s) locally.`
        );
      } else {
        const validRows = stagedMaterials.filter((r) => r.isValid);
        if (validRows.length === 0) {
          showToast('error', 'No Valid Rows', 'There are no valid rows to commit.');
          setIsCommitting(false);
          return;
        }

        // Cache categories
        const existingCats = await getCostingCategories();
        const catNameToId = new Map<string, string>();
        for (const c of existingCats) {
          catNameToId.set(c.name.toLowerCase(), c.id);
        }

        let catsCreated = 0;
        let matsNew = 0;
        let matsUpdated = 0;

        for (const item of validRows) {
          const lower = item.categoryName.toLowerCase();
          let catId = catNameToId.get(lower);

          if (!catId) {
            const newCat = await createCostingCategory(item.categoryName);
            catId = newCat.id;
            catNameToId.set(lower, catId);
            catsCreated++;
          }

          // Use upsert to prevent duplicates
          const result = await upsertCostingMaterial({
            category_id: catId,
            name: item.materialName,
            weight: item.weight,
            cost_price: item.costPrice,
          });

          if (result.wasUpdated) {
            matsUpdated++;
          } else {
            matsNew++;
          }
        }

        const parts: string[] = [];
        if (matsNew > 0) parts.push(`${matsNew} new`);
        if (matsUpdated > 0) parts.push(`${matsUpdated} updated`);
        if (catsCreated > 0) parts.push(`${catsCreated} new category(ies)`);

        showToast(
          'success',
          'Raw Materials Restored',
          `Saved ${parts.join(', ')} raw material(s) locally.`
        );
      }

      onRestoreSuccess();
      onClose();
    } catch (err: any) {
      showToast('error', 'Commit Failed', err.message);
    } finally {
      setIsCommitting(false);
    }
  };

  // ── Counts and Filtering for Staging View ─────────────────────────

  const totalStaged =
    section === 'jewelry_costing' ? stagedJewelry.length : stagedMaterials.length;
  const validStagedCount =
    section === 'jewelry_costing'
      ? stagedJewelry.filter((r) => r.isValid).length
      : stagedMaterials.filter((r) => r.isValid).length;
  const issueStagedCount = totalStaged - validStagedCount;
  const duplicateStagedCount =
    section === 'jewelry_costing'
      ? stagedJewelry.filter((r) => r.isDuplicate).length
      : stagedMaterials.filter((r) => r.isDuplicate).length;

  const filteredStagedJewelry = useMemo(() => {
    if (filterMode === 'valid') return stagedJewelry.filter((r) => r.isValid && !r.isDuplicate);
    if (filterMode === 'issues') return stagedJewelry.filter((r) => !r.isValid || r.warnings.length > 0);
    if (filterMode === 'duplicates') return stagedJewelry.filter((r) => r.isDuplicate);
    return stagedJewelry;
  }, [stagedJewelry, filterMode]);

  const filteredStagedMaterials = useMemo(() => {
    if (filterMode === 'valid') return stagedMaterials.filter((r) => r.isValid && !r.isDuplicate);
    if (filterMode === 'issues') return stagedMaterials.filter((r) => !r.isValid);
    if (filterMode === 'duplicates') return stagedMaterials.filter((r) => r.isDuplicate);
    return stagedMaterials;
  }, [stagedMaterials, filterMode]);

  if (!isOpen) return null;

  return (
    <div className="modal-backdrop">
      <div
        className="modal-content"
        style={{
          maxWidth: 960,
          maxHeight: '92vh',
          display: 'flex',
          flexDirection: 'column',
          padding: 0,
          overflow: 'hidden',
        }}
      >
        {/* ── MODAL HEADER ────────────────────────────────────────── */}
        <div
          className="modal-header"
          style={{
            padding: '16px 24px',
            borderBottom: '1px solid var(--border-medium)',
            background: 'var(--bg-surface-2)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <FileSpreadsheet size={24} color="var(--teal-deep)" />
            <div>
              <h3 style={{ fontSize: 17, fontWeight: 700, margin: 0, color: 'var(--teal-deep)' }}>
                Costing Excel Data Onboarding & Restore
              </h3>
              <p style={{ fontSize: 12, color: 'var(--text-secondary)', margin: '2px 0 0 0' }}>
                Client-side parsing, smart column auto-matching, and atomic local SQLite staging. Zero cloud requests.
              </p>
            </div>
          </div>
          <button type="button" onClick={onClose} className="btn-icon" title="Close">
            <X size={18} />
          </button>
        </div>

        {/* ── SECTION SWITCHER TABS ─────────────────────────────────── */}
        <div
          style={{
            padding: '12px 24px',
            background: 'var(--bg-surface-1)',
            borderBottom: '1px solid var(--border-medium)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            flexWrap: 'wrap',
            gap: 12,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
              Target Section:
            </span>
            <div
              style={{
                display: 'inline-flex',
                background: 'var(--bg-surface-2)',
                borderRadius: 'var(--radius-md)',
                padding: 3,
                border: '1px solid var(--border-medium)',
              }}
            >
              <button
                type="button"
                onClick={() => handleSectionChange('jewelry_costing')}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  padding: '6px 14px',
                  fontSize: 12,
                  fontWeight: 700,
                  borderRadius: 'var(--radius-sm)',
                  border: 'none',
                  background: section === 'jewelry_costing' ? 'var(--teal-deep)' : 'transparent',
                  color: section === 'jewelry_costing' ? '#FFFFFF' : 'var(--text-secondary)',
                  cursor: 'pointer',
                  transition: 'all var(--transition-fast)',
                }}
              >
                <Sparkles size={14} /> Jewelry Costing
              </button>
              <button
                type="button"
                onClick={() => handleSectionChange('raw_materials')}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  padding: '6px 14px',
                  fontSize: 12,
                  fontWeight: 700,
                  borderRadius: 'var(--radius-sm)',
                  border: 'none',
                  background: section === 'raw_materials' ? 'var(--teal-deep)' : 'transparent',
                  color: section === 'raw_materials' ? '#FFFFFF' : 'var(--text-secondary)',
                  cursor: 'pointer',
                  transition: 'all var(--transition-fast)',
                }}
              >
                <Layers size={14} /> Raw Materials
              </button>
            </div>
          </div>

          <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
            {section === 'jewelry_costing'
              ? 'Maps: Jewelry ID, Gross Weight (gms), and Material Compositions'
              : 'Maps: Category Name, Material Name / Identifier, and Cost Price (₹)'}
          </div>
        </div>

        {/* ── MODAL BODY CONTENT ───────────────────────────────────── */}
        <div className="modal-body" style={{ flex: 1, overflowY: 'auto', padding: '24px' }}>
          {/* STEP 1: FILE UPLOAD DROPZONE */}
          {step === 'upload' && (
            <div>
              <div
                style={{
                  border: '2px dashed var(--teal-light)',
                  borderRadius: 'var(--radius-lg)',
                  padding: '48px 24px',
                  textAlign: 'center',
                  cursor: 'pointer',
                  background: 'var(--bg-surface-2)',
                  transition: 'all var(--transition-fast)',
                }}
                onClick={() => document.getElementById('costing-onboard-excel-input')?.click()}
              >
                <Upload size={44} color="var(--teal-deep)" style={{ margin: '0 auto 14px' }} />
                <h4 style={{ fontSize: 16, fontWeight: 700, color: 'var(--teal-deep)', margin: '0 0 6px 0' }}>
                  Upload Excel Spreadsheet (.xlsx, .xls, .csv)
                </h4>
                <p style={{ fontSize: 13, color: 'var(--text-secondary)', margin: '0 auto', maxWidth: 480 }}>
                  Supports both standard system backups and custom supplier spreadsheets. Top header banners, merged titles, and spacing rows will be automatically identified.
                </p>
                <input
                  id="costing-onboard-excel-input"
                  type="file"
                  accept=".xlsx,.xls,.csv"
                  style={{ display: 'none' }}
                  onChange={handleFileSelect}
                />
              </div>

              {isReadingFile && (
                <div style={{ marginTop: 24, textAlign: 'center', color: 'var(--text-secondary)' }}>
                  <Loader2 size={28} className="animate-spin" style={{ margin: '0 auto 8px', color: 'var(--teal-deep)' }} />
                  <div style={{ fontWeight: 600, fontSize: 13 }}>Analyzing workbook and sheets in-browser...</div>
                </div>
              )}
            </div>
          )}

          {/* STEP 2: INTERACTIVE COLUMN MAPPING BOARD */}
          {step === 'mapping' && (
            <div>
              {/* File & Sheets Banner */}
              <div
                style={{
                  background: 'var(--bg-surface-2)',
                  border: '1px solid var(--border-medium)',
                  borderRadius: 'var(--radius-md)',
                  padding: '12px 16px',
                  marginBottom: 20,
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  flexWrap: 'wrap',
                  gap: 12,
                }}
              >
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <FileSpreadsheet size={16} color="var(--teal-deep)" />
                    <strong style={{ fontSize: 13, color: 'var(--text-primary)' }}>{fileName}</strong>
                    <span style={{ fontSize: 11, background: 'var(--teal-faint)', color: 'var(--teal-deep)', padding: '2px 8px', borderRadius: 12, fontWeight: 700, border: '1px solid var(--teal-border)' }}>
                      {rawRows.length} data rows
                    </span>
                  </div>
                  {sheetNames.length > 1 && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
                      <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-secondary)' }}>Sheets:</span>
                      {sheetNames.map((s) => {
                        const isCurrent = activeSheet === s;
                        const sParsed = parsedSheets[s];
                        return (
                          <button
                            key={s}
                            type="button"
                            onClick={() => handleSelectSheet(s)}
                            style={{
                              padding: '3px 8px',
                              fontSize: 11,
                              borderRadius: 4,
                              cursor: 'pointer',
                              border: isCurrent ? '1.5px solid var(--teal-deep)' : '1px solid var(--border-medium)',
                              background: isCurrent ? 'var(--teal-deep)' : 'var(--bg-surface-1)',
                              color: isCurrent ? '#FFFFFF' : 'var(--text-primary)',
                              fontWeight: isCurrent ? 700 : 500,
                            }}
                          >
                            {s} {sParsed ? `(${sParsed.detectedColumns.length} cols)` : ''}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>

                <button
                  type="button"
                  onClick={() => {
                    setStep('upload');
                    setParsedSheets({});
                  }}
                  className="btn btn-secondary"
                  style={{ fontSize: 12, padding: '4px 10px' }}
                >
                  Choose Different File
                </button>
              </div>

              {/* Column Mapping Header */}
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  fontSize: 11,
                  fontWeight: 700,
                  textTransform: 'uppercase',
                  letterSpacing: '0.06em',
                  color: 'var(--text-secondary)',
                  padding: '0 8px 10px 8px',
                  borderBottom: '1px solid var(--border-subtle)',
                  marginBottom: 16,
                }}
              >
                <div style={{ width: 280 }}>System Field</div>
                <div style={{ flex: 1, textAlign: 'center' }}>Auto Mapping</div>
                <div style={{ width: 340 }}>Excel Column (Sheet: {activeSheet})</div>
              </div>

              {/* Mapping Rows */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                {currentFields.map((field) => {
                  const target = parseTarget(fieldMapping[field.key]);
                  const isMapped = Boolean(target && target.column);
                  const currentMappedCol = target?.column || '';

                  // Sample values from the sheet where the column lives
                  const sampleValues =
                    isMapped && target?.sheet && parsedSheets[target.sheet]
                      ? parsedSheets[target.sheet]?.columnSamples[currentMappedCol] || []
                      : [];

                  return (
                    <div
                      key={field.key}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 16,
                        background: 'var(--bg-surface-1)',
                        padding: '12px 16px',
                        borderRadius: 'var(--radius-md)',
                        border: isMapped ? '1px solid var(--teal-border)' : '1px solid var(--border-medium)',
                      }}
                    >
                      {/* Left Box: System Field */}
                      <div style={{ width: 280, flexShrink: 0 }}>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 2 }}>
                          <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)' }}>
                            {field.label}
                          </span>
                          <span
                            className={field.required ? 'badge badge-rose' : 'badge badge-gold'}
                            style={{ fontSize: 9, padding: '1px 6px', fontWeight: 700 }}
                          >
                            {field.required ? 'REQUIRED' : 'OPTIONAL'}
                          </span>
                        </div>
                        <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{field.description}</div>
                      </div>

                      {/* Middle Connector */}
                      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                        {isMapped ? (
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--teal-deep)', fontSize: 11, fontWeight: 700 }}>
                            <Check size={14} /> Auto-Mapped <ArrowRight size={14} />
                          </div>
                        ) : (
                          <div style={{ color: 'var(--text-muted)', fontSize: 11 }}>
                            — Unmapped —
                          </div>
                        )}
                      </div>

                      {/* Right Box: Excel Column Selector */}
                      <div style={{ width: 340, flexShrink: 0 }}>
                        <select
                          className="select"
                          value={fieldMapping[field.key] || ''}
                          onChange={(e) =>
                            setFieldMapping((prev) => ({
                              ...prev,
                              [field.key]: e.target.value || null,
                            }))
                          }
                          style={{ width: '100%', fontSize: 12, padding: '6px 10px', height: 32 }}
                        >
                          <option value="">— None (Unmapped) —</option>
                          {detectedColumns.map((col) => (
                            <option key={col} value={serializeTarget(activeSheet, col)}>
                              {col}
                            </option>
                          ))}
                          {sheetNames
                            .filter((s) => s !== activeSheet)
                            .map((s) => {
                              const otherParsed = parsedSheets[s];
                              return (
                                <optgroup key={s} label={`Sheet: ${s}`}>
                                  {otherParsed?.detectedColumns.map((c) => (
                                    <option key={`${s}::${c}`} value={serializeTarget(s, c)}>
                                      {s} ➔ {c}
                                    </option>
                                  ))}
                                </optgroup>
                              );
                            })}
                        </select>

                        {/* Sample preview under mapped column */}
                        {isMapped && sampleValues.length > 0 && (
                          <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            Samples: {sampleValues.slice(0, 3).map((v) => JSON.stringify(v)).join(', ')}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* STEP 3: STAGING & SAFE PREVIEW TABLE */}
          {step === 'staging' && (
            <div>
              {/* Summary Bar */}
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  background: 'var(--bg-surface-2)',
                  padding: '12px 16px',
                  borderRadius: 'var(--radius-md)',
                  marginBottom: 16,
                  border: '1px solid var(--border-medium)',
                  flexWrap: 'wrap',
                  gap: 12,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)' }}>
                    Total: {totalStaged} Rows
                  </span>
                  <span style={{ color: '#059669', fontSize: 12, fontWeight: 700 }}>
                    {validStagedCount} Ready
                  </span>
                  {duplicateStagedCount > 0 && (
                    <span style={{ color: '#D97706', fontSize: 12, fontWeight: 700, display: 'flex', alignItems: 'center', gap: 4 }}>
                      <RefreshCw size={12} /> {duplicateStagedCount} Will Update
                    </span>
                  )}
                  {issueStagedCount > 0 && (
                    <span style={{ color: '#DC2626', fontSize: 12, fontWeight: 700 }}>
                      {issueStagedCount} Issues
                    </span>
                  )}
                </div>

                {/* Filter buttons */}
                <div style={{ display: 'flex', gap: 6 }}>
                  <button
                    type="button"
                    onClick={() => setFilterMode('all')}
                    className={`btn btn-secondary ${filterMode === 'all' ? 'active' : ''}`}
                    style={{ fontSize: 11, padding: '3px 10px', height: 28 }}
                  >
                    All ({totalStaged})
                  </button>
                  <button
                    type="button"
                    onClick={() => setFilterMode('valid')}
                    className={`btn btn-secondary ${filterMode === 'valid' ? 'active' : ''}`}
                    style={{ fontSize: 11, padding: '3px 10px', height: 28 }}
                  >
                    New Only ({validStagedCount - duplicateStagedCount})
                  </button>
                  {duplicateStagedCount > 0 && (
                    <button
                      type="button"
                      onClick={() => setFilterMode('duplicates')}
                      className={`btn btn-secondary ${filterMode === 'duplicates' ? 'active' : ''}`}
                      style={{ fontSize: 11, padding: '3px 10px', height: 28 }}
                    >
                      Updates ({duplicateStagedCount})
                    </button>
                  )}
                  {issueStagedCount > 0 && (
                    <button
                      type="button"
                      onClick={() => setFilterMode('issues')}
                      className={`btn btn-secondary ${filterMode === 'issues' ? 'active' : ''}`}
                      style={{ fontSize: 11, padding: '3px 10px', height: 28 }}
                    >
                      Issues ({issueStagedCount})
                    </button>
                  )}
                </div>
              </div>

              {/* Jewelry Costing Staging Table */}
              {section === 'jewelry_costing' && (
                <div style={{ maxHeight: 380, overflowY: 'auto', border: '1px solid var(--border-medium)', borderRadius: 'var(--radius-md)' }}>
                  <table className="data-table" style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }}>
                    <thead>
                      <tr style={{ background: 'var(--bg-surface-2)', borderBottom: '2px solid var(--border-medium)', textAlign: 'left' }}>
                        <th style={{ padding: '10px 12px', width: 60, color: 'var(--teal-deep)' }}>Status</th>
                        <th style={{ padding: '10px 12px', color: 'var(--teal-deep)' }}>Jewelry ID / Design</th>
                        <th style={{ padding: '10px 12px', textAlign: 'right', color: 'var(--teal-deep)' }}>Gross Wt (gms)</th>
                        <th style={{ padding: '10px 12px', color: 'var(--teal-deep)' }}>Materials Composition</th>
                        <th style={{ padding: '10px 12px', color: 'var(--teal-deep)' }}>Validation Notes</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredStagedJewelry.length === 0 ? (
                        <tr>
                          <td colSpan={5} style={{ padding: 24, textAlign: 'center', color: 'var(--text-secondary)' }}>
                            No rows matching selected filter.
                          </td>
                        </tr>
                      ) : (
                        filteredStagedJewelry.map((row, idx) => (
                          <tr key={idx} style={{ borderBottom: '1px solid var(--border-subtle)', background: 'var(--bg-surface-1)' }}>
                            <td style={{ padding: '10px 12px' }}>
                              {row.isValid ? (
                                row.isDuplicate ? (
                                  <span title="Will update existing record" style={{ display: 'inline-flex' }}>
                                    <RefreshCw size={16} color="#D97706" />
                                  </span>
                                ) : row.warnings.length > 0 ? (
                                  <span title={row.warnings.join(', ')} style={{ display: 'inline-flex' }}>
                                    <AlertTriangle size={16} color="#D97706" />
                                  </span>
                                ) : (
                                  <span title="Valid — New record" style={{ display: 'inline-flex' }}>
                                    <CheckCircle2 size={16} color="#059669" />
                                  </span>
                                )
                              ) : (
                                <span title={row.errors.join(', ')} style={{ display: 'inline-flex' }}>
                                  <AlertCircle size={16} color="#DC2626" />
                                </span>
                              )}
                            </td>
                            <td style={{ padding: '10px 12px', fontWeight: 700, color: 'var(--teal-deep)' }}>
                              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                {row.itemId}
                                {row.isDuplicate && (
                                  <span style={{
                                    fontSize: 9,
                                    fontWeight: 700,
                                    background: '#FEF3C7',
                                    color: '#92400E',
                                    padding: '1px 5px',
                                    borderRadius: 3,
                                    border: '1px solid #FDE68A',
                                  }}>
                                    UPDATE
                                  </span>
                                )}
                              </div>
                            </td>
                            <td style={{ padding: '10px 12px', textAlign: 'right', fontWeight: 600, color: 'var(--text-primary)' }} className="mono">
                              {row.weight.toFixed(2)}
                            </td>
                            <td style={{ padding: '10px 12px' }}>
                              {row.materials.length === 0 ? (
                                <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>No materials attached</span>
                              ) : (
                                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                                  {row.materials.slice(0, 3).map((m, mIdx) => (
                                    <span
                                      key={mIdx}
                                      style={{
                                        fontSize: 11,
                                        background: 'var(--teal-faint)',
                                        border: '1px solid var(--teal-border)',
                                        padding: '1px 6px',
                                        borderRadius: 4,
                                        color: 'var(--text-primary)',
                                      }}
                                    >
                                      {m.materialName} ({m.quantity})
                                    </span>
                                  ))}
                                  {row.materials.length > 3 && (
                                    <span style={{ fontSize: 11, color: 'var(--text-secondary)', padding: '1px 4px' }}>
                                      +{row.materials.length - 3} more
                                    </span>
                                  )}
                                </div>
                              )}
                            </td>
                            <td style={{ padding: '10px 12px', fontSize: 12 }}>
                              {row.errors.length > 0 ? (
                                <span style={{ color: '#DC2626', fontWeight: 600 }}>{row.errors.join(', ')}</span>
                              ) : row.isDuplicate ? (
                                <span style={{ color: '#D97706', fontWeight: 600 }}>Existing record will be updated</span>
                              ) : row.warnings.length > 0 ? (
                                <span style={{ color: '#D97706', fontWeight: 600 }}>{row.warnings.join(', ')}</span>
                              ) : (
                                <span style={{ color: '#059669', fontWeight: 600 }}>Ready to restore</span>
                              )}
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              )}

              {/* Raw Materials Staging Table */}
              {section === 'raw_materials' && (
                <div style={{ maxHeight: 380, overflowY: 'auto', border: '1px solid var(--border-medium)', borderRadius: 'var(--radius-md)' }}>
                  <table className="data-table" style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }}>
                    <thead>
                      <tr style={{ background: 'var(--bg-surface-2)', borderBottom: '2px solid var(--border-medium)', textAlign: 'left' }}>
                        <th style={{ padding: '10px 12px', width: 60, color: 'var(--teal-deep)' }}>Status</th>
                        <th style={{ padding: '10px 12px', color: 'var(--teal-deep)' }}>Category</th>
                        <th style={{ padding: '10px 12px', color: 'var(--teal-deep)' }}>Material Name / ID</th>
                        <th style={{ padding: '10px 12px', textAlign: 'right', color: 'var(--teal-deep)' }}>Weight (gms)</th>
                        <th style={{ padding: '10px 12px', textAlign: 'right', color: 'var(--teal-deep)' }}>Cost Price (₹)</th>
                        <th style={{ padding: '10px 12px', color: 'var(--teal-deep)' }}>Validation Notes</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredStagedMaterials.length === 0 ? (
                        <tr>
                          <td colSpan={6} style={{ padding: 24, textAlign: 'center', color: 'var(--text-secondary)' }}>
                            No rows matching selected filter.
                          </td>
                        </tr>
                      ) : (
                        filteredStagedMaterials.map((row, idx) => (
                          <tr key={idx} style={{ borderBottom: '1px solid var(--border-subtle)', background: 'var(--bg-surface-1)' }}>
                            <td style={{ padding: '10px 12px' }}>
                              {row.isValid ? (
                                row.isDuplicate ? (
                                  <span title="Will update existing material" style={{ display: 'inline-flex' }}>
                                    <RefreshCw size={16} color="#D97706" />
                                  </span>
                                ) : (
                                  <span title="Valid — New material" style={{ display: 'inline-flex' }}>
                                    <CheckCircle2 size={16} color="#059669" />
                                  </span>
                                )
                              ) : (
                                <span title={row.errors.join(', ')} style={{ display: 'inline-flex' }}>
                                  <AlertCircle size={16} color="#DC2626" />
                                </span>
                              )}
                            </td>
                            <td style={{ padding: '10px 12px', fontWeight: 600, color: 'var(--teal-deep)' }}>
                              {row.categoryName}
                            </td>
                            <td style={{ padding: '10px 12px', color: 'var(--text-primary)', fontWeight: 600 }}>
                              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                {row.materialName}
                                {row.isDuplicate && (
                                  <span style={{
                                    fontSize: 9,
                                    fontWeight: 700,
                                    background: '#FEF3C7',
                                    color: '#92400E',
                                    padding: '1px 5px',
                                    borderRadius: 3,
                                    border: '1px solid #FDE68A',
                                  }}>
                                    UPDATE
                                  </span>
                                )}
                              </div>
                            </td>
                            <td style={{ padding: '10px 12px', textAlign: 'right', color: 'var(--text-primary)' }} className="mono">
                              {row.weight !== null ? row.weight.toFixed(2) : '—'}
                            </td>
                            <td style={{ padding: '10px 12px', textAlign: 'right', fontWeight: 700, color: 'var(--teal-deep)' }} className="mono">
                              {row.costPrice !== null ? formatRupees(row.costPrice) : '—'}
                            </td>
                            <td style={{ padding: '10px 12px', fontSize: 12 }}>
                              {row.errors.length > 0 ? (
                                <span style={{ color: '#DC2626', fontWeight: 600 }}>{row.errors.join(', ')}</span>
                              ) : row.isDuplicate ? (
                                <span style={{ color: '#D97706', fontWeight: 600 }}>Existing material will be updated</span>
                              ) : (
                                <span style={{ color: '#059669', fontWeight: 600 }}>Valid</span>
                              )}
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </div>

        {/* ── MODAL FOOTER ACTIONS ─────────────────────────────────── */}
        <div
          className="modal-footer"
          style={{
            padding: '16px 24px',
            borderTop: '1px solid var(--border-medium)',
            background: 'var(--bg-surface-2)',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
          }}
        >
          <div>
            {step === 'staging' && (
              <button
                type="button"
                onClick={() => setStep('mapping')}
                className="btn btn-secondary"
                style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}
              >
                <ArrowLeft size={14} /> Back to Mapping
              </button>
            )}
            {step === 'mapping' && (
              <button
                type="button"
                onClick={() => setStep('upload')}
                className="btn btn-secondary"
                style={{ fontSize: 12 }}
              >
                Back to Upload
              </button>
            )}
          </div>

          <div style={{ display: 'flex', gap: 10 }}>
            <button type="button" onClick={onClose} className="btn btn-secondary">
              Cancel
            </button>

            {step === 'mapping' && (
              <button
                type="button"
                onClick={handleProceedToStaging}
                className="btn btn-primary"
                disabled={isValidating}
                style={{ display: 'flex', alignItems: 'center', gap: 6 }}
              >
                {isValidating ? (
                  <>
                    <Loader2 size={14} className="animate-spin" /> Validating...
                  </>
                ) : (
                  <>
                    Continue to Staging <ArrowRight size={14} />
                  </>
                )}
              </button>
            )}

            {step === 'staging' && (
              <button
                type="button"
                onClick={handleCommit}
                className="btn btn-primary"
                disabled={isCommitting || validStagedCount === 0}
                style={{ display: 'flex', alignItems: 'center', gap: 6 }}
              >
                {isCommitting ? (
                  <>
                    <Loader2 size={14} className="animate-spin" /> Committing to SQLite...
                  </>
                ) : (
                  <>
                    <Database size={15} /> Commit to Local Costing Database ({validStagedCount} valid)
                  </>
                )}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
