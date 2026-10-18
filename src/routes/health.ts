import { Router } from 'express';
import { config } from '../config.js';

export const healthRouter = Router();

healthRouter.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptimeSeconds: Math.floor(process.uptime()),
    service: config.appName,
    serviceMr: config.appNameMr
  });
});

healthRouter.get('/version', (req, res) => {
  res.json({
    name: config.appName,
    nameMr: config.appNameMr,
    version: config.appVersion,
    buildNumber: config.buildNumber,
    attribution: config.attribution
  });
});
