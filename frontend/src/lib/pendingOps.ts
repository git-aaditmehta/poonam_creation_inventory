/**
 * pendingOps.ts
 * 
 * Manages the offline mutation queue. Every write operation
 * (create/update/delete/stock) gets enqueued here for background sync.
 */

import { localDb } from './localDb';

export interface PendingOp {
  id: string;
  idempotency_key: string;
  entity_type: string;       // 'plated_jewelry' | 'raw_jewelry' | 'stones' | 'foil' | 'stock'
  operation: string;          // 'CREATE' | 'UPDATE' | 'DELETE' | 'STOCK_OPERATE'
  endpoint: string;           // API endpoint path
  method: string;             // 'POST' | 'PUT' | 'DELETE'
  payload: string;            // JSON.stringify(body)
  status: 'PENDING' | 'SYNCING' | 'FAILED' | 'DONE';
  error_message?: string;
  retry_count: number;
  created_at: string;
  synced_at?: string;
}

/** Enqueue a new pending operation. */
export async function enqueuePendingOp(op: Omit<PendingOp, 'id' | 'status' | 'retry_count' | 'created_at'>): Promise<string> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  const payloadStr = typeof op.payload === 'string' ? op.payload : JSON.stringify(op.payload);

  await localDb.exec(
    `INSERT INTO pending_ops (id, idempotency_key, entity_type, operation, endpoint, method, payload, status, retry_count, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDING', 0, ?)`,
    [id, op.idempotency_key, op.entity_type, op.operation, op.endpoint, op.method, payloadStr, now]
  );

  // Notify listeners about new pending op
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('pending-ops-changed'));
  }

  return id;
}

/** Get all pending operations sorted by creation time (most recent first). */
export async function getAllPendingOps(): Promise<PendingOp[]> {
  return localDb.query<PendingOp>(
    'SELECT * FROM pending_ops ORDER BY created_at DESC LIMIT 50'
  );
}

/** Get count of pending (not yet synced) operations. */
export async function getPendingCount(): Promise<number> {
  return localDb.count('pending_ops', "status = 'PENDING' OR status = 'SYNCING' OR status = 'FAILED'");
}

/** Get the next batch of PENDING operations to process. */
export async function getNextPendingBatch(limit: number = 10): Promise<PendingOp[]> {
  return localDb.query<PendingOp>(
    "SELECT * FROM pending_ops WHERE status = 'PENDING' ORDER BY created_at ASC LIMIT ?",
    [limit]
  );
}

/** Update the status of a pending operation. */
export async function updatePendingOpStatus(
  id: string,
  status: PendingOp['status'],
  errorMessage?: string
): Promise<void> {
  if (status === 'DONE') {
    await localDb.exec(
      "UPDATE pending_ops SET status = ?, synced_at = ?, error_message = NULL WHERE id = ?",
      [status, new Date().toISOString(), id]
    );
  } else if (status === 'FAILED') {
    await localDb.exec(
      "UPDATE pending_ops SET status = ?, error_message = ?, retry_count = retry_count + 1 WHERE id = ?",
      [status, errorMessage || 'Unknown error', id]
    );
  } else {
    await localDb.exec(
      "UPDATE pending_ops SET status = ? WHERE id = ?",
      [status, id]
    );
  }

  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('pending-ops-changed'));
  }
}

/** Remove a completed or discarded operation. */
export async function removePendingOp(id: string): Promise<void> {
  await localDb.deleteItem('pending_ops', id);
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('pending-ops-changed'));
  }
}

/** Retry a failed operation by resetting its status to PENDING. */
export async function retryPendingOp(id: string): Promise<void> {
  await localDb.exec(
    "UPDATE pending_ops SET status = 'PENDING', error_message = NULL WHERE id = ?",
    [id]
  );
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('pending-ops-changed'));
  }
}

/** Clear all DONE operations. */
export async function clearDoneOps(): Promise<void> {
  await localDb.exec("DELETE FROM pending_ops WHERE status = 'DONE'");
}

/** 
 * Clear operations safely.
 * If force is false (default), only purges 'DONE' operations to preserve unsynced offline mutations.
 * If force is true, purges the entire table.
 */
export async function clearAllOps(force = false): Promise<void> {
  if (force) {
    await localDb.clearTable('pending_ops');
  } else {
    await localDb.exec("DELETE FROM pending_ops WHERE status = 'DONE'");
  }
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('pending-ops-changed'));
  }
}
