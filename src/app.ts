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

  // Explicit Allowed CORS Origins (Non-wildcard, secure enforcement)
  const allowedOrigins = [
    'https://homegrocery.github.io',
    'http://localhost:3000',
    'http://localhost:3002',
    'http://127.0.0.1:3000',
    'http://127.0.0.1:3002',
    'capacitor://localhost',
    'http://localhost'
  ];

  if (process.env.CORS_ALLOWED_ORIGINS) {
    const extra = process.env.CORS_ALLOWED_ORIGINS.split(',').map(o => o.trim()).filter(Boolean);
    allowedOrigins.push(...extra);
  }

  // CORS configuration
  const corsOptions: cors.CorsOptions = {
    origin: (origin, callback) => {
      // Allow requests with no origin (like native mobile apps, curl, server-to-server)
      if (!origin) return callback(null, true);
      if (allowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      return callback(new Error(`CORS blocked for origin: ${origin}`));
    },
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'X-Client-Version', 'X-Recovery-Request-Id', 'X-Recovery-Token'],
    credentials: true,
    optionsSuccessStatus: 204
  };

  app.use(cors(corsOptions));
  app.options('*', cors(corsOptions));

  // Body parser
  app.use(express.json({ limit: '5mb' }));

  // Request logger
  app.use((req, res, next) => {
    console.log(`[HTTP] ${req.method} ${req.url}`);
    next();
  });

  // Root status and health redirect
  app.get('/', (req, res) => {
    res.json({
      service: 'Home Grocery API',
      serviceMr: 'घरगुती किराणा यादी API',
      status: 'ok',
      health: '/api/health',
      version: '1.0.0'
    });
  });

  app.get('/health', (req, res) => {
    res.redirect(301, '/api/health');
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
