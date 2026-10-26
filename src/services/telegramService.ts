/**
 * Home Grocery — Premium Telegram Admin Notification Service
 *
 * Centralized, secure alert delivery via Telegram Bot API with:
 * - Premium branding & Telegram-compliant HTML formatting.
 * - Severity indicators: INFORMATIONAL, PENDING_REVIEW, SUCCESS, WARNING, CRITICAL.
 * - Human-readable timestamps in Indian Standard Time (IST) with UTC reference.
 * - Real Telegram Bot API `inline_keyboard` interactive button linking to Admin ERP.
 * - Genuine optional animation support via `sendAnimation` with safe HTML text fallback.
 * - Strict privacy: raw mobile numbers masked (+91 XX*** **XXX), zero credentials/PINs/secrets.
 * - Bounded retry, 5s timeout, idempotency & in-memory cooldown deduplication.
 * - Complete failure independence: Telegram issues never break core business transactions.
 */

import { config } from '../config.js';

export type AlertSeverity = 'INFO' | 'PENDING' | 'SUCCESS' | 'WARNING' | 'CRITICAL';

export interface TelegramNotificationResult {
  sent: boolean;
  reason?: 'NOT_CONFIGURED' | 'DEDUPLICATED' | 'FAILED' | 'SUCCESS';
  method?: 'ANIMATION' | 'TEXT';
}

export interface TelegramInlineKeyboardButton {
  text: string;
  url: string;
}

export class TelegramService {
  private static deduplicationCache = new Map<string, number>();
  private static readonly DEFAULT_TIMEOUT_MS = 5000;
  public static readonly ADMIN_ERP_URL = 'https://homegrocery.github.io/admin-ERP/';

  /**
   * Check if Telegram alerts are properly configured in environment variables.
   * Never prints, returns, or exposes secret values.
   */
  static isConfigured(): boolean {
    const token = (process.env.TELEGRAM_BOT_TOKEN || (config as any).telegramBotToken || '').trim();
    const chatId = (process.env.TELEGRAM_ADMIN_CHAT_ID || (config as any).telegramAdminChatId || '').trim();
    return Boolean(token && chatId && !token.startsWith('YOUR_') && !chatId.startsWith('YOUR_'));
  }

  /**
   * Retrieve configured animation source (URL or Telegram file_id), if any.
   * Safe check: returns null if unconfigured or placeholder.
   */
  static getAnimationSource(): string | null {
    const url = (process.env.TELEGRAM_ALERT_ANIMATION_URL || (config as any).telegramAnimationUrl || '').trim();
    if (url && !url.startsWith('YOUR_') && (url.startsWith('https://') || url.startsWith('http://'))) {
      return url;
    }
    const fileId = (process.env.TELEGRAM_ALERT_ANIMATION_FILE_ID || (config as any).telegramAnimationFileId || '').trim();
    if (fileId && !fileId.startsWith('YOUR_')) {
      return fileId;
    }
    return null;
  }

  /**
   * Reset in-memory deduplication cache (for testing or restart).
   */
  static resetDeduplicationCache(): void {
    this.deduplicationCache.clear();
  }

  /**
   * Format any ISO date/timestamp into human-readable Indian Standard Time (IST)
   * with UTC reference.
   * Example: "26 Oct 2026, 03:50 PM IST (10:20 UTC)"
   */
  static formatTimestampIST(dateInput?: Date | string | null): string {
    const d = dateInput ? new Date(dateInput) : new Date();
    if (isNaN(d.getTime())) return new Date().toISOString();

    try {
      const istString = d.toLocaleString('en-IN', {
        timeZone: 'Asia/Kolkata',
        day: '2-digit',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hour12: true
      });

      const utcHours = String(d.getUTCHours()).padStart(2, '0');
      const utcMins = String(d.getUTCMinutes()).padStart(2, '0');

      return `${istString} IST (${utcHours}:${utcMins} UTC)`;
    } catch {
      return d.toISOString();
    }
  }

