import { getDatabase } from '../db/database.js';
import { ListService } from './listService.js';
import { awaitPendingPostgresWrites } from '../db/postgresSync.js';
import type { PopulatedShoppingList } from './listService.js';
import type { ShoppingList } from '../types/index.js';

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
  static async processSync(userId: string, mutations: ClientSyncMutation[] = []): Promise<SyncResult> {
    const db = getDatabase();
    const processedOperations: string[] = [];
    const conflicts: Array<{ operationId: string; reason: string; serverEntity?: any }> = [];
    const serverTimestamp = new Date().toISOString();

    // In-batch ID mapping (e.g., local-list-xxx -> real server list UUID)
    const idMap = new Map<string, string>();

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
            const rawId = mutation.payload?.id;
            const monthYear = mutation.payload?.monthYear;

            // Safe idempotency: check if list for this month already exists
            const existing = monthYear
              ? (db.prepare(`
                  SELECT * FROM shopping_lists WHERE user_id = ? AND month_year = ?
                `).get(userId, monthYear) as ShoppingList | undefined)
              : undefined;

            if (existing) {
              if (rawId) idMap.set(rawId, existing.id);
              // Update title/budget if provided
              if (mutation.payload?.title || mutation.payload?.monthlyBudget !== undefined) {
                ListService.updateList(userId, existing.id, {
                  title: mutation.payload.title,
                  monthlyBudget: mutation.payload.monthlyBudget,
                  notes: mutation.payload.notes
                });
              }
            } else {
              const created = ListService.createList(userId, mutation.payload);
              if (rawId) idMap.set(rawId, created.id);
            }
          } else if (mutation.action === 'update') {
            const rawId = mutation.payload?.id;
            const targetListId = idMap.get(rawId) || rawId;
            ListService.updateList(userId, targetListId, mutation.payload);
          } else if (mutation.action === 'delete') {
            const rawId = mutation.payload?.id;
            const targetListId = idMap.get(rawId) || rawId;
            ListService.deleteList(userId, targetListId);
          }
        } else if (mutation.entityType === 'item') {
          if (mutation.action === 'create') {
            const rawListId = mutation.payload?.listId;
            const resolvedListId = idMap.get(rawListId) || rawListId;

            // Verify list exists for user; if not found and was local, fallback to most recent user list
            let targetList = db.prepare(`
              SELECT id FROM shopping_lists WHERE id = ? AND user_id = ?
            `).get(resolvedListId, userId) as { id: string } | undefined;

            if (!targetList && typeof rawListId === 'string' && rawListId.startsWith('local-list-')) {
              const fallback = db.prepare(`
                SELECT id FROM shopping_lists WHERE user_id = ? ORDER BY month_year DESC, created_at DESC LIMIT 1
              `).get(userId) as { id: string } | undefined;
              if (fallback) {
                targetList = fallback;
                idMap.set(rawListId, fallback.id);
              }
            }

            if (!targetList) {
              throw new Error('LIST_NOT_FOUND: Shopping list not found or unauthorized');
            }

            const rawItemId = mutation.payload?.id;
            const itemName = (mutation.payload?.name || '').trim();

            // Safe duplicate check: if item with same name or ID already exists in this list, reuse/update
            const existingItem = db.prepare(`
              SELECT id, name FROM shopping_items
              WHERE list_id = ? AND user_id = ? AND (
                (id = ? AND id != '') OR LOWER(TRIM(name)) = LOWER(TRIM(?))
              )
            `).get(targetList.id, userId, rawItemId || '', itemName) as { id: string } | undefined;

            if (existingItem) {
              if (rawItemId) idMap.set(rawItemId, existingItem.id);
              ListService.updateItem(userId, existingItem.id, mutation.payload);
            } else {
              const added = ListService.addItem(userId, targetList.id, {
                ...mutation.payload,
                allowDuplicate: true
              });
              if (rawItemId) idMap.set(rawItemId, added.id);
            }
          } else if (mutation.action === 'update') {
            const rawItemId = mutation.payload?.id;
            let targetItemId = idMap.get(rawItemId) || rawItemId;

            let existingItem = db.prepare(`
              SELECT id, list_id FROM shopping_items WHERE id = ? AND user_id = ?
            `).get(targetItemId, userId) as { id: string } | undefined;

            if (!existingItem && mutation.payload?.name) {
              const match = db.prepare(`
                SELECT id FROM shopping_items WHERE user_id = ? AND LOWER(TRIM(name)) = LOWER(TRIM(?))
              `).get(userId, mutation.payload.name.trim()) as { id: string } | undefined;
              if (match) {
                targetItemId = match.id;
                existingItem = match;
                if (rawItemId) idMap.set(rawItemId, match.id);
              }
            }

            if (existingItem) {
              ListService.updateItem(userId, targetItemId, mutation.payload);
            } else {
              throw new Error('ITEM_NOT_FOUND: Grocery item not found or unauthorized');
            }
          } else if (mutation.action === 'delete') {
            const rawItemId = mutation.payload?.id;
            let targetItemId = idMap.get(rawItemId) || rawItemId;
            ListService.deleteItem(userId, targetItemId);
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

    // Await all queued PostgreSQL write operations before querying fresh server state and responding
    try {
      await awaitPendingPostgresWrites(5000);
    } catch (pgErr: any) {
      console.warn('[SyncService] Notice during PostgreSQL write confirmation:', pgErr?.message);
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
