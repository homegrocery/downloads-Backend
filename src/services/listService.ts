import { getDatabase } from '../db/database.js';
import { generateId } from '../utils/crypto.js';
import { calculateLineTotal, calculateListTotals } from '../utils/calculator.js';
import { validateMonthYear } from '../utils/validation.js';
import type { ShoppingList, ShoppingItem } from '../types/index.js';

export interface PopulatedShoppingList extends ShoppingList {
  items: ShoppingItem[];
  totals: ReturnType<typeof calculateListTotals>;
}

export class ListService {
  static getLists(userId: string): ShoppingList[] {
    const db = getDatabase();
    return db.prepare(`
      SELECT * FROM shopping_lists
      WHERE user_id = ?
      ORDER BY month_year DESC, created_at DESC
    `).all(userId) as ShoppingList[];
  }

  static getListById(userId: string, listId: string): PopulatedShoppingList | null {
    const db = getDatabase();
    const list = db.prepare(`
      SELECT * FROM shopping_lists
      WHERE id = ? AND user_id = ?
    `).get(listId, userId) as ShoppingList | undefined;

    if (!list) return null;

    const items = db.prepare(`
      SELECT * FROM shopping_items
      WHERE list_id = ? AND user_id = ?
      ORDER BY display_order ASC, created_at ASC
    `).all(listId, userId) as ShoppingItem[];

    const totals = calculateListTotals(
      items.map(i => ({ quantity: i.quantity, unitPrice: i.unit_price, isPurchased: i.is_purchased })),
      list.monthly_budget
    );

    return {
      ...list,
      items,
      totals
    };
  }

  static createList(userId: string, data: {
    title: string;
    monthYear: string;
    monthlyBudget?: number;
    notes?: string;
  }): ShoppingList {
    if (!data.title || !data.title.trim()) {
      throw new Error('INVALID_TITLE: List title is required');
    }

    if (!validateMonthYear(data.monthYear)) {
      throw new Error('INVALID_MONTH_YEAR: Month and year must be in YYYY-MM format (e.g. 2026-10)');
    }

    const db = getDatabase();

    // Check for existing list in the same month for this user
    const existing = db.prepare(`
      SELECT id, title FROM shopping_lists
      WHERE user_id = ? AND month_year = ?
    `).get(userId, data.monthYear) as { id: string; title: string } | undefined;

    if (existing) {
      throw new Error(`DUPLICATE_MONTH: A grocery list for this month already exists ("${existing.title}")`);
    }

    const id = generateId();
    const now = new Date().toISOString();
    const budget = Math.max(0, Number(data.monthlyBudget) || 0);

    db.prepare(`
      INSERT INTO shopping_lists (
        id, user_id, title, month_year, monthly_budget, notes, is_archived, version, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 0, 1, ?, ?)
    `).run(id, userId, data.title.trim(), data.monthYear, budget, data.notes || null, now, now);

    return {
      id,
      user_id: userId,
      title: data.title.trim(),
      month_year: data.monthYear,
      monthly_budget: budget,
      notes: data.notes || null,
      is_archived: 0,
      version: 1,
      created_at: now,
      updated_at: now
    };
  }

  static updateList(userId: string, listId: string, data: {
    title?: string;
    monthlyBudget?: number;
    notes?: string;
    isArchived?: number;
  }): ShoppingList {
    const db = getDatabase();
    const list = db.prepare('SELECT * FROM shopping_lists WHERE id = ? AND user_id = ?').get(listId, userId) as ShoppingList | undefined;

    if (!list) {
      throw new Error('LIST_NOT_FOUND: Grocery list not found or unauthorized');
    }

    const title = data.title !== undefined ? data.title.trim() : list.title;
    const budget = data.monthlyBudget !== undefined ? Math.max(0, Number(data.monthlyBudget)) : list.monthly_budget;
    const notes = data.notes !== undefined ? data.notes : list.notes;
    const isArchived = data.isArchived !== undefined ? (data.isArchived ? 1 : 0) : list.is_archived;
    const now = new Date().toISOString();
    const newVersion = list.version + 1;

    db.prepare(`
      UPDATE shopping_lists
      SET title = ?, monthly_budget = ?, notes = ?, is_archived = ?, version = ?, updated_at = ?
      WHERE id = ? AND user_id = ?
    `).run(title, budget, notes, isArchived, newVersion, now, listId, userId);

    return {
      ...list,
      title,
      monthly_budget: budget,
      notes,
      is_archived: isArchived,
      version: newVersion,
      updated_at: now
    };
  }