  /**
   * Mask a mobile number for safe transmission and logging.
   * E.g. "9356755100" -> "+91 93*** **100"
   */
  static maskMobile(mobileNumber?: string | null): string {
    if (!mobileNumber) return '[Not Provided]';
    const clean = mobileNumber.replace(/\D/g, '');
    if (clean.length >= 10) {
      const last10 = clean.slice(-10);
      return `+91 ${last10.slice(0, 2)}*** **${last10.slice(-3)}`;
    }
    if (clean.length >= 4) {
      return `${clean.slice(0, 2)}***${clean.slice(-2)}`;
    }
    return '***';
  }

  /**
   * Escape HTML special characters to prevent Telegram formatting breakages.
   */
  static escapeHtml(text?: string | null): string {
    if (!text) return '';
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /**
   * Generate standard interactive inline keyboard pointing to Admin ERP.
   */
  static buildAdminErpKeyboard(customLabel?: string): { inline_keyboard: TelegramInlineKeyboardButton[][] } {
    return {
      inline_keyboard: [
        [
          {
            text: customLabel || '🛠️ Open Admin ERP',
            url: this.ADMIN_ERP_URL
          }
        ]
      ]
    };
  }

  /**
   * Build premium structured message HTML with Home Grocery branding and severity.
   */
  static formatMessageCard(params: {
    severity: AlertSeverity;
    title: string;
    accountReference?: { mobile?: string | null; name?: string | null };
    details: Array<{ label: string; value: string }>;
    notes?: string | null;
    timestamp?: string | null;
  }): string {
    let severityBadge = 'ℹ️ <b>INFORMATIONAL NOTICE</b>';
    if (params.severity === 'PENDING') severityBadge = '⏳ <b>ACTION REQUIRED — PENDING REVIEW</b>';
    if (params.severity === 'SUCCESS') severityBadge = '✅ <b>OPERATION SUCCESSFUL</b>';
    if (params.severity === 'WARNING') severityBadge = '⚠️ <b>SECURITY WARNING</b>';
    if (params.severity === 'CRITICAL') severityBadge = '🚨 <b>CRITICAL SECURITY ALERT</b>';

    const lines: string[] = [
      '<b>HOME GROCERY (घरगुती किराणा यादी)</b>',
      severityBadge,
      '━━━━━━━━━━━━━━━━━━━━━━',
      `<b>${params.title}</b>`,
      ''
    ];

    if (params.accountReference) {
      const masked = this.maskMobile(params.accountReference.mobile);
      const namePart = params.accountReference.name ? ` (${this.escapeHtml(params.accountReference.name)})` : '';
      lines.push(`<b>Account:</b> <code>${masked}</code>${namePart}`);
    }

    for (const item of params.details) {
      lines.push(`<b>${item.label}:</b> ${item.value}`);
    }

    if (params.notes) {
      lines.push(`<b>Note:</b> <i>"${this.escapeHtml(params.notes)}"</i>`);
    }

    const timeStr = this.formatTimestampIST(params.timestamp);
    lines.push(`<b>Time:</b> <code>${timeStr}</code>`);

    return lines.join('\n');
  }

  /**
   * Internal helper to perform Telegram Bot API calls.
   * Completely safe: never throws; applies timeouts, bounded retries, and deduplication.
   */
  static async sendNotification(params: {
    htmlMessage: string;
    includeErpButton?: boolean;
    buttonLabel?: string;
    deduplicationKey?: string;
    cooldownMs?: number;
    timestamp?: string | null;
  }): Promise<TelegramNotificationResult> {
    if (!this.isConfigured()) {
      return { sent: false, reason: 'NOT_CONFIGURED' };
    }

    const token = (process.env.TELEGRAM_BOT_TOKEN || (config as any).telegramBotToken || '').trim();
    const chatId = (process.env.TELEGRAM_ADMIN_CHAT_ID || (config as any).telegramAdminChatId || '').trim();

    // Check deduplication
    if (params.deduplicationKey) {
      const now = Date.now();
      const cooldown = params.cooldownMs ?? 300000; // default 5 minutes
      const lastSent = this.deduplicationCache.get(params.deduplicationKey);
      if (lastSent && now - lastSent < cooldown) {
        return { sent: false, reason: 'DEDUPLICATED' };
      }
      this.deduplicationCache.set(params.deduplicationKey, now);

      // Clean old entries if cache grows
      if (this.deduplicationCache.size > 300) {
        for (const [k, v] of this.deduplicationCache.entries()) {
          if (now - v > 3600000) {
            this.deduplicationCache.delete(k);
          }
        }
      }
    }

    const replyMarkup = params.includeErpButton !== false
      ? this.buildAdminErpKeyboard(params.buttonLabel)
      : undefined;

    const animSource = this.getAnimationSource();

    // Try sending real animation if configured
    if (animSource) {
      const animResult = await this.trySendAnimation({
        token,
        chatId,
        animSource,
        caption: params.htmlMessage,
        replyMarkup
      });

      if (animResult.sent) {
        return { sent: true, reason: 'SUCCESS', method: 'ANIMATION' };
      }
      // If animation delivery failed, fall back safely to text message
      console.warn('[TelegramService] Animation dispatch failed or timed out. Falling back to text notification.');
    }

    // Standard text message delivery
    const textResult = await this.sendTextMessage({
      token,
      chatId,
      htmlMessage: params.htmlMessage,
      replyMarkup
    });

    return {
      sent: textResult.sent,
      reason: textResult.reason,
      method: 'TEXT'
    };
  }

  /**
   * Send a formatted Telegram message (public convenience method / backward compatibility).
   */
  static async sendMessage(
    htmlMessage: string,
    options?: {
      deduplicationKey?: string;
      cooldownMs?: number;
      includeErpButton?: boolean;
      buttonLabel?: string;
    }
  ): Promise<TelegramNotificationResult> {
    return this.sendNotification({
      htmlMessage,
      deduplicationKey: options?.deduplicationKey,
      cooldownMs: options?.cooldownMs,
      includeErpButton: options?.includeErpButton,
      buttonLabel: options?.buttonLabel
    });
  }

  /**
   * Real Telegram Bot API `sendAnimation` implementation with bounded retry and timeout.
   */
  private static async trySendAnimation(opts: {
    token: string;
    chatId: string;
    animSource: string;
    caption: string;
    replyMarkup?: any;
  }): Promise<{ sent: boolean }> {
    const endpoint = `https://api.telegram.org/bot${opts.token}/sendAnimation`;
    // Telegram caption limit is 1024 characters
    const safeCaption = opts.caption.length > 1024 ? `${opts.caption.slice(0, 1020)}...` : opts.caption;

    const payload = JSON.stringify({
      chat_id: opts.chatId,
      animation: opts.animSource,
      caption: safeCaption,
      parse_mode: 'HTML',
      reply_markup: opts.replyMarkup
    });

    let attempts = 0;
    const maxAttempts = 2;

    while (attempts < maxAttempts) {
      attempts++;
      try {
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: payload,
          signal: AbortSignal.timeout(this.DEFAULT_TIMEOUT_MS)
        });

        if (response.ok) {
          return { sent: true };
        }

        const status = response.status;
        if (status >= 400 && status < 500) {
          // Client error: invalid URL or unsupported format, don't retry animation
          return { sent: false };
        }

        if (attempts < maxAttempts) {
          await new Promise(r => setTimeout(r, 400));
        }
      } catch {
        if (attempts < maxAttempts) {
          await new Promise(r => setTimeout(r, 400));
        }
      }
    }

