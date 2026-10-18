import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { AuthService } from '../services/authService.js';
import { ListService } from '../services/listService.js';
import { initDatabase, closeDatabase } from '../db/database.js';

describe('Grocery Lists & Items Management', () => {
  let userA: { id: string };
  let userB: { id: string };

  beforeEach(() => {
    initDatabase(':memory:');

    userA = AuthService.register({
      mobileNumber: '9876543210',
      pin: '123456',
      fullName: 'Santosh Koli'
    }).user;

    userB = AuthService.register({
      mobileNumber: '9123456789',
      pin: '654321',
      fullName: 'Other User'
    }).user;
  });

  afterAll(() => {
    closeDatabase();
  });

  it('creates a monthly grocery list and detects duplicate months', () => {
    const list = ListService.createList(userA.id, {
      title: 'October 2026 Grocery / ऑक्टोबर किराणा',
      monthYear: '2026-10',
      monthlyBudget: 5000,
      notes: 'Monthly staples'
    });

    expect(list.id).toBeDefined();
    expect(list.month_year).toBe('2026-10');
    expect(list.monthly_budget).toBe(5000);

    // Duplicate month creation should throw error
    expect(() => {
      ListService.createList(userA.id, {
        title: 'Second list for same month',
        monthYear: '2026-10'
      });
    }).toThrow('DUPLICATE_MONTH');

    // But userB should be able to create their own list for the same month
    const listB = ListService.createList(userB.id, {
      title: 'User B October',
      monthYear: '2026-10'
    });
    expect(listB.id).toBeDefined();
  });

  it('adds items, computes line totals and warns on duplicate items', () => {
    const list = ListService.createList(userA.id, {
      title: 'Grocery List',
      monthYear: '2026-10',
      monthlyBudget: 2000
    });

    const item1 = ListService.addItem(userA.id, list.id, {
      name: 'Basmati Rice',
      nameMr: 'बासमती तांदूळ',
      quantity: 5,
      unit: 'kg',
      category: 'Grains and Pulses',
      unitPrice: 120
    });

    expect(item1.estimated_total).toBe(600); // 5 * 120 = 600

    // Prevent accidental duplicate item name in the same list
    expect(() => {
      ListService.addItem(userA.id, list.id, {
        name: 'basmati rice', // case-insensitive check
        quantity: 2,
        unit: 'kg',
        category: 'Grains and Pulses',
        unitPrice: 120
      });
    }).toThrow('DUPLICATE_ITEM');

    // When explicitly allowed, adding duplicate succeeds
    const itemDuplicate = ListService.addItem(userA.id, list.id, {
      name: 'Basmati Rice',
      quantity: 2,
      unit: 'kg',
      category: 'Grains and Pulses',
      unitPrice: 120,
      allowDuplicate: true
    });
    expect(itemDuplicate.id).toBeDefined();
  });

  it('calculates budget alerts accurately at 80% warning and 100% exceeded', () => {
    const list = ListService.createList(userA.id, {
      title: 'Budget Test',
      monthYear: '2026-10',
      monthlyBudget: 1000
    });

    // Add item: 700 total (70% - normal)
    ListService.addItem(userA.id, list.id, {
      name: 'Item 1',
      quantity: 7,
      unit: 'kg',
      category: 'Kitchen Essentials',
      unitPrice: 100
    });

    let populated = ListService.getListById(userA.id, list.id)!;
    expect(populated.totals.estimatedTotal).toBe(700);
    expect(populated.totals.isBudgetWarning).toBe(false);
    expect(populated.totals.isBudgetExceeded).toBe(false);

    // Add item: 150 total (total now 850 = 85% -> Warning!)
    ListService.addItem(userA.id, list.id, {
      name: 'Item 2',
      quantity: 1.5,
      unit: 'kg',
      category: 'Spices',
      unitPrice: 100
    });

    populated = ListService.getListById(userA.id, list.id)!;
    expect(populated.totals.estimatedTotal).toBe(850);
    expect(populated.totals.isBudgetWarning).toBe(true);
    expect(populated.totals.isBudgetExceeded).toBe(false);

    // Add item: 200 total (total now 1050 = 105% -> Exceeded!)
    ListService.addItem(userA.id, list.id, {
      name: 'Item 3',
      quantity: 2,
      unit: 'kg',
      category: 'Cleaning Supplies',
      unitPrice: 100
    });

    populated = ListService.getListById(userA.id, list.id)!;
    expect(populated.totals.estimatedTotal).toBe(1050);
    expect(populated.totals.isBudgetWarning).toBe(false);
    expect(populated.totals.isBudgetExceeded).toBe(true);
    expect(populated.totals.remainingBudget).toBe(-50);
  });

  it('copies previous month list with purchased status reset to 0', () => {
    const octList = ListService.createList(userA.id, {
      title: 'October 2026',
      monthYear: '2026-10',
      monthlyBudget: 4000
    });

    const item1 = ListService.addItem(userA.id, octList.id, {
      name: 'Sunflower Oil',
      nameMr: 'सूर्यफूल तेल',
      quantity: 2,
      unit: 'litre',
      category: 'Kitchen Essentials',
      unitPrice: 150
    });

    // Mark as purchased in October
    ListService.updateItem(userA.id, item1.id, { isPurchased: true });

    // Copy to November
    const novList = ListService.copyListToMonth(userA.id, octList.id, '2026-11', 'November 2026');

    expect(novList.month_year).toBe('2026-11');
    expect(novList.monthly_budget).toBe(4000);
    expect(novList.items.length).toBe(1);
    expect(novList.items[0].name).toBe('Sunflower Oil');
    expect(novList.items[0].name_mr).toBe('सूर्यफूल तेल');
    expect(novList.items[0].quantity).toBe(2);
    expect(novList.items[0].unit_price).toBe(150);
    // Crucial requirement: purchased status MUST be reset to 0 in copied list!
    expect(novList.items[0].is_purchased).toBe(0);
  });

  it('strictly enforces ownership checks across users', () => {
    const listA = ListService.createList(userA.id, {
      title: 'User A Private List',
      monthYear: '2026-10'
    });

    const itemA = ListService.addItem(userA.id, listA.id, {
      name: 'Private Item',
      quantity: 1,
      unit: 'kg',
      category: 'Kitchen Essentials'
    });

    // User B attempts to access User A's list -> returns null
    expect(ListService.getListById(userB.id, listA.id)).toBeNull();

    // User B attempts to update User A's list -> throws error
    expect(() => {
      ListService.updateList(userB.id, listA.id, { title: 'Hacked Title' });
    }).toThrow('LIST_NOT_FOUND');

    // User B attempts to add item to User A's list -> throws error
    expect(() => {
      ListService.addItem(userB.id, listA.id, {
        name: 'Malicious Item',
        quantity: 1,
        unit: 'kg',
        category: 'Kitchen Essentials'
      });
    }).toThrow('LIST_NOT_FOUND');

    // User B attempts to delete User A's item -> fails
    expect(ListService.deleteItem(userB.id, itemA.id)).toBe(false);
  });
});
