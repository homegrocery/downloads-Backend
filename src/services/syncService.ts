import { getDatabase } from '../db/database.js';
import { ListService } from './listService.js';
import type { PopulatedShoppingList } from './listService.js';

export interface ClientSyncMutation {
  operationId: string;
  entityType: 'list' | 'item';
  action: 'create' | 'update' | 'delete';
  payload: any;
  clientTimestamp?: string;
}

export interface SyncResult {
  processedOperations: string[];
  conflicts: Array<{ operationId: string; reason: string; serverEntity?: any }>;
  serverState: PopulatedShoppingList[];
  serverTimestamp: string;
}

export class SyncService {
  static processSync(userId: string, mutations: ClientSyncMutation[] = []): SyncResult {
    const db = getDatabase();
    const processedOperations: string[] = [];
    const conflicts: Array<{ operationId: string; reason: string; serverEntity?: any }> = [];
    const serverTimestamp = new Date().toISOString();

    for (const mutation of mutations) {
      if (!mutation.operationId) continue;

      // Idempotency check: has this operation already been processed?
      const alreadyProcessed = db.prepare(`
        SELECT operation_id FROM sync_operations WHERE user_id = ? AND operation_id = ?
      `).get(userId, mutation.operationId);

      if (alreadyProcessed) {
        processedOperations.push(mutation.operationId);
        continue;
      }

      try {
        if (mutation.entityType === 'list') {
          if (mutation.action === 'create') {
            ListService.createList(userId, mutation.payload);
          } else if (mutation.action === 'update') {
            ListService.updateList(userId, mutation.payload.id, mutation.payload);
          } else if (mutation.action === 'delete') {
            ListService.deleteList(userId, mutation.payload.id);
          }
        } else if (mutation.entityType === 'item') {
          if (mutation.action === 'create') {
            ListService.addItem(userId, mutation.payload.listId, {
              ...mutation.payload,
              allowDuplicate: true
            });
          } else if (mutation.action === 'update') {
            ListService.updateItem(userId, mutation.payload.id, mutation.payload);
          } else if (mutation.action === 'delete') {
            ListService.deleteItem(userId, mutation.payload.id);
          }
        }

        // Record successful operation
        db.prepare(`
          INSERT INTO sync_operations (
            operation_id, user_id, entity_type, entity_id, action, client_timestamp, server_timestamp
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(
          mutation.operationId,
          userId,
          mutation.entityType,
          mutation.payload?.id || 'unknown',
          mutation.action,
          mutation.clientTimestamp || null,
          serverTimestamp
        );

        processedOperations.push(mutation.operationId);
      } catch (err: any) {
        conflicts.push({
          operationId: mutation.operationId,
          reason: err.message || 'Operation failed'
        });
      }
    }

    // Return the fresh server state for the user
    const lists = ListService.getLists(userId);
    const serverState: PopulatedShoppingList[] = lists.map(l => ListService.getListById(userId, l.id)!);

    return {
      processedOperations,
      conflicts,
      serverState,
      serverTimestamp
    };
  }
}
