import { Router } from 'express';
import { ListService } from '../services/listService.js';
import { SecurityService } from '../services/securityService.js';
import { requireAuth, type AuthenticatedRequest } from '../middleware/auth.js';
import { getDatabase } from '../db/database.js';

export const itemsRouter = Router();

itemsRouter.use(requireAuth);

itemsRouter.put('/:id', (req: AuthenticatedRequest, res, next) => {
  try {
    SecurityService.validatePayloadSecurity({
      payload: req.body,
      requestingUserId: req.user!.id,
      requestingRole: req.user!.role,
      ipAddress: req.ip,
      endpoint: req.originalUrl || req.baseUrl
    });
    const updated = ListService.updateItem(req.user!.id, req.params.id, req.body);
    res.json({
      success: true,
      message: 'Item updated',
      messageMr: 'वस्तू अद्ययावत केली',
      data: updated
    });
  } catch (err) {
    next(err);
  }
});

itemsRouter.delete('/:id', (req: AuthenticatedRequest, res) => {
  const deleted = ListService.deleteItem(req.user!.id, req.params.id);
  if (!deleted) {
    const db = getDatabase();
    const otherItem = db.prepare('SELECT user_id FROM shopping_items WHERE id = ?').get(req.params.id) as { user_id: string } | undefined;
    if (otherItem && otherItem.user_id !== req.user!.id) {
      res.status(403).json({
        success: false,
        error: 'UNAUTHORIZED_ACTION: You do not have permission to delete this item.',
        code: 'UNAUTHORIZED_ACTION',
        errorMr: 'अनधिकृत कृती. आपल्याला या नोंदीमध्ये प्रवेश करण्याची परवानगी नाही.'
      });
      return;
    }
    res.status(404).json({
      success: false,
      error: 'Item not found or unauthorized',
      errorMr: 'वस्तू सापडली नाही किंवा परवानगी नाही'
    });
    return;
  }
  res.json({
    success: true,
    message: 'Item deleted',
    messageMr: 'वस्तू हटवली'
  });
});
