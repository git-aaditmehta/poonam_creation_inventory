/**
 * The ONE low-stock rule (agreed 2026-11-19): an item is low when its stock is AT OR BELOW its threshold
 * ("threshold 5" = alert when 5 or fewer are left). Same rule on the phone: frontend/src/utils/lowStock.ts.
 */
export function isLowStock(quantity: number, threshold: number): boolean {
  return Number(quantity) <= Number(threshold);
}

/** SQL form of the same rule. */
export const LOW_STOCK_SQL = 'quantity <= low_stock_threshold';
