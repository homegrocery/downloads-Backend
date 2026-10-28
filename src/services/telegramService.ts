/**
 * Home Grocery — Premium Telegram Admin Notification Service
 *
 * Centralized, secure alert delivery via Telegram Bot API with:
 * - Premium branding & Telegram-compliant HTML formatting.
 * - Standardized category headers (SECURITY, MEMBER, RECOVERY, WEBSITE, RELEASE, CRITICAL).
 * - Severity indicators: INFORMATIONAL, PENDING_REVIEW, SUCCESS, WARNING, CRITICAL.
 * - Human-readable timestamps in Indian Standard Time (IST) with UTC reference.
 * - Real Telegram Bot API `inline_keyboard` interactive button linking to Admin ERP sections.
 * - Genuine animation support via `sendAnimation` (H.264 MP4 / GIF89a with multipart upload and file_id caching).
 * - Safe HTML text fallback when animation is unavailable or rejected.
 * - Strict privacy: raw mobile numbers masked (+91 XX*** **XXX), zero credentials/PINs/secrets.
 * - Bounded retry, 5s timeout, idempotency & in-memory cooldown deduplication.
 * - Complete failure independence: Telegram issues never break core business transactions.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export type AlertSeverity = 'INFO' | 'PENDING' | 'SUCCESS' | 'WARNING' | 'CRITICAL';

export type AlertCategory =
  | 'SECURITY'
  | 'MEMBER'
  | 'RECOVERY'
  | 'WEBSITE'
  | 'RELEASE'
  | 'CRITICAL'
  | 'GENERAL';

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
  private static cachedAnimationFileId: string | null = null;
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
   * Reset in-memory deduplication cache and cached file_id (for testing or restart).
   */
  static resetDeduplicationCache(): void {
    this.deduplicationCache.clear();
    this.cachedAnimationFileId = null;
  }

  /**
   * Reset or inspect cached Telegram animation file_id.
   */
  static resetAnimationFileIdCache(): void {
    this.cachedAnimationFileId = null;
  }

  static getCachedAnimationFileId(): string | null {
    return this.cachedAnimationFileId;
  }

  static setCachedAnimationFileId(fileId: string | null): void {
    this.cachedAnimationFileId = fileId;
  }

  /**
   * Find local animation asset on disk if present.
   */
  static getLocalAnimationAssetPath(): string | null {
    const candidates = [
      path.resolve(__dirname, '../assets/telegram/alert_animation.mp4'),
      path.resolve(__dirname, '../../src/assets/telegram/alert_animation.mp4'),
      path.resolve(process.cwd(), 'src/assets/telegram/alert_animation.mp4'),
      path.resolve(process.cwd(), 'dist/assets/telegram/alert_animation.mp4'),
      path.resolve(__dirname, '../assets/telegram/alert_animation.gif'),
      path.resolve(__dirname, '../../src/assets/telegram/alert_animation.gif'),
      path.resolve(process.cwd(), 'src/assets/telegram/alert_animation.gif'),
      path.resolve(process.cwd(), 'dist/assets/telegram/alert_animation.gif')
    ];

    for (const p of candidates) {
      if (fs.existsSync(p)) {
        try {
          const stat = fs.statSync(p);
          if (stat.size > 0) return p;
        } catch {
          // ignore stat errors
        }
      }
    }
    return null;
  }

  /**
   * Retrieve configured animation source (URL, Telegram file_id, or local file), if any.
   * Priority:
   * 1. TELEGRAM_ALERT_ANIMATION_FILE_ID env / config
   * 2. In-memory cached file_id
   * 3. TELEGRAM_ALERT_ANIMATION_URL env / config
   * 4. Local asset file (if not disabled by TELEGRAM_DISABLE_ANIMATION or TELEGRAM_DISABLE_LOCAL_ANIMATION)
   */
  static getAnimationSource(): string | null {
    if (process.env.TELEGRAM_DISABLE_ANIMATION === 'true') {
      return null;
    }

    const fileId = (process.env.TELEGRAM_ALERT_ANIMATION_FILE_ID || (config as any).telegramAnimationFileId || '').trim();
    if (fileId && !fileId.startsWith('YOUR_')) {
      return fileId;
    }

    if (this.cachedAnimationFileId) {
      return this.cachedAnimationFileId;
    }

    const url = (process.env.TELEGRAM_ALERT_ANIMATION_URL || (config as any).telegramAnimationUrl || '').trim();
    if (url && !url.startsWith('YOUR_') && (url.startsWith('https://') || url.startsWith('http://'))) {
      return url;
    }

    const customPath = (process.env.TELEGRAM_ALERT_ANIMATION_PATH || (config as any).telegramAnimationPath || '').trim();
    if (customPath && !customPath.startsWith('YOUR_')) {
      if (customPath === 'default' || customPath === 'auto') {
        return this.getLocalAnimationAssetPath();
      }
      if (fs.existsSync(customPath)) {
        return path.resolve(customPath);
      }
      const resolved = path.resolve(process.cwd(), customPath);
      if (fs.existsSync(resolved)) {
        return resolved;
      }
    }

    if (process.env.TELEGRAM_ENABLE_LOCAL_ANIMATION === 'true') {
      return this.getLocalAnimationAssetPath();
    }

    return null;
  }

  /**
   * Format any ISO date/timestamp into human-readable Indian Standard Time (IST)
   * with UTC reference.
   * Example: "28 Oct 2026, 03:50 PM IST (10:20 UTC)"
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
   * Safely truncate HTML text to within Telegram's 1024-character caption limit,
   * cleanly closing any opened tags to prevent Telegram HTML parse errors.
   */
  static truncateHtml(html: string, maxLen = 1024): string {
    if (!html || html.length <= maxLen) return html || '';

    // Slice to allow room for ellipsis and closing tags
    const targetSlice = html.slice(0, maxLen - 8).trim();

    // Identify open tags: <b>, <code>, <i>, <a>, <s>, <u>
    const openTags: string[] = [];
    const tagRegex = /<\/?([a-z0-9]+)(?:\s+[^>]*)?>/gi;
    let match;
    while ((match = tagRegex.exec(targetSlice)) !== null) {
      const isClosing = match[0].startsWith('</');
      const tagName = match[1].toLowerCase();
      if (isClosing) {
        if (openTags.length > 0 && openTags[openTags.length - 1] === tagName) {
          openTags.pop();
        }
      } else {
        openTags.push(tagName);
      }
    }

    let result = targetSlice;
    let closing = '...';
    for (let i = openTags.length - 1; i >= 0; i--) {
      closing += `</${openTags[i]}>`;
    }

    if ((result + closing).length > maxLen) {
      result = result.slice(0, maxLen - closing.length);
    }
    return result + closing;
  }

  /**
   * Generate standard interactive inline keyboard pointing to Admin ERP.
   * Validates target route to prevent open-redirect vulnerabilities.
   */
  static buildAdminErpKeyboard(customLabel?: string, routePath?: string): { inline_keyboard: TelegramInlineKeyboardButton[][] } {
    let targetUrl = this.ADMIN_ERP_URL;
    if (routePath) {
      const cleanRoute = routePath.trim();
      if (cleanRoute.startsWith('#/')) {
        targetUrl = `${this.ADMIN_ERP_URL}${cleanRoute}`;
      } else if (cleanRoute.startsWith('/#/')) {
        targetUrl = `${this.ADMIN_ERP_URL}${cleanRoute.substring(1)}`;
      } else if (cleanRoute.startsWith('#')) {
        targetUrl = `${this.ADMIN_ERP_URL}${cleanRoute}`;
      } else {
        targetUrl = `${this.ADMIN_ERP_URL}#/${cleanRoute.replace(/^\//, '')}`;
      }
    }

    // Safety assertion: URL must strictly start with the official Admin ERP base URL
    if (!targetUrl.startsWith(this.ADMIN_ERP_URL)) {
      targetUrl = this.ADMIN_ERP_URL;
    }

    return {
      inline_keyboard: [
        [
          {
            text: customLabel || '🛠️ Open Admin ERP',
            url: targetUrl
          }
        ]
      ]
    };
  }

  /**
   * Determine standardized category header.
   */
  static getCategoryHeader(category?: AlertCategory, title?: string, severity?: AlertSeverity): string {
    if (category === 'SECURITY') return '🔐 <b>HOME GROCERY | SECURITY ALERT</b>';
    if (category === 'MEMBER') return '👤 <b>HOME GROCERY | MEMBER ACTIVITY</b>';
    if (category === 'RECOVERY') return '🔄 <b>HOME GROCERY | RECOVERY & ACCESS</b>';
    if (category === 'WEBSITE') return '🌐 <b>HOME GROCERY | WEBSITE CONTROL</b>';
    if (category === 'RELEASE') return '🚀 <b>HOME GROCERY | RELEASE & SYSTEM</b>';
    if (category === 'CRITICAL' || severity === 'CRITICAL') return '🚨 <b>HOME GROCERY | CRITICAL SYSTEM ALERT</b>';

    // Inferred from title
    const t = (title || '').toUpperCase();
    if (t.includes('SECURITY') || t.includes('SUSPICIOUS') || t.includes('LOCK')) return '🔐 <b>HOME GROCERY | SECURITY ALERT</b>';
    if (t.includes('RECOVERY') || t.includes('REACTIVATION') || t.includes('PIN')) return '🔄 <b>HOME GROCERY | RECOVERY & ACCESS</b>';
    if (t.includes('WEBSITE') || t.includes('ANNOUNCEMENT')) return '🌐 <b>HOME GROCERY | WEBSITE CONTROL</b>';
    if (t.includes('RELEASE') || t.includes('BUILD') || t.includes('ROLLBACK')) return '🚀 <b>HOME GROCERY | RELEASE & SYSTEM</b>';
    if (t.includes('MEMBER') || t.includes('ACCOUNT')) return '👤 <b>HOME GROCERY | MEMBER ACTIVITY</b>';

    return '🔔 <b>HOME GROCERY | ADMIN ALERT</b>';
  }

  /**
   * Build premium structured message HTML with Home Grocery branding, category, and severity.
   */
  static formatMessageCard(params: {
    severity: AlertSeverity;
    title: string;
    category?: AlertCategory;
    referenceId?: string;
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

    const header = this.getCategoryHeader(params.category, params.title, params.severity);

    const lines: string[] = [
      header,
      severityBadge,
      '━━━━━━━━━━━━━━━━━━━━━━',
      `<b>${params.title}</b>`,
      ''
    ];

    if (params.referenceId) {
      lines.push(`<b>Reference ID:</b> <code>${this.escapeHtml(params.referenceId)}</code>`);
    }

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
    routePath?: string;
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
      ? this.buildAdminErpKeyboard(params.buttonLabel, params.routePath)
      : undefined;

    const animSource = this.getAnimationSource();

    // Try sending real animation if configured or local asset available
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
      routePath?: string;
    }
  ): Promise<TelegramNotificationResult> {
    return this.sendNotification({
      htmlMessage,
      deduplicationKey: options?.deduplicationKey,
      cooldownMs: options?.cooldownMs,
      includeErpButton: options?.includeErpButton,
      buttonLabel: options?.buttonLabel,
      routePath: options?.routePath
    });
  }

  /**
   * Real Telegram Bot API `sendAnimation` implementation with bounded retry and timeout.
   * Supports remote URLs, Telegram file_ids, and local binary multipart uploads.
   * Automatically extracts and caches returned `file_id` for zero-overhead subsequent calls.
   */
  private static async trySendAnimation(opts: {
    token: string;
    chatId: string;
    animSource: string;
    caption: string;
    replyMarkup?: any;
  }): Promise<{ sent: boolean }> {
    const endpoint = `https://api.telegram.org/bot${opts.token}/sendAnimation`;
    const safeCaption = this.truncateHtml(opts.caption, 1024);

    const isUrl = opts.animSource.startsWith('https://') || opts.animSource.startsWith('http://');
    const isLocalFile = fs.existsSync(opts.animSource) && !isUrl;

    let attempts = 0;
    const maxAttempts = 2;

    while (attempts < maxAttempts) {
      attempts++;
      try {
        let response: Response;

        if (isLocalFile) {
          const formData = new FormData();
          formData.append('chat_id', opts.chatId);
          const fileBuffer = fs.readFileSync(opts.animSource);
          const mimeType = opts.animSource.endsWith('.mp4') ? 'video/mp4' : 'image/gif';
          const fileName = path.basename(opts.animSource);
          const blob = new Blob([fileBuffer], { type: mimeType });
          formData.append('animation', blob, fileName);
          formData.append('caption', safeCaption);
          formData.append('parse_mode', 'HTML');
          if (opts.replyMarkup) {
            formData.append('reply_markup', JSON.stringify(opts.replyMarkup));
          }

          response = await fetch(endpoint, {
            method: 'POST',
            body: formData,
            signal: AbortSignal.timeout(this.DEFAULT_TIMEOUT_MS)
          });
        } else {
          const payload = JSON.stringify({
            chat_id: opts.chatId,
            animation: opts.animSource,
            caption: safeCaption,
            parse_mode: 'HTML',
            reply_markup: opts.replyMarkup
          });

          response = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: payload,
            signal: AbortSignal.timeout(this.DEFAULT_TIMEOUT_MS)
          });
        }

        if (response.ok) {
          try {
            const data = (await response.json()) as any;
            if (data?.result?.animation?.file_id) {
              this.cachedAnimationFileId = data.result.animation.file_id;
            }
          } catch {
            // Ignore parse errors on success
          }
          return { sent: true };
        }

        const status = response.status;
        if (status >= 400 && status < 500) {
          // Client error: invalid URL, file, or unsupported format, don't retry animation
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
  // Complete Lifecycle Notification Methods
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
      category: 'MEMBER',
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
      category: 'RECOVERY',
      title: 'PIN RECOVERY REQUEST SUBMITTED',
      referenceId: params.requestId,
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
      routePath: '#/recovery',
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
      category: 'RECOVERY',
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
      routePath: '#/accounts',
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
      category: 'RECOVERY',
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
      routePath: '#/audit-logs',
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
      category: 'RECOVERY',
      title: 'RECOVERY REQUEST CANCELLED',
      referenceId: params.requestId,
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
      routePath: '#/recovery',
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
      category: 'SECURITY',
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
      routePath: '#/recovery',
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
      category: 'RECOVERY',
      title: 'ACCOUNT REACTIVATION REQUEST SUBMITTED',
      referenceId: params.requestId,
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
      routePath: '#/recovery',
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
      category: 'SECURITY',
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
      routePath: '#/accounts',
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
      category: 'MEMBER',
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
      routePath: '#/audit-logs',
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
      category: 'RECOVERY',
      title: `${typeLabel.toUpperCase()} REQUEST ${params.decision}`,
      referenceId: params.requestId,
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
      routePath: '#/recovery',
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
      category: 'SECURITY',
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
      routePath: '#/accounts',
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
      category: 'CRITICAL',
      title: 'CRITICAL BACKEND ERROR ALERT',
      referenceId: `ERR-${params.errorType.slice(0, 8)}`,
      details: [
        { label: 'Error Type', value: `<code>${this.escapeHtml(params.errorType)}</code>` },
        { label: 'Endpoint', value: `<code>${this.escapeHtml(endpointStr)}</code>` },
        { label: 'Message', value: this.escapeHtml(safeMsg) },
        ...(params.userId ? [{ label: 'User ID', value: `<code>${this.escapeHtml(params.userId.slice(0, 8))}...</code>` }] : [])
      ],
      notes: 'Identical recurring errors are suppressed for 10 minutes to prevent alert flooding.'
    });

    const dedupKey = `ERR:${params.errorType}:${params.endpoint || 'general'}`;
    return this.sendNotification({
      htmlMessage: text,
      buttonLabel: '🚨 Inspect Health in Admin ERP',
      routePath: '#/diagnostics',
      deduplicationKey: dedupKey,
      cooldownMs: 600000 // 10 minutes deduplication
    });
  }

  /**
   * 13. Level 2 & Level 3 Suspicious Activity and Security Alert.
   */
  static async notifySuspiciousSecurityEvent(params: {
    eventType: string;
    severity: string;
    actionTaken: string;
    mobileNumber?: string | null;
    ipAddress?: string | null;
    endpoint?: string;
    details?: string;
    timestamp?: string;
  }): Promise<TelegramNotificationResult> {
    const isLevel3 = params.severity.includes('LEVEL_3') || params.severity.includes('HIGH');
    const maskedMobile = this.maskMobile(params.mobileNumber);
    const maskedIp = params.ipAddress ? this.escapeHtml(params.ipAddress.slice(0, 45)) : 'N/A';

    const text = this.formatMessageCard({
      severity: isLevel3 ? 'CRITICAL' : 'WARNING',
      category: 'SECURITY',
      title: isLevel3 ? 'CONFIRMED HIGH-RISK SECURITY ALERT' : 'SUSPICIOUS ACTIVITY DETECTED',
      referenceId: `SEC-${params.eventType.slice(0, 8)}`,
      details: [
        { label: 'Event Type', value: `<code>${this.escapeHtml(params.eventType)}</code>` },
        { label: 'Severity', value: `<b>${this.escapeHtml(params.severity)}</b>` },
        { label: 'Action Taken', value: `<code>${this.escapeHtml(params.actionTaken)}</code>` },
        { label: 'Target Account', value: maskedMobile },
        { label: 'Client IP', value: `<code>${maskedIp}</code>` },
        ...(params.endpoint ? [{ label: 'Endpoint', value: `<code>${this.escapeHtml(params.endpoint)}</code>` }] : []),
        ...(params.details ? [{ label: 'Details', value: this.escapeHtml(params.details.slice(0, 200)) }] : [])
      ],
      timestamp: params.timestamp,
      notes: 'Security policy enforced automatically. Review details in Admin ERP audit logs.'
    });

    const dedupKey = `SEC:${params.eventType}:${params.mobileNumber || 'anon'}:${params.ipAddress || 'unknown'}`;
    return this.sendNotification({
      htmlMessage: text,
      buttonLabel: '🛡️ Open Admin ERP Security',
      routePath: '#/audit-logs',
      deduplicationKey: dedupKey,
      cooldownMs: 60000 // 1 minute deduplication to prevent flooding
    });
  }

  /**
   * 14. Permanent Account Deletion
   */
  static async notifyAccountDeleted(params: {
    adminUserId: string;
    targetMobileNumber: string;
    targetFullName?: string | null;
    confirmationId?: string | null;
    cascadedTables?: Record<string, number>;
    reason?: string | null;
    timestamp?: string | null;
  }): Promise<TelegramNotificationResult> {
    const refId = params.confirmationId || `DEL-${Date.now().toString(36).toUpperCase()}`;
    const cascadedSummary = params.cascadedTables
      ? Object.entries(params.cascadedTables)
          .filter(([_, count]) => count > 0)
          .map(([tbl, count]) => `${tbl} (${count})`)
          .join(', ') || 'Cleaned 0 child records'
      : 'All account data cascaded';

    const text = this.formatMessageCard({
      severity: 'WARNING',
      category: 'MEMBER',
      title: 'PERMANENT ACCOUNT DELETION',
      referenceId: refId,
      accountReference: { mobile: params.targetMobileNumber, name: params.targetFullName },
      details: [
        { label: 'Action', value: 'Permanent Account & Data Purge' },
        { label: 'Authorized Admin', value: `<code>${this.escapeHtml(params.adminUserId)}</code>` },
        { label: 'Cascaded Tables', value: this.escapeHtml(cascadedSummary) }
      ],
      notes: params.reason || 'Account permanently deleted by administrator.',
      timestamp: params.timestamp
    });

    return this.sendNotification({
      htmlMessage: text,
      buttonLabel: '👥 Manage Accounts in ERP',
      routePath: '#/accounts',
      deduplicationKey: `DEL_ACC:${params.targetMobileNumber}`,
      cooldownMs: 30000
    });
  }

  /**
   * 15. Public Website Content Published
   */
  static async notifyWebsiteContentPublished(params: {
    adminUserId: string;
    revision: number;
    title: string;
    sectionsCount?: number;
    timestamp?: string | null;
  }): Promise<TelegramNotificationResult> {
    const text = this.formatMessageCard({
      severity: 'SUCCESS',
      category: 'WEBSITE',
      title: 'PUBLIC WEBSITE CONTENT PUBLISHED',
      referenceId: `WEB-REV-${params.revision}`,
      details: [
        { label: 'Live Revision', value: `<code>Revision ${params.revision}</code>` },
        { label: 'Published By', value: `<code>${this.escapeHtml(params.adminUserId)}</code>` },
        { label: 'Site Title', value: this.escapeHtml(params.title) },
        ...(params.sectionsCount !== undefined ? [{ label: 'Content Items', value: `${params.sectionsCount} sections/features` }] : [])
      ],
      notes: 'New content is immediately active on the public download website.',
      timestamp: params.timestamp
    });

    return this.sendNotification({
      htmlMessage: text,
      buttonLabel: '🌐 Open Website Control',
      routePath: '#/website-control',
      deduplicationKey: `WEB_PUB:${params.revision}`,
      cooldownMs: 30000
    });
  }

  /**
   * 16. Public Announcement Published
   */
  static async notifyAnnouncementPublished(params: {
    adminUserId: string;
    announcementId: string;
    title: string;
    titleMr?: string | null;
    category?: string;
    pinned?: boolean;
    timestamp?: string | null;
  }): Promise<TelegramNotificationResult> {
    const text = this.formatMessageCard({
      severity: 'SUCCESS',
      category: 'WEBSITE',
      title: 'PUBLIC ANNOUNCEMENT PUBLISHED',
      referenceId: `ANN-${params.announcementId.slice(0, 8).toUpperCase()}`,
      details: [
        { label: 'Title (EN)', value: this.escapeHtml(params.title) },
        ...(params.titleMr ? [{ label: 'Title (MR)', value: this.escapeHtml(params.titleMr) }] : []),
        { label: 'Category', value: `<code>${this.escapeHtml(params.category || 'GENERAL')}</code>` },
        { label: 'Published By', value: `<code>${this.escapeHtml(params.adminUserId)}</code>` }
      ],
      notes: 'Announcement is now visible in the Public Transparency & Activity Feed.',
      timestamp: params.timestamp
    });

    return this.sendNotification({
      htmlMessage: text,
      buttonLabel: '📢 View Announcements',
      routePath: '#/website-control',
      deduplicationKey: `ANN_PUB:${params.announcementId}`,
      cooldownMs: 30000
    });
  }

  /**
   * 17. Public Announcement Archived
   */
  static async notifyAnnouncementArchived(params: {
    adminUserId: string;
    announcementId: string;
    title: string;
    timestamp?: string | null;
  }): Promise<TelegramNotificationResult> {
    const text = this.formatMessageCard({
      severity: 'INFO',
      category: 'WEBSITE',
      title: 'PUBLIC ANNOUNCEMENT ARCHIVED',
      referenceId: `ANN-${params.announcementId.slice(0, 8).toUpperCase()}`,
      details: [
        { label: 'Title', value: this.escapeHtml(params.title) },
        { label: 'Archived By', value: `<code>${this.escapeHtml(params.adminUserId)}</code>` },
        { label: 'Public Status', value: 'Removed from Active Feed' }
      ],
      timestamp: params.timestamp
    });

    return this.sendNotification({
      htmlMessage: text,
      buttonLabel: '📢 Open Announcements Queue',
      routePath: '#/website-control',
      deduplicationKey: `ANN_ARCH:${params.announcementId}`,
      cooldownMs: 30000
    });
  }

  /**
   * 18. New Android Release Draft Created
   */
  static async notifyReleaseCreated(params: {
    adminUserId: string;
    releaseId: string;
    versionName: string;
    versionCode: number;
    channel?: string;
    timestamp?: string | null;
  }): Promise<TelegramNotificationResult> {
    const text = this.formatMessageCard({
      severity: 'INFO',
      category: 'RELEASE',
      title: 'NEW ANDROID RELEASE DRAFT CREATED',
      referenceId: `REL-${params.releaseId.slice(0, 8).toUpperCase()}`,
      details: [
        { label: 'Version', value: `<code>${this.escapeHtml(params.versionName)} (v${params.versionCode})</code>` },
        { label: 'Channel', value: `<code>${this.escapeHtml(params.channel || 'STABLE')}</code>` },
        { label: 'Created By', value: `<code>${this.escapeHtml(params.adminUserId)}</code>` },
        { label: 'Status', value: 'Draft / Awaiting Build or Verification' }
      ],
      notes: 'Requires verified SHA-256 APK artifact before public deployment.',
      timestamp: params.timestamp
    });

    return this.sendNotification({
      htmlMessage: text,
      buttonLabel: '🚀 View Release Center',
      routePath: '#/website-control',
      deduplicationKey: `REL_CREATE:${params.releaseId}`,
      cooldownMs: 30000
    });
  }

  /**
   * 19. Android Release Build Status Update
   */
  static async notifyReleaseBuildStatus(params: {
    adminUserId: string;
    releaseId: string;
    versionName: string;
    versionCode: number;
    status: string;
    notes?: string | null;
    timestamp?: string | null;
  }): Promise<TelegramNotificationResult> {
    const isFailed = params.status === 'FAILED';
    const text = this.formatMessageCard({
      severity: isFailed ? 'WARNING' : 'INFO',
      category: 'RELEASE',
      title: isFailed ? 'ANDROID RELEASE BUILD FAILED' : 'ANDROID BUILD WORKFLOW UPDATE',
      referenceId: `BLD-${params.releaseId.slice(0, 8).toUpperCase()}`,
      details: [
        { label: 'Version', value: `<code>${this.escapeHtml(params.versionName)} (v${params.versionCode})</code>` },
        { label: 'Build Status', value: `<b>${this.escapeHtml(params.status)}</b>` },
        { label: 'Initiated By', value: `<code>${this.escapeHtml(params.adminUserId)}</code>` }
      ],
      notes: params.notes || 'Automated Android build workflow progress update.',
      timestamp: params.timestamp
    });

    return this.sendNotification({
      htmlMessage: text,
      buttonLabel: '🚀 Inspect Build Status',
      routePath: '#/website-control',
      deduplicationKey: `REL_BLD:${params.releaseId}:${params.status}`,
      cooldownMs: 30000
    });
  }

  /**
   * Android APK Artifact Integrity Verified (SHA-256 Checksum)
   */
  static async notifyReleaseArtifactVerified(params: {
    adminUserId: string;
    releaseId: string;
    versionName: string;
    versionCode: number;
    apkSize: number;
    sha256: string;
    timestamp?: string | null;
  }): Promise<TelegramNotificationResult> {
    const text = this.formatMessageCard({
      severity: 'SUCCESS',
      category: 'RELEASE',
      title: 'ANDROID APK ARTIFACT VERIFIED',
      referenceId: `VRF-${params.releaseId.slice(0, 8).toUpperCase()}`,
      details: [
        { label: 'Release Version', value: `<code>${this.escapeHtml(params.versionName)} (v${params.versionCode})</code>` },
        { label: 'Artifact Size', value: `<code>${(params.apkSize / (1024 * 1024)).toFixed(2)} MB (${params.apkSize.toLocaleString()} bytes)</code>` },
        { label: 'SHA-256 Checksum', value: `<code>${this.escapeHtml(params.sha256.slice(0, 16))}...</code>` },
        { label: 'Verified By', value: `<code>${this.escapeHtml(params.adminUserId)}</code>` }
      ],
      notes: 'Cryptographic checksum and integrity verified successfully. Ready for live publication.',
      timestamp: params.timestamp
    });

    return this.sendNotification({
      htmlMessage: text,
      buttonLabel: '📦 View Release Pipeline',
      routePath: '#/website-control',
      deduplicationKey: `REL_VRF:${params.releaseId}`,
      cooldownMs: 30000
    });
  }

  /**
   * 20. Android Release Published to Production
   */
  static async notifyReleasePublished(params: {
    adminUserId: string;
    releaseId: string;
    versionName: string;
    versionCode: number;
    channel: string;
    apkDownloadUrl?: string | null;
    timestamp?: string | null;
  }): Promise<TelegramNotificationResult> {
    const text = this.formatMessageCard({
      severity: 'SUCCESS',
      category: 'RELEASE',
      title: 'ANDROID RELEASE PUBLISHED TO PRODUCTION',
      referenceId: `PUB-${params.releaseId.slice(0, 8).toUpperCase()}`,
      details: [
        { label: 'Live Version', value: `<code>${this.escapeHtml(params.versionName)} (v${params.versionCode})</code>` },
        { label: 'Distribution Channel', value: `<code>${this.escapeHtml(params.channel)}</code>` },
        { label: 'Published By', value: `<code>${this.escapeHtml(params.adminUserId)}</code>` },
        { label: 'Update Manifest', value: 'Published to /api/updates/manifest' },
        ...(params.apkDownloadUrl ? [{ label: 'Download URL', value: `<code>${this.escapeHtml(params.apkDownloadUrl)}</code>` }] : [])
      ],
      notes: 'New release is live for in-app updates and public web downloads.',
      timestamp: params.timestamp
    });

    return this.sendNotification({
      htmlMessage: text,
      buttonLabel: '🚀 Inspect Live Release',
      routePath: '#/website-control',
      deduplicationKey: `REL_PUB:${params.releaseId}`,
      cooldownMs: 30000
    });
  }

  /**
   * 21. Android Release Rollback Executed
   */
  static async notifyReleaseRollback(params: {
    adminUserId: string;
    rolledBackReleaseId: string;
    targetReleaseId: string;
    reason?: string | null;
    timestamp?: string | null;
  }): Promise<TelegramNotificationResult> {
    const text = this.formatMessageCard({
      severity: 'WARNING',
      category: 'RELEASE',
      title: 'EMERGENCY RELEASE ROLLBACK EXECUTED',
      referenceId: `ROL-${params.rolledBackReleaseId.slice(0, 8).toUpperCase()}`,
      details: [
        { label: 'Action', value: 'Production Release Rollback' },
        { label: 'Rolled Back ID', value: `<code>${this.escapeHtml(params.rolledBackReleaseId)}</code>` },
        { label: 'Reverted Target ID', value: `<code>${this.escapeHtml(params.targetReleaseId)}</code>` },
        { label: 'Executed By', value: `<code>${this.escapeHtml(params.adminUserId)}</code>` }
      ],
      notes: params.reason || 'Rollback executed by administrator to preserve system stability.',
      timestamp: params.timestamp
    });

    return this.sendNotification({
      htmlMessage: text,
      buttonLabel: '🚀 Open Release Center',
      routePath: '#/website-control',
      deduplicationKey: `REL_ROLLBACK:${params.rolledBackReleaseId}`,
      cooldownMs: 30000
    });
  }

  /**
   * 22. Critical Sync Failure Alert
   */
  static async notifySyncCriticalFailure(params: {
    userId?: string;
    errorCount: number;
    lastError: string;
    endpoint?: string;
    timestamp?: string | null;
  }): Promise<TelegramNotificationResult> {
    const text = this.formatMessageCard({
      severity: 'CRITICAL',
      category: 'CRITICAL',
      title: 'CRITICAL CLIENT SYNC FAILURE ALERT',
      referenceId: `SYNC-ERR-${Date.now().toString(36).toUpperCase()}`,
      details: [
        { label: 'Consecutive Errors', value: `<code>${params.errorCount}</code>` },
        { label: 'Service Endpoint', value: `<code>${this.escapeHtml(params.endpoint || '/api/sync')}</code>` },
        { label: 'Last Error Message', value: this.escapeHtml(params.lastError.slice(0, 200)) },
        ...(params.userId ? [{ label: 'Affected Account', value: `<code>${this.escapeHtml(params.userId.slice(0, 8))}...</code>` }] : [])
      ],
      notes: 'Sync processing experienced repeated failures. Automatic deduplication cooldown active.',
      timestamp: params.timestamp
    });

    return this.sendNotification({
      htmlMessage: text,
      buttonLabel: '🚨 Inspect Health in Admin ERP',
      routePath: '#/diagnostics',
      deduplicationKey: `SYNC_FAIL:${params.userId || 'global'}`,
      cooldownMs: 300000 // 5-minute cooldown
    });
  }
}
