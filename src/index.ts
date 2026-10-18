import { createApp } from './app.js';
import { config } from './config.js';
import { getDatabase } from './db/database.js';

const app = createApp();

// Initialize database
getDatabase();

const server = app.listen(config.port, config.host, () => {
  console.log(`====================================================`);
  console.log(` Home Grocery Backend Server (घरगुती किराणा यादी)`);
  console.log(` Version: ${config.appVersion} (Build ${config.buildNumber})`);
  console.log(` Listening on: http://${config.host}:${config.port}`);
  console.log(` Database: ${config.dbPath}`);
  console.log(` Environment: ${config.nodeEnv}`);
  console.log(` Attribution: ${config.attribution.en} / ${config.attribution.mr}`);
  console.log(`====================================================`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM signal received. Closing HTTP server.');
  server.close(() => {
    console.log('HTTP server closed.');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('SIGINT signal received. Closing HTTP server.');
  server.close(() => {
    console.log('HTTP server closed.');
    process.exit(0);
  });
});

process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught Exception:', err);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[WARN] Unhandled Rejection at:', promise, 'reason:', reason);
});

