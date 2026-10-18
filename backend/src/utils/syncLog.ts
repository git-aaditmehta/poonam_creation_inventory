/**
 * syncLog.ts
 * 
 * Utility to log changes to the sync_changes CDC table.
 * Called by inventory, stock, and excel routes after every mutation.
 */

/**
 * Log a change to the sync_changes CDC table.
 * 
 * @param db - D1 database binding
 * @param entityType - Table name (plated_jewelry, raw_jewelry, stones, foil, transactions)
 * @param entityId - The ID of the changed entity
 * @param operation - 'CREATE' | 'UPDATE' | 'DELETE'
 * @param payload - The full entity data as JSON (for CREATE/UPDATE), or {} for DELETE
 */
export async function logSyncChange(
  db: D1Database,
  entityType: string,
  entityId: string,
  operation: 'CREATE' | 'UPDATE' | 'DELETE',
  payload: Record<string, unknown> = {}
): Promise<void> {
  try {
    await db.prepare(
      `INSERT INTO sync_changes (entity_type, entity_id, operation, payload) VALUES (?, ?, ?, ?)`
    ).bind(entityType, entityId, operation, JSON.stringify(payload)).run();
  } catch (err) {
    // Don't let sync logging failure block the main operation
    console.error('[SyncLog] Failed to log change:', err);
  }
}

/**
 * Log a change and return the prepared statement for use in a batch.
 * Use this when you need to batch the sync log with other operations.
 */
export function prepareSyncChangeStatement(
  db: D1Database,
  entityType: string,
  entityId: string,
  operation: 'CREATE' | 'UPDATE' | 'DELETE',
  payload: Record<string, unknown> = {}
): D1PreparedStatement {
  return db.prepare(
    `INSERT INTO sync_changes (entity_type, entity_id, operation, payload) VALUES (?, ?, ?, ?)`
  ).bind(entityType, entityId, operation, JSON.stringify(payload));
}
