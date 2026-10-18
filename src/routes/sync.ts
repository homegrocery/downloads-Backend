import { Router } from 'express';
import { SyncService } from '../services/syncService.js';
import { requireAuth, type AuthenticatedRequest } from '../middleware/auth.js';

export const syncRouter = Router();

syncRouter.use(requireAuth);

syncRouter.post('/', (req: AuthenticatedRequest, res, next) => {
  try {
    const { mutations } = req.body;
    const result = SyncService.processSync(req.user!.id, mutations || []);

    res.json({
      success: true,
      message: 'Sync completed',
      messageMr: 'सिंक्रोनाइझेशन पूर्ण झाले',
      data: result
    });
  } catch (err) {
    next(err);
  }
});
