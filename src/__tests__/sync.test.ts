import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { initDatabase, closeDatabase } from '../db/database.js';
import { AuthService } from '../services/authService.js';
import { ListService } from '../services/listService.js';
import { SyncService } from '../services/syncService.js';

let userIndex = 1;

describe('Offline Synchronization & Idempotency', () => {
  let user: { id: string };

  beforeEach(() => {
    closeDatabase();
    initDatabase(':memory:');

    const mobileNumber = `98765432${(userIndex++).toString().padStart(2, '0')}`;
    user = AuthService.register({
      mobileNumber,
      pin: '123456',
      fullName: 'Santosh Koli'
    }).user;
  });

  afterAll(() => {
    closeDatabase();
  });

  it('processes queued mutations idempotently without duplicate records', async () => {
    const syncResult = await SyncService.processSync(user.id, [
      {
        operationId: 'op-create-list-101',
        entityType: 'list',
        action: 'create',
        payload: {
          title: 'Offline Created List',
          monthYear: '2026-10',
          monthlyBudget: 3500
        }
      }
    ]);

    expect(syncResult.processedOperations).toContain('op-create-list-101');
    expect(syncResult.serverState.length).toBe(1);
    expect(syncResult.serverState[0].title).toBe('Offline Created List');

    // Replay the exact same sync operation (simulating network retry after client timeout)
    const replayResult = await SyncService.processSync(user.id, [
      {
        operationId: 'op-create-list-101',
        entityType: 'list',
        action: 'create',
        payload: {
          title: 'Offline Created List',
          monthYear: '2026-10',
          monthlyBudget: 3500
        }
      }
    ]);

    expect(replayResult.processedOperations).toContain('op-create-list-101');
    // Ensure no duplicate list was created due to idempotency!
    const allLists = ListService.getLists(user.id);
    expect(allLists.length).toBe(1);
  });

  it('resolves client-generated temporary IDs in batch offline creation without LIST_NOT_FOUND error', async () => {
    const localListId = 'local-list-1792951763829';
    const localItemId = 'local-item-1792951763830';

    const syncResult = await SyncService.processSync(user.id, [
      {
        operationId: 'op-batch-list-1',
        entityType: 'list',
        action: 'create',
        payload: {
          id: localListId,
          title: 'Diwali Grocery 2026',
          monthYear: '2026-11',
          monthlyBudget: 8000
        }
      },
      {
        operationId: 'op-batch-item-1',
        entityType: 'item',
        action: 'create',
        payload: {
          id: localItemId,
          listId: localListId,
          name: 'Tandul',
          nameMr: 'तांदूळ',
          quantity: 5,
          unit: 'kg',
          category: 'Grains & Pulses',
          unitPrice: 50
        }
      },
      {
        operationId: 'op-batch-item-update-1',
        entityType: 'item',
        action: 'update',
        payload: {
          id: localItemId,
          isPurchased: true,
          quantity: 6
        }
      }
    ]);

    expect(syncResult.conflicts).toHaveLength(0);
    expect(syncResult.processedOperations).toEqual([
      'op-batch-list-1',
      'op-batch-item-1',
      'op-batch-item-update-1'
    ]);

    // Verify item was created in the list and updated
    const list = syncResult.serverState.find(l => l.month_year === '2026-11');
    expect(list).toBeDefined();
    expect(list!.items).toHaveLength(1);
    expect(list!.items![0].name).toBe('Tandul');
    expect(list!.items![0].name_mr).toBe('तांदूळ');
    expect(list!.items![0].quantity).toBe(6);
    expect(list!.items![0].is_purchased).toBe(1);
  });

  it('safely handles duplicate month list creation by mapping to existing list without throwing DUPLICATE_MONTH', async () => {
    // 1. First sync creates the list
    await SyncService.processSync(user.id, [
      {
        operationId: 'op-list-create-first',
        entityType: 'list',
        action: 'create',
        payload: {
          id: 'local-list-orig',
          title: 'November Shopping',
          monthYear: '2026-11',
          monthlyBudget: 5000
        }
      }
    ]);

    // 2. Second sync attempts to create list for same month with a different operationId (e.g. client re-queue)
    const secondSyncResult = await SyncService.processSync(user.id, [
      {
        operationId: 'op-list-create-duplicate',
        entityType: 'list',
        action: 'create',
        payload: {
          id: 'local-list-new',
          title: 'November Shopping Updated',
          monthYear: '2026-11',
          monthlyBudget: 6000
        }
      },
      {
        operationId: 'op-item-for-mapped-list',
        entityType: 'item',
        action: 'create',
        payload: {
          listId: 'local-list-new',
          name: 'Sakhar',
          nameMr: 'साखर',
          quantity: 2,
          unit: 'kg',
          category: 'Kitchen Essentials',
          unitPrice: 42
        }
      }
    ]);

    expect(secondSyncResult.conflicts).toHaveLength(0);
    expect(secondSyncResult.processedOperations).toContain('op-list-create-duplicate');
    expect(secondSyncResult.processedOperations).toContain('op-item-for-mapped-list');

    // Only 1 list for November exists with the item
    const lists = ListService.getLists(user.id);
    expect(lists.filter(l => l.month_year === '2026-11')).toHaveLength(1);
  });

  it('preserves genuine zero price (0) and distinguishes from null/unspecified price', async () => {
    const list = ListService.createList(user.id, {
      title: 'Price Verification List',
      monthYear: '2026-12',
      monthlyBudget: 1000
    });

    const syncResult = await SyncService.processSync(user.id, [
      {
        operationId: 'op-zero-price-item',
        entityType: 'item',
        action: 'create',
        payload: {
          listId: list.id,
          name: 'Free Sample',
          nameMr: 'मोफत नमुना',
          quantity: 1,
          unit: 'packet',
          category: 'Snacks',
          unitPrice: 0
        }
      },
      {
        operationId: 'op-null-price-item',
        entityType: 'item',
        action: 'create',
        payload: {
          listId: list.id,
          name: 'Unpriced Item',
          nameMr: 'अंदाजे वस्तू',
          quantity: 2,
          unit: 'kg',
          category: 'Kitchen Essentials',
          unitPrice: null
        }
      }
    ]);

    expect(syncResult.conflicts).toHaveLength(0);
    const populated = ListService.getListById(user.id, list.id);
    const zeroItem = populated!.items.find(i => i.name === 'Free Sample');
    const nullItem = populated!.items.find(i => i.name === 'Unpriced Item');

    expect(zeroItem?.unit_price).toBe(0);
    expect(zeroItem?.estimated_total).toBe(0);
    expect(nullItem?.unit_price).toBeNull();
    expect(nullItem?.estimated_total).toBeNull();
  });

  it('handles item deletion with local temporary ID mapping gracefully', async () => {
    const localListId = 'local-list-del-1';
    const localItemId = 'local-item-del-1';

    // Create list and item
    await SyncService.processSync(user.id, [
      {
        operationId: 'op-create-l',
        entityType: 'list',
        action: 'create',
        payload: { id: localListId, title: 'Delete Test', monthYear: '2027-01' }
      },
      {
        operationId: 'op-create-i',
        entityType: 'item',
        action: 'create',
        payload: { id: localItemId, listId: localListId, name: 'To Delete', quantity: 1, unit: 'kg', category: 'General' }
      }
    ]);

    // Delete item using local temporary ID
    const deleteSync = await SyncService.processSync(user.id, [
      {
        operationId: 'op-del-i',
        entityType: 'item',
        action: 'delete',
        payload: { id: localItemId }
      }
    ]);

    expect(deleteSync.conflicts).toHaveLength(0);
    const serverList = deleteSync.serverState.find(l => l.month_year === '2027-01');
    expect(serverList!.items).toHaveLength(0);
  });
});
