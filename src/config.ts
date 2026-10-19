import path from 'node:path';
import dotenv from 'dotenv';

dotenv.config();

export const config = {
  port: parseInt(process.env.PORT || '3001', 10),
  host: process.env.HOST || '0.0.0.0',
  nodeEnv: process.env.NODE_ENV || 'development',
  dbPath: process.env.DB_PATH || path.resolve(process.cwd(), 'data', 'homegrocery.db'),
  backupDir: process.env.BACKUP_DIR || path.resolve(process.cwd(), 'backups'),
  sessionTtlHours: parseInt(process.env.SESSION_TTL_HOURS || '720', 10), // 30 days
  maxFailedAttempts: parseInt(process.env.MAX_FAILED_ATTEMPTS || '5', 10),
  lockoutMinutes: parseInt(process.env.LOCKOUT_MINUTES || '15', 10),
  recoveryMaxAttempts: parseInt(process.env.RECOVERY_MAX_ATTEMPTS || '4', 10),
  recoveryLockoutHours: parseInt(process.env.RECOVERY_LOCKOUT_HOURS || '24', 10),
  recoveryAuthTtlMinutes: parseInt(process.env.RECOVERY_AUTH_TTL_MINUTES || '15', 10),
  recoveryTempCodeTtlMinutes: parseInt(process.env.RECOVERY_TEMP_CODE_TTL_MINUTES || '30', 10),
  recoveryEncryptionKey: process.env.RECOVERY_ENCRYPTION_KEY || '',
  adminMobileNumber: process.env.ADMIN_MOBILE_NUMBER || '9356755100',
  adminPort: parseInt(process.env.ADMIN_PORT || '3002', 10),
  appName: 'Home Grocery',
  appNameMr: 'घरगुती किराणा यादी',
  appVersion: '1.0.0',
  buildNumber: 5,
  attribution: {
    en: 'App developed by Santosh Koli',
    mr: 'संतोष कोळी यांनी विकसित केलेले ॲप'
  }
};