  static deleteList(userId: string, listId: string): boolean {
    const db = getDatabase();
    const result = db.prepare('DELETE FROM shopping_lists WHERE id = ? AND user_id = ?').run(listId, userId);
    return result.changes > 0;
  }

  static copyListToMonth(userId: string, sourceListId: string, targetMonthYear: string, newTitle?: string): PopulatedShoppingList {
    if (!validateMonthYear(targetMonthYear)) {
      throw new Error('INVALID_MONTH_YEAR: Target month must be in YYYY-MM format');
    }

    const db = getDatabase();

    // Check duplicate target month
    const existing = db.prepare(`
      SELECT id, title FROM shopping_lists
      WHERE user_id = ? AND month_year = ?
    `).get(userId, targetMonthYear) as { id: string; title: string } | undefined;

    if (existing) {
      throw new Error(`DUPLICATE_MONTH: A grocery list for ${targetMonthYear} already exists ("${existing.title}")`);
    }

    const source = this.getListById(userId, sourceListId);
    if (!source) {
      throw new Error('SOURCE_LIST_NOT_FOUND: Source list does not exist');
    }

    const newListId = generateId();
    const now = new Date().toISOString();
    const title = (newTitle && newTitle.trim()) || `${source.title} (${targetMonthYear})`;

    return db.transaction(() => {
      // Insert new list
      db.prepare(`
        INSERT INTO shopping_lists (
          id, user_id, title, month_year, monthly_budget, notes, is_archived, version, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 0, 1, ?, ?)
      `).run(newListId, userId, title, targetMonthYear, source.monthly_budget, source.notes, now, now);

      // Copy all items with purchased status RESET to 0
      const insertItem = db.prepare(`
        INSERT INTO shopping_items (
          id, list_id, user_id, name, name_mr, quantity, unit, category,
          unit_price, estimated_total, is_purchased, display_order, notes, version, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, 1, ?, ?)
      `);

      for (const item of source.items) {
        const newItemId = generateId();
        const estTotal = calculateLineTotal(item.quantity, item.unit_price);
        insertItem.run(
          newItemId,
          newListId,
          userId,
          item.name,
          item.name_mr || null,
          item.quantity,
          item.unit,
          item.category,
          item.unit_price,
          estTotal,
          item.display_order,
          item.notes || null,
          now,
          now
        );
      }

      return this.getListById(userId, newListId)!;
    })();
  }

  static addItem(userId: string, listId: string, data: {
    name: string;
    nameMr?: string;
    quantity: number;
    unit: string;
    category: string;
    unitPrice?: number;
    notes?: string;
    allowDuplicate?: boolean;
  }): ShoppingItem {
    const db = getDatabase();

    // Verify list ownership
    const list = db.prepare('SELECT id FROM shopping_lists WHERE id = ? AND user_id = ?').get(listId, userId);
    if (!list) {
      throw new Error('LIST_NOT_FOUND: Shopping list not found or unauthorized');
    }

    const name = (data.name || '').trim();
    if (!name) {
      throw new Error('INVALID_ITEM_NAME: Item name is required');
    }

    // Check duplicate item name in the same list
    if (!data.allowDuplicate) {
      const duplicate = db.prepare(`
        SELECT id, name FROM shopping_items
        WHERE list_id = ? AND user_id = ? AND LOWER(TRIM(name)) = LOWER(TRIM(?))
      `).get(listId, userId, name) as { id: string; name: string } | undefined;

      if (duplicate) {
        throw new Error(`DUPLICATE_ITEM: "${name}" is already in this grocery list. You can edit the existing item or confirm to add duplicate.`);
      }
    }

    const qty = Math.max(0.01, Number(data.quantity) || 1);
    const unit = (data.unit || 'kg').trim();
    const category = (data.category || 'Kitchen Essentials').trim();
    const price = Math.max(0, Number(data.unitPrice) || 0);
    const estimatedTotal = calculateLineTotal(qty, price);
    const now = new Date().toISOString();
    const itemId = generateId();

    // Get next display order
    const maxOrder = db.prepare(`
      SELECT MAX(display_order) as max_order FROM shopping_items WHERE list_id = ?
    `).get(listId) as { max_order: number | null };
    const nextOrder = (maxOrder?.max_order ?? -1) + 1;

    db.transaction(() => {
      db.prepare(`
        INSERT INTO shopping_items (
          id, list_id, user_id, name, name_mr, quantity, unit, category,
          unit_price, estimated_total, is_purchased, display_order, notes, version, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, 1, ?, ?)
      `).run(
        itemId,
        listId,
        userId,
        name,
        data.nameMr ? data.nameMr.trim() : null,
        qty,
        unit,
        category,
        price,
        estimatedTotal,
        nextOrder,
        data.notes || null,
        now,
        now
      );

      // Increment list version
      db.prepare('UPDATE shopping_lists SET version = version + 1, updated_at = ? WHERE id = ?').run(now, listId);
    })();

    return {
      id: itemId,
      list_id: listId,
      user_id: userId,
      name,
      name_mr: data.nameMr ? data.nameMr.trim() : null,
      quantity: qty,
      unit,
      category,
      unit_price: price,
      estimated_total: estimatedTotal,
      is_purchased: 0,
      display_order: nextOrder,
      notes: data.notes || null,
      version: 1,
      created_at: now,
      updated_at: now
    };
  }