    return { sent: false };
  }

  /**
   * Telegram Bot API `sendMessage` implementation with bounded retry and timeout.
   */
  private static async sendTextMessage(opts: {
    token: string;
    chatId: string;
    htmlMessage: string;
    replyMarkup?: any;
  }): Promise<{ sent: boolean; reason: 'FAILED' | 'SUCCESS' }> {
    const endpoint = `https://api.telegram.org/bot${opts.token}/sendMessage`;
    const payload = JSON.stringify({
      chat_id: opts.chatId,
      text: opts.htmlMessage,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      reply_markup: opts.replyMarkup
    });

    let attempts = 0;
    const maxAttempts = 2;

    while (attempts < maxAttempts) {
      attempts++;
      try {
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: payload,
          signal: AbortSignal.timeout(this.DEFAULT_TIMEOUT_MS)
        });

        if (response.ok) {
          return { sent: true, reason: 'SUCCESS' };
        }

        const status = response.status;
        if (status >= 400 && status < 500) {
          console.warn(`[TelegramService] API rejected text message (HTTP ${status}).`);
          return { sent: false, reason: 'FAILED' };
        }

        if (attempts < maxAttempts) {
          await new Promise(r => setTimeout(r, 400));
        }
      } catch (err: any) {
        if (attempts < maxAttempts) {
          await new Promise(r => setTimeout(r, 400));
        } else {
          console.warn(`[TelegramService] Delivery network error: ${err?.name || 'Error'} - ${err?.message || 'failed'}`);
        }
      }
    }

    return { sent: false, reason: 'FAILED' };
  }

  // =========================================================================
  // Complete Lifecycle Notification Methods (Part 2)
  // =========================================================================

  /**
   * 1. New Member Registration
   */
  static async notifyNewMemberRegistration(params: {
    mobileNumber: string;
    fullName: string;
    role?: string;
    preferredLanguage?: string;
    createdAt?: string;
  }): Promise<TelegramNotificationResult> {
    const text = this.formatMessageCard({
      severity: 'INFO',
      title: 'NEW MEMBER REGISTRATION',
      accountReference: { mobile: params.mobileNumber, name: params.fullName },
      details: [
        { label: 'Role', value: `<code>${params.role || 'user'}</code>` },
        { label: 'Language', value: (params.preferredLanguage || 'mr').toUpperCase() },
        { label: 'Status', value: 'Active / Initial Session Created' }
      ],
      notes: 'Initial recovery code generated client-side.',
      timestamp: params.createdAt
    });

    return this.sendNotification({
      htmlMessage: text,
      buttonLabel: '👥 Inspect in Admin ERP',
      deduplicationKey: `NEW_USER:${params.mobileNumber}`,
      cooldownMs: 60000
    });
  }

  /**
   * 2. PIN Recovery Request Submitted
   */
  static async notifyPinRecoveryRequest(params: {
    requestId: string;
    mobileNumber: string;
    fullName?: string | null;
    createdAt?: string;
  }): Promise<TelegramNotificationResult> {
    const text = this.formatMessageCard({
      severity: 'PENDING',
      title: 'PIN RECOVERY REQUEST SUBMITTED',
      accountReference: { mobile: params.mobileNumber, name: params.fullName },
      details: [
        { label: 'Request ID', value: `<code>${params.requestId}</code>` },
        { label: 'Status', value: '⏳ Awaiting Administrator Review' }
      ],
      notes: 'Owner identity verification is required before issuing a temporary recovery code.',
      timestamp: params.createdAt
    });

    return this.sendNotification({
      htmlMessage: text,
      buttonLabel: '🔑 Review Recovery in Admin ERP',
      deduplicationKey: `RECOVERY_REQ:${params.requestId}`,
      cooldownMs: 60000
    });
  }

  /**
   * 3. Recovery Code Generated or Replaced
   * NOTE: The actual secret code is NEVER transmitted or logged!
   */
  static async notifyRecoveryCodeIssued(params: {
    userId: string;
    mobileNumber?: string | null;
    fullName?: string | null;
    isReplacement: boolean;
    timestamp?: string | null;
  }): Promise<TelegramNotificationResult> {
    const actionLabel = params.isReplacement ? 'Replacement Recovery Code Generated' : 'Initial Recovery Code Configured';
    const text = this.formatMessageCard({
      severity: 'INFO',
      title: actionLabel.toUpperCase(),
      accountReference: { mobile: params.mobileNumber, name: params.fullName },
      details: [
        { label: 'Action', value: params.isReplacement ? 'Previous Code Replaced' : 'New Code Stored' },
        { label: 'Protection', value: 'scrypt Hash Stored / Zero Plaintext Leak' }
      ],
      notes: 'Secret recovery code stored client-side only and never transmitted via alerts.',
      timestamp: params.timestamp
    });

    return this.sendNotification({
      htmlMessage: text,
      buttonLabel: '🛡️ View Account in Admin ERP',
      deduplicationKey: `REC_CODE_ISSUED:${params.userId}`,
      cooldownMs: 60000
    });
  }

  /**
   * 4. Successful Recovery Completion & PIN Reset
   */
  static async notifyPinResetSuccess(params: {
    mobileNumber: string;
    fullName?: string | null;
    method: 'RECOVERY_CODE' | 'PHONE_OTP';
    timestamp?: string | null;
  }): Promise<TelegramNotificationResult> {
    const methodStr = params.method === 'RECOVERY_CODE' ? 'Permanent/Temporary Recovery Code' : 'Firebase Phone OTP';
    const text = this.formatMessageCard({
      severity: 'SUCCESS',
      title: 'PIN RESET COMPLETED SUCCESSFULLY',
      accountReference: { mobile: params.mobileNumber, name: params.fullName },
      details: [
        { label: 'Reset Method', value: methodStr },
        { label: 'Single-Use Code', value: 'Marked CONSUMED' },
        { label: 'Session Status', value: 'All Active Sessions Revoked' }
      ],
      notes: 'Account unlocked and ready for login with new PIN.',
      timestamp: params.timestamp
    });

    return this.sendNotification({
      htmlMessage: text,
      buttonLabel: '📜 Audit Logs in Admin ERP',
      deduplicationKey: `PIN_RESET:${params.mobileNumber}`,
      cooldownMs: 60000
    });
  }

  /**
   * 5. Recovery Request Cancelled or Deleted
   */
  static async notifyRecoveryRequestCancelled(params: {
    requestId: string;
    targetMobileNumber?: string | null;
    cancelledBy: 'USER' | 'ADMIN';
    timestamp?: string | null;
  }): Promise<TelegramNotificationResult> {
    const text = this.formatMessageCard({
      severity: 'INFO',
      title: 'RECOVERY REQUEST CANCELLED',
      accountReference: { mobile: params.targetMobileNumber },
      details: [
        { label: 'Request ID', value: `<code>${params.requestId}</code>` },
        { label: 'Cancelled By', value: params.cancelledBy === 'USER' ? 'User (Capability Token)' : 'Admin Deletion' },
        { label: 'State', value: 'Removed from Active Queue' }
      ],
      timestamp: params.timestamp
    });

    return this.sendNotification({
      htmlMessage: text,
      buttonLabel: '📋 Open Admin ERP Queue',
      deduplicationKey: `REC_CANCELLED:${params.requestId}`,
      cooldownMs: 60000
    });
  }

  /**
   * 6. Suspicious Recovery Activity / Repeated Failed Recovery Attempts
   */
  static async notifySuspiciousRecoveryActivity(params: {
    mobileNumber: string;
    failedAttempts: number;
    lockoutHours: number;
    timestamp?: string | null;
  }): Promise<TelegramNotificationResult> {
    const text = this.formatMessageCard({
      severity: 'CRITICAL',
      title: 'SUSPICIOUS RECOVERY ACTIVITY DETECTED',
      accountReference: { mobile: params.mobileNumber },
      details: [
        { label: 'Failed Attempts', value: `${params.failedAttempts} of ${params.failedAttempts}` },
        { label: 'Enforcement', value: `🔒 ${params.lockoutHours}-Hour Recovery Lockout Enforced` },
        { label: 'Standard Login', value: 'Remains active (Independent Lockout)' }
      ],
      notes: 'Consecutive invalid recovery code submissions. Endpoint locked to prevent brute-force.',
      timestamp: params.timestamp
    });

    return this.sendNotification({
      htmlMessage: text,
      buttonLabel: '🚨 Inspect Security in Admin ERP',
      deduplicationKey: `SUSPICIOUS_REC:${params.mobileNumber}`,
      cooldownMs: 300000 // 5-minute cooldown
    });
  }

  /**
   * 7. Account Reactivation / Unlock Request Submitted
   */
  static async notifyReactivationRequest(params: {
    requestId: string;
    mobileNumber: string;
    fullName?: string | null;
    reason?: string | null;
    lockType?: string | null;
    failedAttempts?: number;
    createdAt?: string;
  }): Promise<TelegramNotificationResult> {
    const text = this.formatMessageCard({
      severity: 'PENDING',
      title: 'ACCOUNT REACTIVATION REQUEST SUBMITTED',
      accountReference: { mobile: params.mobileNumber, name: params.fullName },
      details: [
        { label: 'Request ID', value: `<code>${params.requestId}</code>` },
        { label: 'Lock Type', value: params.lockType || 'AUTOMATIC' },
        { label: 'Prior Failures', value: `${params.failedAttempts ?? 5}/5 consecutive` }
      ],
      notes: params.reason || 'User requested account reactivation.',
      timestamp: params.createdAt
    });

    return this.sendNotification({
      htmlMessage: text,
      buttonLabel: '🔓 Review Reactivation in Admin ERP',
      deduplicationKey: `REACTIVATION_REQ:${params.requestId}`,
      cooldownMs: 60000
    });
  }

  /**
   * 8. Automatic Account Lock (Failed PIN threshold reached)
   */
  static async notifyAutomaticAccountLocked(params: {
    mobileNumber: string;
    fullName?: string | null;
    failedAttempts: number;
    lockType: string;
    reason: string;
    lockedAt?: string;
  }): Promise<TelegramNotificationResult> {
    const text = this.formatMessageCard({
      severity: 'WARNING',
      title: 'ACCOUNT LOCKED AUTOMATICALLY',
      accountReference: { mobile: params.mobileNumber, name: params.fullName },
      details: [
        { label: 'Reason', value: params.reason },
        { label: 'Consecutive Failures', value: `${params.failedAttempts} of 5` },
        { label: 'Lock Status', value: '🔒 Locked Until Admin Reactivation' },
        { label: 'Sessions', value: 'All active sessions terminated' }
      ],
      notes: 'User must submit a reactivation request from the mobile app.',
      timestamp: params.lockedAt
    });

    return this.sendNotification({
      htmlMessage: text,
      buttonLabel: '🔐 View Lock Status in Admin ERP',
      deduplicationKey: `AUTO_LOCK:${params.mobileNumber}`,
      cooldownMs: 300000 // 5-minute cooldown
    });
  }

  /**
   * 9. Authorized Manual Account Lock or Unlock
   */
  static async notifyAdministrativeAccountAction(params: {
    action: 'LOCKED' | 'ACTIVATED';
    targetMobileNumber: string;
    targetFullName?: string | null;
    adminUserId: string;
    reason?: string | null;
    timestamp?: string;
  }): Promise<TelegramNotificationResult> {
    const isLock = params.action === 'LOCKED';
    const text = this.formatMessageCard({
      severity: isLock ? 'WARNING' : 'SUCCESS',
      title: isLock ? 'ACCOUNT ADMINISTRATIVELY LOCKED' : 'ACCOUNT ADMINISTRATIVELY ACTIVATED',
      accountReference: { mobile: params.targetMobileNumber, name: params.targetFullName },
      details: [
        { label: 'Action', value: params.action },
        { label: 'Performed By Admin', value: `<code>${params.adminUserId}</code>` },
        { label: 'Session Effect', value: isLock ? 'All active sessions revoked' : 'User may log in again' }
      ],
      notes: params.reason || (isLock ? 'Administrative lock' : 'Administrative activation'),
      timestamp: params.timestamp
    });

    return this.sendNotification({
      htmlMessage: text,
      buttonLabel: '📜 View Audit Logs in Admin ERP',
      timestamp: params.timestamp
    });
  }

  /**
   * 10. Owner Admin Approves or Rejects Request
   */
  static async notifyAdminDecision(params: {
    type: 'RECOVERY' | 'REACTIVATION';
    decision: 'APPROVED' | 'REJECTED';
    requestId: string;
    targetMobileNumber: string;
    targetFullName?: string | null;
    adminNotes?: string | null;
    timestamp?: string;
  }): Promise<TelegramNotificationResult> {
    const isApproved = params.decision === 'APPROVED';
    const typeLabel = params.type === 'RECOVERY' ? 'PIN Recovery' : 'Account Reactivation';

    const text = this.formatMessageCard({
      severity: isApproved ? 'SUCCESS' : 'WARNING',
      title: `${typeLabel.toUpperCase()} REQUEST ${params.decision}`,
      accountReference: { mobile: params.targetMobileNumber, name: params.targetFullName },
      details: [
        { label: 'Request ID', value: `<code>${params.requestId}</code>` },
        { label: 'Decision', value: `<b>${params.decision}</b>` },
        { label: 'Request Type', value: typeLabel }
      ],
      notes: params.adminNotes || (isApproved ? 'Approved by administrator' : 'Rejected by administrator'),
      timestamp: params.timestamp
    });

    return this.sendNotification({
      htmlMessage: text,
      buttonLabel: '📋 Inspect Queue in Admin ERP',
      timestamp: params.timestamp
    });
  }

  /**
   * 11. User Changes PIN with Existing Authenticated Session
   */
  static async notifyPinChanged(params: {
    userId: string;
    mobileNumber: string;
    fullName?: string | null;
    timestamp?: string | null;
  }): Promise<TelegramNotificationResult> {
    const text = this.formatMessageCard({
      severity: 'INFO',
      title: 'SECURITY: ACCOUNT PIN CHANGED',
      accountReference: { mobile: params.mobileNumber, name: params.fullName },
      details: [
        { label: 'Verification', value: 'Verified with Current PIN' },
        { label: 'Session Status', value: 'Previous sessions invalidated / Re-login required' }
      ],
      notes: 'PIN updated successfully from authenticated settings.',
      timestamp: params.timestamp
    });

    return this.sendNotification({
      htmlMessage: text,
      buttonLabel: '🛡️ Inspect Account in Admin ERP',
      deduplicationKey: `PIN_CHANGED:${params.userId}`,
      cooldownMs: 60000
    });
  }

  /**
   * 12. Critical Sync Failures or Backend Errors (with deduplication)
   */
  static async notifyCriticalError(params: {
    errorType: string;
    message: string;
    endpoint?: string;
    method?: string;
    userId?: string;
  }): Promise<TelegramNotificationResult> {
    const endpointStr = params.endpoint ? `${params.method || 'GET'} ${params.endpoint}` : 'Internal Service';
    const safeMsg = params.message.slice(0, 300);

    const text = this.formatMessageCard({
      severity: 'CRITICAL',
      title: 'CRITICAL BACKEND ERROR ALERT',
      details: [
        { label: 'Error Type', value: `<code>${this.escapeHtml(params.errorType)}</code>` },
        { label: 'Endpoint', value: `<code>${this.escapeHtml(endpointStr)}</code>` },
        { label: 'Message', value: this.escapeHtml(safeMsg) }
      ],
      notes: 'Identical recurring errors are suppressed for 10 minutes to prevent alert flooding.'
    });

    const dedupKey = `ERR:${params.errorType}:${params.endpoint || 'general'}`;
    return this.sendNotification({
      htmlMessage: text,
      buttonLabel: '🚨 Inspect Health in Admin ERP',
      deduplicationKey: dedupKey,
      cooldownMs: 600000 // 10 minutes deduplication
    });
  }
}
