import { getDatabase } from '../db/database.js';
import { generateId, hashToken } from '../utils/crypto.js';
import { AdminService } from './adminService.js';
import { TelegramService } from './telegramService.js';

export type SecuritySeverity = 'LEVEL_1_LOW' | 'LEVEL_2_ELEVATED' | 'LEVEL_3_HIGH';

export interface SecurityEventParams {
  type: string;
  severity: SecuritySeverity;
  actionTaken: 'REJECT' | 'THROTTLE' | 'SESSION_REVOKED' | 'ACCOUNT_LOCKED' | 'COOLDOWN';
  userId?: string | null;
  mobileNumber?: string | null;
  ipAddress?: string | null;
  endpoint?: string;
  method?: string;
  details?: Record<string, any>;
  reasonCode?: string;
}

export interface RevokedSessionInfo {
  userId: string;
  reasonCode: string;
  lockType?: 'AUTOMATIC' | 'ADMINISTRATIVE' | null;
  lockReason?: string | null;
  revokedAt: string;
}

export class SecurityService {
  // In-memory cache of revoked token hashes with reason information (TTL: 24 hours)
  private static revokedTokens = new Map<string, RevokedSessionInfo>();

  // Sliding window tracker for admin endpoint probe attempts by user ID: userId -> timestamps[]
  private static adminProbeAttempts = new Map<string, number[]>();

  // Sliding window tracker for IP-level failed attempts: ip -> timestamps[]
  private static ipFailedAttempts = new Map<string, number[]>();

  // IP cooldown map: ip -> cooldownUntil (epoch ms)
  private static ipCooldowns = new Map<string, number>();

  // Cooldown & threshold configuration
  private static readonly ADMIN_PROBE_MAX_ATTEMPTS = 3;
  private static readonly ADMIN_PROBE_WINDOW_MS = 10 * 60 * 1000; // 10 minutes

  private static readonly IP_BRUTE_FORCE_THRESHOLD = 15;
  private static readonly IP_BRUTE_FORCE_WINDOW_MS = 60 * 1000; // 1 minute
  private static readonly IP_COOLDOWN_DURATION_MS = 5 * 60 * 1000; // 5 minutes cooldown

  /**
   * Resets all in-memory security tracking state (used in automated testing and diagnostics).
   */
  public static resetMemoryState(): void {
    this.revokedTokens.clear();
    this.adminProbeAttempts.clear();
    this.ipFailedAttempts.clear();
    this.ipCooldowns.clear();
  }

  /**
   * Reset in-memory trackers (used in tests to ensure clean state).
   */
  public static resetStateForTests(): void {
    this.revokedTokens.clear();
    this.adminProbeAttempts.clear();
    this.ipFailedAttempts.clear();
    this.ipCooldowns.clear();
  }

  /**
   * Records a token hash as explicitly revoked with associated security context.
   */
  public static recordRevokedToken(
    tokenHash: string,
    info: RevokedSessionInfo
  ): void {
    this.revokedTokens.set(tokenHash, info);
  }

  /**
   * Retrieves revocation context for a given token hash, if known.
   */
  public static getRevokedToken(tokenHash: string): RevokedSessionInfo | undefined {
    return this.revokedTokens.get(tokenHash);
  }

  /**
   * Revokes all active sessions for a user and caches the token hashes with security reason context.
   */
  public static revokeUserSessions(
    userId: string,
    reasonCode: string,
    lockReason?: string | null,
    lockType?: 'AUTOMATIC' | 'ADMINISTRATIVE' | null
  ): void {
    const db = getDatabase();
    const nowIso = new Date().toISOString();

    try {
      // Find all token hashes currently active for this user
      const sessions = db
        .prepare('SELECT token_hash FROM authentication_sessions WHERE user_id = ?')
        .all(userId) as Array<{ token_hash: string }>;

      sessions.forEach(sess => {
        this.recordRevokedToken(sess.token_hash, {
          userId,
          reasonCode,
          lockType: lockType || null,
          lockReason: lockReason || null,
          revokedAt: nowIso
        });
      });

      // Delete from active sessions table
      db.prepare('DELETE FROM authentication_sessions WHERE user_id = ?').run(userId);
    } catch (err: any) {
      console.error('[SecurityService] Error revoking user sessions:', err?.message);
    }
  }

  /**
   * Clears revoked token cache for a user upon reactivation or successful password reset.
   */
  public static clearRevokedTokensForUser(userId: string): void {
    for (const [tokenHash, info] of this.revokedTokens.entries()) {
      if (info.userId === userId) {
        this.revokedTokens.delete(tokenHash);
      }
    }
    this.adminProbeAttempts.delete(userId);
  }

