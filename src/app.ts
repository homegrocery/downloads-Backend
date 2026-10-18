import express from 'express';
import cors from 'cors';
import { healthRouter } from './routes/health.js';
import { authRouter } from './routes/auth.js';
import { listsRouter } from './routes/lists.js';
import { itemsRouter } from './routes/items.js';
import { syncRouter } from './routes/sync.js';
import { categoriesRouter } from './routes/categories.js';
import { updatesRouter } from './routes/updates.js';
import { adminRouter } from './routes/admin.js';
import { recoveryRequestsRouter } from './routes/recoveryRequests.js';
import { errorHandler } from './middleware/errorHandler.js';

export function createApp() {
  const app = express();

  // CORS configuration
  app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'X-Client-Version', 'X-Recovery-Request-Id', 'X-Recovery-Token']
  }));

  // Body parser
  app.use(express.json({ limit: '5mb' }));

  // Request logger
  app.use((req, res, next) => {
    console.log(`[HTTP] ${req.method} ${req.url}`);
    next();
  });

  // Routes
  app.use('/api', healthRouter);
  app.use('/api/auth', authRouter);
  app.use('/api/admin', adminRouter);
  app.use('/api/recovery-requests', recoveryRequestsRouter);
  app.use('/api/lists', listsRouter);
  app.use('/api/items', itemsRouter);
  app.use('/api/sync', syncRouter);
  app.use('/api/categories', categoriesRouter);
  app.use('/api/updates', updatesRouter);

  // Global error handler
  app.use(errorHandler);

  return app;
}