  static updateItem(userId: string, itemId: string, data: {
    name?: string;
    nameMr?: string;
    quantity?: number;
    unit?: string;
    category?: string;
    unitPrice?: number;
    isPurchased?: boolean | number;
    displayOrder?: number;
    notes?: string;
  }): ShoppingItem {
    const db = getDatabase();
    const item = db.prepare('SELECT * FROM shopping_items WHERE id = ? AND user_id = ?').get(itemId, userId) as ShoppingItem | undefined;

    if (!item) {
      throw new Error('ITEM_NOT_FOUND: Grocery item not found or unauthorized');
    }

    const name = data.name !== undefined ? data.name.trim() : item.name;
    const nameMr = data.nameMr !== undefined ? (data.nameMr ? data.nameMr.trim() : null) : item.name_mr;
    const qty = data.quantity !== undefined ? Math.max(0.01, Number(data.quantity)) : item.quantity;
    const unit = data.unit !== undefined ? data.unit.trim() : item.unit;
    const category = data.category !== undefined ? data.category.trim() : item.category;
    const price = data.unitPrice !== undefined ? Math.max(0, Number(data.unitPrice)) : item.unit_price;
    const estimatedTotal = calculateLineTotal(qty, price);
    const isPurchased = data.isPurchased !== undefined ? (data.isPurchased ? 1 : 0) : item.is_purchased;
    const displayOrder = data.displayOrder !== undefined ? Number(data.displayOrder) : item.display_order;
    const notes = data.notes !== undefined ? data.notes : item.notes;
    const now = new Date().toISOString();
    const newVersion = item.version + 1;

    db.transaction(() => {
      db.prepare(`
        UPDATE shopping_items
        SET name = ?, name_mr = ?, quantity = ?, unit = ?, category = ?,
            unit_price = ?, estimated_total = ?, is_purchased = ?, display_order = ?,
            notes = ?, version = ?, updated_at = ?
        WHERE id = ? AND user_id = ?
      `).run(name, nameMr, qty, unit, category, price, estimatedTotal, isPurchased, displayOrder, notes, newVersion, now, itemId, userId);

      // Increment list version
      db.prepare('UPDATE shopping_lists SET version = version + 1, updated_at = ? WHERE id = ?').run(now, item.list_id);
    })();

    return {
      ...item,
      name,
      name_mr: nameMr,
      quantity: qty,
      unit,
      category,
      unit_price: price,
      estimated_total: estimatedTotal,
      is_purchased: isPurchased,
      display_order: displayOrder,
      notes,
      version: newVersion,
      updated_at: now
    };
  }

  static deleteItem(userId: string, itemId: string): boolean {
    const db = getDatabase();
    const item = db.prepare('SELECT list_id FROM shopping_items WHERE id = ? AND user_id = ?').get(itemId, userId) as { list_id: string } | undefined;
    if (!item) return false;

    const now = new Date().toISOString();
    const result = db.transaction(() => {
      const res = db.prepare('DELETE FROM shopping_items WHERE id = ? AND user_id = ?').run(itemId, userId);
      db.prepare('UPDATE shopping_lists SET version = version + 1, updated_at = ? WHERE id = ?').run(now, item.list_id);
      return res.changes > 0;
    })();

    return result;
  }
}