  /**
   * Records a security event in the authoritative admin audit log and classifies severity.
   * If severity is LEVEL_2 or LEVEL_3, notifies Telegram Admin safely.
   */
  public static recordSecurityEvent(params: SecurityEventParams): void {
    const correlationId = generateId();
    const now = new Date().toISOString();

    // 1. Authoritative Audit Log Entry
    try {
      AdminService.logAudit({
        adminUserId: params.userId || 'SECURITY_SYSTEM',
        action: `SECURITY_${params.type}`,
        targetAccountId: params.userId || null,
        targetMobileNumber: params.mobileNumber || null,
        details: {
          correlationId,
          severity: params.severity,
          actionTaken: params.actionTaken,
          endpoint: params.endpoint || null,
          method: params.method || null,
          reasonCode: params.reasonCode || null,
          ...(params.details || {})
        },
        ipAddress: params.ipAddress || null
      });
    } catch (e) {
      console.error('[SecurityService] Failed to record security audit log:', e);
    }

    // 2. Safe Telegram Admin Notification for Level 2 & Level 3 events
    if (params.severity === 'LEVEL_2_ELEVATED' || params.severity === 'LEVEL_3_HIGH') {
      void TelegramService.notifySuspiciousSecurityEvent({
        eventType: params.type,
        severity: params.severity,
        actionTaken: params.actionTaken,
        mobileNumber: params.mobileNumber || null,
        ipAddress: params.ipAddress || null,
        endpoint: params.endpoint,
        details: params.details ? JSON.stringify(params.details) : undefined,
        timestamp: now
      }).catch(err => {
        console.warn('[SecurityService] Telegram notification notice:', err?.message);
      });
    }
  }

  /**
   * Records and evaluates an unauthorized attempt by an ordinary user to access Admin endpoints.
   * Triggers progressive security penalties:
   * - 1-2 attempts: Logged Level 1 / Level 2 rejection.
   * - 3+ attempts: Escalates to Level 3, revokes user sessions immediately!
   */
  public static recordAdminAccessAttempt(
    userId: string,
    mobileNumber: string,
    ipAddress: string,
    endpoint: string,
    method: string = 'GET'
  ): { shouldRevokeSession: boolean; consecutiveAttempts: number } {
    const now = Date.now();
    const attempts = this.adminProbeAttempts.get(userId) || [];
    const validAttempts = attempts.filter(ts => now - ts < this.ADMIN_PROBE_WINDOW_MS);
    validAttempts.push(now);
    this.adminProbeAttempts.set(userId, validAttempts);

    const count = validAttempts.length;

    if (count >= this.ADMIN_PROBE_MAX_ATTEMPTS) {
      // Level 3: Session Revocation
      this.recordSecurityEvent({
        type: 'ADMIN_PROBING_SESSION_REVOKED',
        severity: 'LEVEL_3_HIGH',
        actionTaken: 'SESSION_REVOKED',
        userId,
        mobileNumber,
        ipAddress,
        endpoint,
        method,
        reasonCode: 'SESSION_REVOKED_SECURITY',
        details: {
          consecutiveAttempts: count,
          windowMs: this.ADMIN_PROBE_WINDOW_MS
        }
      });

      this.revokeUserSessions(
        userId,
        'SESSION_REVOKED_SECURITY',
        'Session revoked due to repeated unauthorized administrative access attempts.',
        'ADMINISTRATIVE'
      );

      return { shouldRevokeSession: true, consecutiveAttempts: count };
    }

    // Level 1 / Level 2 logging
    const severity: SecuritySeverity = count === 1 ? 'LEVEL_1_LOW' : 'LEVEL_2_ELEVATED';
    this.recordSecurityEvent({
      type: 'UNAUTHORIZED_ADMIN_API_ACCESS_ATTEMPT',
      severity,
      actionTaken: 'REJECT',
      userId,
      mobileNumber,
      ipAddress,
      endpoint,
      method,
      reasonCode: 'UNAUTHORIZED_ACTION',
      details: {
        consecutiveAttempts: count,
        windowMs: this.ADMIN_PROBE_WINDOW_MS
      }
    });

    return { shouldRevokeSession: false, consecutiveAttempts: count };
  }

