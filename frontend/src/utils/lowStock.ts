/**
 * The ONE low-stock rule (agreed 2026-11-19): an item is low when its stock is AT OR BELOW its threshold
 * ("threshold 5" = alert when 5 or fewer are left). Always computed from the current quantity — never from a
 * stored flag, which can be stale after an offline sale. Same rule on the server: backend/src/utils/lowStock.ts.
 */
export function isLowStock(item: { quantity: number | string; low_stock_threshold: number | string }): boolean {
  return Number(item.quantity) <= Number(item.low_stock_threshold);
}

/** SQL form of the same rule (the phone's own database). */
export const LOW_STOCK_SQL = 'quantity <= low_stock_threshold';
