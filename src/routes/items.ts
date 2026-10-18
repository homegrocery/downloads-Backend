import { Router } from 'express';
import { ListService } from '../services/listService.js';
import { requireAuth, type AuthenticatedRequest } from '../middleware/auth.js';

export const itemsRouter = Router();

itemsRouter.use(requireAuth);

itemsRouter.put('/:id', (req: AuthenticatedRequest, res, next) => {
  try {
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
