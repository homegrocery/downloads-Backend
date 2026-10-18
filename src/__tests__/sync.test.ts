import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { initDatabase, closeDatabase } from '../db/database.js';
import { AuthService } from '../services/authService.js';
import { ListService } from '../services/listService.js';
import { SyncService } from '../services/syncService.js';

describe('Offline Synchronization & Idempotency', () => {
  let user: { id: string };

  beforeEach(() => {
    initDatabase(':memory:');

    user = AuthService.register({
      mobileNumber: '9876543210',
      pin: '123456',
      fullName: 'Santosh Koli'
    }).user;
  });

  afterAll(() => {
    closeDatabase();
  });

  it('processes queued mutations idempotently without duplicate records', () => {
    const syncResult = SyncService.processSync(user.id, [
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
    const replayResult = SyncService.processSync(user.id, [
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
});
