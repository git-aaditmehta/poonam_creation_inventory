import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

describe('Costing Privacy and Sync Boundary Verification', () => {
  const syncEngineSrc = fs.readFileSync(
    path.resolve(__dirname, '../syncEngine.ts'),
    'utf-8'
  );
  const pendingOpsSrc = fs.readFileSync(
    path.resolve(__dirname, '../pendingOps.ts'),
    'utf-8'
  );
  const localDbSrc = fs.readFileSync(
    path.resolve(__dirname, '../localDb.ts'),
    'utf-8'
  );
  const costingDbSrc = fs.readFileSync(
    path.resolve(__dirname, '../costingDb.ts'),
    'utf-8'
  );
  const appSrc = fs.readFileSync(
    path.resolve(__dirname, '../../App.tsx'),
    'utf-8'
  );

  it('ensures syncEngine NEVER references any costing tables', () => {
    const costingTables = [
      'costing_settings',
      'costing_categories',
      'costing_materials',
      'jewelry_costing',
      'jewelry_costing_materials',
    ];

    for (const table of costingTables) {
      expect(syncEngineSrc.includes(table)).toBe(false);
      expect(pendingOpsSrc.includes(table)).toBe(false);
    }
  });

  it('ensures syncEngine bootstrap does not clear costing tables', () => {
    expect(syncEngineSrc.includes("clearTable('costing_")).toBe(false);
    expect(syncEngineSrc.includes("clearTable('jewelry_costing")).toBe(false);
  });

  it('ensures localDb.clearTable and clearAll whitelist only inventory tables', () => {
    // Valid tables in localDb.clearTable must not include costing tables
    expect(localDbSrc.includes("'costing_settings'")).toBe(false);
    expect(localDbSrc.includes("'jewelry_costing'")).toBe(false);
  });

  it('ensures costingDb makes zero remote network/API calls', () => {
    expect(costingDbSrc.includes("fetch(")).toBe(false);
    expect(costingDbSrc.includes("api.")).toBe(false);
    expect(costingDbSrc.includes("apiRequest")).toBe(false);
  });

  it('ensures Staff cannot access Costing tab in App.tsx', () => {
    // App.tsx must guard activeTab === 'costing' with currentUser.role === 'owner'
    expect(appSrc).toContain("activeTab === 'costing' && currentUser.role === 'owner'");
  });
});
