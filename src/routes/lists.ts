import { Router } from 'express';
import { ListService } from '../services/listService.js';
import { SecurityService } from '../services/securityService.js';
import { requireAuth, type AuthenticatedRequest } from '../middleware/auth.js';
import { getDatabase } from '../db/database.js';

export const listsRouter = Router();

// All list routes require authentication
listsRouter.use(requireAuth);

listsRouter.get('/', (req: AuthenticatedRequest, res) => {
  const lists = ListService.getLists(req.user!.id);
  res.json({
    success: true,
    data: lists
  });
});

listsRouter.post('/', (req: AuthenticatedRequest, res, next) => {
  try {
    SecurityService.validatePayloadSecurity({
      payload: req.body,
      requestingUserId: req.user!.id,
      requestingRole: req.user!.role,
      ipAddress: req.ip,
      endpoint: req.originalUrl || req.baseUrl
    });
    const { title, monthYear, monthlyBudget, notes } = req.body;
    const list = ListService.createList(req.user!.id, {
      title,
      monthYear,
      monthlyBudget,
      notes
    });

    res.status(201).json({
      success: true,
      message: 'Grocery list created',
      messageMr: 'किराणा यादी तयार केली',
      data: list
    });
  } catch (err) {
    next(err);
  }
});

listsRouter.get('/:id', (req: AuthenticatedRequest, res) => {
  const list = ListService.getListById(req.user!.id, req.params.id);
  if (!list) {
    res.status(404).json({
      success: false,
      error: 'List not found',
      errorMr: 'यादी सापडली नाही'
    });
    return;
  }
  res.json({
    success: true,
    data: list
  });
});

listsRouter.put('/:id', (req: AuthenticatedRequest, res, next) => {
  try {
    SecurityService.validatePayloadSecurity({
      payload: req.body,
      requestingUserId: req.user!.id,
      requestingRole: req.user!.role,
      ipAddress: req.ip,
      endpoint: req.originalUrl || req.baseUrl
    });
    const updated = ListService.updateList(req.user!.id, req.params.id, req.body);
    res.json({
      success: true,
      message: 'Grocery list updated',
      messageMr: 'किराणा यादी अद्ययावत केली',
      data: updated
    });
  } catch (err) {
    next(err);
  }
});

listsRouter.delete('/:id', (req: AuthenticatedRequest, res) => {
  const deleted = ListService.deleteList(req.user!.id, req.params.id);
  if (!deleted) {
    const db = getDatabase();
    const otherList = db.prepare('SELECT user_id FROM shopping_lists WHERE id = ?').get(req.params.id) as { user_id: string } | undefined;
    if (otherList && otherList.user_id !== req.user!.id) {
      res.status(403).json({
        success: false,
        error: 'UNAUTHORIZED_ACTION: You do not have permission to delete this list.',
        code: 'UNAUTHORIZED_ACTION',
        errorMr: 'अनधिकृत कृती. आपल्याला या नोंदीमध्ये प्रवेश करण्याची परवानगी नाही.'
      });
      return;
    }
    res.status(404).json({
      success: false,
      error: 'List not found or unauthorized',
      errorMr: 'यादी सापडली नाही किंवा परवानगी नाही'
    });
    return;
  }
  res.json({
    success: true,
    message: 'Grocery list deleted',
    messageMr: 'किराणा यादी हटवली'
  });
});

listsRouter.post('/:id/copy', (req: AuthenticatedRequest, res, next) => {
  try {
    SecurityService.validatePayloadSecurity({
      payload: req.body,
      requestingUserId: req.user!.id,
      requestingRole: req.user!.role,
      ipAddress: req.ip,
      endpoint: req.originalUrl || req.baseUrl
    });
    const { targetMonthYear, newTitle } = req.body;
    const copied = ListService.copyListToMonth(req.user!.id, req.params.id, targetMonthYear, newTitle);
    res.status(201).json({
      success: true,
      message: 'Grocery list copied successfully',
      messageMr: 'किराणा यादी नवीन महिन्यासाठी यशस्वीरित्या कॉपी झाली',
      data: copied
    });
  } catch (err) {
    next(err);
  }
});

// Items sub-routes under a list
listsRouter.post('/:id/items', (req: AuthenticatedRequest, res, next) => {
  try {
    SecurityService.validatePayloadSecurity({
      payload: req.body,
      requestingUserId: req.user!.id,
      requestingRole: req.user!.role,
      ipAddress: req.ip,
      endpoint: req.originalUrl || req.baseUrl
    });
    const { name, nameMr, quantity, unit, category, unitPrice, notes, allowDuplicate } = req.body;
    const item = ListService.addItem(req.user!.id, req.params.id, {
      name,
      nameMr,
      quantity,
      unit,
      category,
      unitPrice,
      notes,
      allowDuplicate
    });

    res.status(201).json({
      success: true,
      message: 'Item added',
      messageMr: 'वस्तू जोडली',
      data: item
    });
  } catch (err) {
    next(err);
  }
});