  /**
   * Evaluates source IP failed attempts across accounts to detect distributed brute force / enumeration.
   * Applies temporary source-based cooldown without locking innocent target accounts.
   */
  public static recordIpFailedAttempt(ipAddress: string): { isThrottled: boolean; cooldownRemainingSeconds: number } {
    if (!ipAddress || ipAddress === 'unknown' || ipAddress === '127.0.0.1' || ipAddress === '::1') {
      return { isThrottled: false, cooldownRemainingSeconds: 0 };
    }

    const now = Date.now();
    const activeCooldown = this.ipCooldowns.get(ipAddress);
    if (activeCooldown && activeCooldown > now) {
      return {
        isThrottled: true,
        cooldownRemainingSeconds: Math.ceil((activeCooldown - now) / 1000)
      };
    }

    const attempts = this.ipFailedAttempts.get(ipAddress) || [];
    const validAttempts = attempts.filter(ts => now - ts < this.IP_BRUTE_FORCE_WINDOW_MS);
    validAttempts.push(now);
    this.ipFailedAttempts.set(ipAddress, validAttempts);

    if (validAttempts.length >= this.IP_BRUTE_FORCE_THRESHOLD) {
      const cooldownUntil = now + this.IP_COOLDOWN_DURATION_MS;
      this.ipCooldowns.set(ipAddress, cooldownUntil);

      this.recordSecurityEvent({
        type: 'IP_BRUTE_FORCE_THROTTLED',
        severity: 'LEVEL_2_ELEVATED',
        actionTaken: 'COOLDOWN',
        ipAddress,
        reasonCode: 'RATE_LIMITED',
        details: {
          failedAttemptsInWindow: validAttempts.length,
          cooldownDurationSeconds: this.IP_COOLDOWN_DURATION_MS / 1000
        }
      });

      return {
        isThrottled: true,
        cooldownRemainingSeconds: this.IP_COOLDOWN_DURATION_MS / 1000
      };
    }

    return { isThrottled: false, cooldownRemainingSeconds: 0 };
  }

  /**
   * Validates cross-user record ownership.
   * Throws HTTP 403 UNAUTHORIZED_ACTION and records a security event if an authenticated user
   * attempts to access or modify a resource owned by another user.
   */
  public static validateRecordOwnership(params: {
    requestingUserId: string;
    requestingMobileNumber?: string;
    recordOwnerId: string;
    entityType: 'list' | 'item' | 'account' | 'recovery_code';
    entityId: string;
    ipAddress?: string;
    endpoint?: string;
  }): void {
    if (params.requestingUserId !== params.recordOwnerId) {
      this.recordSecurityEvent({
        type: 'CROSS_USER_ACCESS_ATTEMPT',
        severity: 'LEVEL_2_ELEVATED',
        actionTaken: 'REJECT',
        userId: params.requestingUserId,
        mobileNumber: params.requestingMobileNumber || null,
        ipAddress: params.ipAddress,
        endpoint: params.endpoint,
        reasonCode: 'UNAUTHORIZED_ACTION',
        details: {
          entityType: params.entityType,
          entityId: params.entityId,
          targetOwnerId: params.recordOwnerId
        }
      });

      const err: any = new Error('UNAUTHORIZED_ACTION: You do not have permission to access or modify this record.');
      err.status = 403;
      err.code = 'UNAUTHORIZED_ACTION';
      err.errorMr = 'अनधिकृत कृती. आपल्याला या नोंदीमध्ये प्रवेश करण्याची परवानगी नाही.';
      throw err;
    }
  }

  /**
   * Validates request payloads to detect tampering with privileged fields:
   * e.g., attempting to pass role='admin', locked_until=null, or fake userId on public or member endpoints.
   */
  public static validatePayloadSecurity(params: {
    payload: any;
    requestingUserId: string;
    requestingRole?: string;
    ipAddress?: string;
    endpoint?: string;
  }): void {
    if (!params.payload || typeof params.payload !== 'object') return;

    const forbiddenKeys = ['role', 'isAdmin', 'is_admin', 'locked_until', 'lock_type', 'lock_reason', 'failed_login_attempts', 'status'];
    const detectedPrivilegedKeys: string[] = [];

    for (const key of forbiddenKeys) {
      if (params.payload[key] !== undefined && params.requestingRole !== 'admin') {
        detectedPrivilegedKeys.push(key);
      }
    }

    // Check if body supplies a conflicting userId
    if (params.payload.userId && params.payload.userId !== params.requestingUserId && params.requestingRole !== 'admin') {
      detectedPrivilegedKeys.push(`userId(${params.payload.userId})`);
    }
    if (params.payload.user_id && params.payload.user_id !== params.requestingUserId && params.requestingRole !== 'admin') {
      detectedPrivilegedKeys.push(`user_id(${params.payload.user_id})`);
    }

    if (detectedPrivilegedKeys.length > 0) {
      this.recordSecurityEvent({
        type: 'PAYLOAD_TAMPERING_DETECTED',
        severity: 'LEVEL_2_ELEVATED',
        actionTaken: 'REJECT',
        userId: params.requestingUserId,
        ipAddress: params.ipAddress,
        endpoint: params.endpoint,
        reasonCode: 'UNAUTHORIZED_ACTION',
        details: {
          tamperedKeys: detectedPrivilegedKeys
        }
      });

      const err: any = new Error('UNAUTHORIZED_ACTION: Tampering with protected system fields is prohibited.');
      err.status = 400;
      err.code = 'UNAUTHORIZED_ACTION';
      err.errorMr = 'अनधिकृत कृती. संरक्षित प्रणाली फील्ड बदलण्यास मनाई आहे.';
      throw err;
    }
  }
}
