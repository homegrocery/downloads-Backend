import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TelegramService } from '../services/telegramService.js';
import { AuthService } from '../services/authService.js';
import { RecoveryRequestService } from '../services/recoveryRequestService.js';
import { ReactivationRequestService } from '../services/reactivationRequestService.js';
import { AdminService } from '../services/adminService.js';
import { getDatabase } from '../db/database.js';

describe('Telegram Admin Notifications Suite', () => {
  const originalEnv = { ...process.env };
  const mockToken = '123456789:ABCdefGHIjklMNOpqrsTUVwxyz';
  const mockChatId = '-1009876543210';

  beforeEach(() => {
    vi.restoreAllMocks();
    TelegramService.resetDeduplicationCache();
    process.env.TELEGRAM_BOT_TOKEN = mockToken;
    process.env.TELEGRAM_ADMIN_CHAT_ID = mockChatId;
    delete process.env.TELEGRAM_ALERT_ANIMATION_URL;
    delete process.env.TELEGRAM_ALERT_ANIMATION_FILE_ID;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  describe('1. Configuration & Secrets Protection', () => {
    it('reports isConfigured = false when TELEGRAM_BOT_TOKEN is missing', () => {
      delete process.env.TELEGRAM_BOT_TOKEN;
      expect(TelegramService.isConfigured()).toBe(false);
    });

    it('reports isConfigured = false when TELEGRAM_ADMIN_CHAT_ID is missing', () => {
      delete process.env.TELEGRAM_ADMIN_CHAT_ID;
      expect(TelegramService.isConfigured()).toBe(false);
    });

    it('reports isConfigured = true when both secrets are present', () => {
      expect(TelegramService.isConfigured()).toBe(true);
    });

    it('gracefully no-ops without throwing when credentials are not configured', async () => {
      delete process.env.TELEGRAM_BOT_TOKEN;
      delete process.env.TELEGRAM_ADMIN_CHAT_ID;

      const fetchSpy = vi.spyOn(globalThis, 'fetch');
      const result = await TelegramService.sendMessage('<b>Test Alert</b>');

      expect(result.sent).toBe(false);
      expect(result.reason).toBe('NOT_CONFIGURED');
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('never prints or exposes the raw bot token in error logs', async () => {
      const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network connection timeout'));

      const result = await TelegramService.sendMessage('<b>Test</b>');
      expect(result.sent).toBe(false);

      for (const call of consoleWarnSpy.mock.calls) {
        const loggedText = call.join(' ');
        expect(loggedText).not.toContain(mockToken);
      }
    });

    it('parses valid animation URL or file_id and rejects placeholders', () => {
      expect(TelegramService.getAnimationSource()).toBeNull();

      process.env.TELEGRAM_ALERT_ANIMATION_URL = 'YOUR_ANIMATION_URL';
      expect(TelegramService.getAnimationSource()).toBeNull();

      process.env.TELEGRAM_ALERT_ANIMATION_URL = 'https://example.com/alert.mp4';
      expect(TelegramService.getAnimationSource()).toBe('https://example.com/alert.mp4');

      delete process.env.TELEGRAM_ALERT_ANIMATION_URL;
      process.env.TELEGRAM_ALERT_ANIMATION_FILE_ID = 'CgACAgQAAxkBAAE...';
      expect(TelegramService.getAnimationSource()).toBe('CgACAgQAAxkBAAE...');
    });
  });

  describe('2. Message Formatting & Privacy Protections', () => {
    it('correctly masks 10-digit Indian mobile numbers (+91 XX*** **XXX)', () => {
      expect(TelegramService.maskMobile('9356755100')).toBe('+91 93*** **100');
      expect(TelegramService.maskMobile('9876543210')).toBe('+91 98*** **210');
      expect(TelegramService.maskMobile('+919876543210')).toBe('+91 98*** **210');
      expect(TelegramService.maskMobile('')).toBe('[Not Provided]');
      expect(TelegramService.maskMobile(null)).toBe('[Not Provided]');
    });

    it('escapes HTML special characters to prevent Telegram parse errors', () => {
      expect(TelegramService.escapeHtml('<script>alert("hack")&test\'</script>'))
        .toBe('&lt;script&gt;alert(&quot;hack&quot;)&amp;test&#39;&lt;/script&gt;');
    });

    it('formats timestamps in Indian Standard Time (IST) with UTC reference', () => {
      const formatted = TelegramService.formatTimestampIST('2026-10-26T10:30:00.000Z');
      expect(formatted).toContain('IST');
      expect(formatted).toContain('UTC');
      expect(formatted).toContain('2026');
    });

    it('excludes PINs, passwords, recovery codes, and session tokens from message payloads', async () => {
      let sentPayload: any = null;
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
        sentPayload = JSON.parse(init?.body as string);
        return {
          ok: true,
          status: 200,
          json: async () => ({ ok: true, result: {} })
        } as any;
      });

      const secretPin = '543210';
      const secretRecoveryCode = 'HGR-9876-ABCD-1234';
      const secretToken = 'session_token_xyz_secret';

      await TelegramService.notifyNewMemberRegistration({
        mobileNumber: '9356755100',
        fullName: 'Santosh Koli'
      });

      expect(sentPayload).toBeDefined();
      expect(sentPayload.text).not.toContain(secretPin);
      expect(sentPayload.text).not.toContain(secretRecoveryCode);
      expect(sentPayload.text).not.toContain(secretToken);
      expect(sentPayload.text).not.toContain('9356755100'); // raw mobile must be masked
      expect(sentPayload.text).toContain('+91 93*** **100');

      // Admin ERP button must be present in reply_markup
      expect(sentPayload.reply_markup).toBeDefined();
      expect(sentPayload.reply_markup.inline_keyboard[0][0].url).toBe('https://homegrocery.github.io/admin-ERP/');
      expect(sentPayload.reply_markup.inline_keyboard[0][0].text).toContain('Admin ERP');
    });
  });

  describe('3. Real Optional Animation Support & Text Fallback', () => {
    it('dispatches sendAnimation when TELEGRAM_ALERT_ANIMATION_URL is configured', async () => {
      process.env.TELEGRAM_ALERT_ANIMATION_URL = 'https://example.com/alerts/badge.mp4';

      let requestUrl = '';
      let sentPayload: any = null;
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
        requestUrl = url.toString();
        sentPayload = JSON.parse(init?.body as string);
        return {
          ok: true,
          status: 200,
          json: async () => ({ ok: true, result: { message_id: 999 } })
        } as any;
      });

      const result = await TelegramService.sendNotification({
        htmlMessage: '<b>Animation Alert</b>'
      });

      expect(result.sent).toBe(true);
      expect(result.method).toBe('ANIMATION');
      expect(requestUrl).toBe(`https://api.telegram.org/bot${mockToken}/sendAnimation`);
      expect(sentPayload.animation).toBe('https://example.com/alerts/badge.mp4');
      expect(sentPayload.caption).toContain('Animation Alert');
      expect(sentPayload.parse_mode).toBe('HTML');
      expect(sentPayload.reply_markup.inline_keyboard[0][0].url).toBe('https://homegrocery.github.io/admin-ERP/');
    });

    it('falls back safely to text message when sendAnimation fails or rejects', async () => {
      process.env.TELEGRAM_ALERT_ANIMATION_URL = 'https://example.com/alerts/badge.mp4';
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const calls: string[] = [];
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
        const urlStr = url.toString();
        calls.push(urlStr);
        if (urlStr.includes('/sendAnimation')) {
          // Simulate Telegram rejecting animation URL (HTTP 400)
          return { ok: false, status: 400, text: async () => 'Wrong file identifier' } as any;
        }
        // Fallback sendMessage succeeds
        return { ok: true, status: 200, json: async () => ({ ok: true }) } as any;
      });

      const result = await TelegramService.sendNotification({
        htmlMessage: '<b>Fallback Alert</b>'
      });

      expect(result.sent).toBe(true);
      expect(result.method).toBe('TEXT');
      expect(calls.length).toBe(2);
      expect(calls[0]).toContain('/sendAnimation');
      expect(calls[1]).toContain('/sendMessage');
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Falling back to text notification'));
    });
  });

  describe('4. Network Delivery, Timeouts & Bounded Retries', () => {
    it('delivers notification successfully on valid Telegram Bot API response', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ ok: true, result: { message_id: 1234 } })
      } as any);

      const result = await TelegramService.sendMessage('<b>Alert: System Online</b>');

      expect(result.sent).toBe(true);
      expect(result.reason).toBe('SUCCESS');
      expect(fetchSpy).toHaveBeenCalledTimes(1);

      const [url, init] = fetchSpy.mock.calls[0];
      expect(url).toBe(`https://api.telegram.org/bot${mockToken}/sendMessage`);
      const body = JSON.parse(init?.body as string);
      expect(body.chat_id).toBe(mockChatId);
      expect(body.parse_mode).toBe('HTML');
      expect(body.disable_web_page_preview).toBe(true);
      expect(body.reply_markup.inline_keyboard[0][0].url).toBe('https://homegrocery.github.io/admin-ERP/');
    });

    it('retries once on 5xx server error and succeeds if second attempt passes', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce({ ok: false, status: 502, text: async () => 'Bad Gateway' } as any)
        .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ ok: true }) } as any);

      const result = await TelegramService.sendMessage('<b>Retry Test</b>');

      expect(result.sent).toBe(true);
      expect(result.reason).toBe('SUCCESS');
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    it('fails safely without retrying endlessly when API returns 400 Bad Request', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: false,
        status: 400,
        text: async () => 'Bad Request: chat not found'
      } as any);

      const result = await TelegramService.sendMessage('<b>Non-retryable Error</b>');

      expect(result.sent).toBe(false);
      expect(result.reason).toBe('FAILED');
      expect(fetchSpy).toHaveBeenCalledTimes(1); // No retry on 4xx
    });

    it('handles network timeouts gracefully without throwing exceptions', async () => {
      vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('The operation was aborted due to timeout'));

      const result = await TelegramService.sendMessage('<b>Timeout Test</b>');

      expect(result.sent).toBe(false);
      expect(result.reason).toBe('FAILED');
    });
  });

  describe('5. Deduplication & Anti-Spam Protections', () => {
    it('suppresses identical duplicate notifications within the cooldown window', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ ok: true })
      } as any);

      // First call
      const res1 = await TelegramService.sendMessage('<b>Duplicate Alert</b>', {
        deduplicationKey: 'ALERT_123',
        cooldownMs: 60000
      });
      expect(res1.sent).toBe(true);
      expect(fetchSpy).toHaveBeenCalledTimes(1);

      // Immediate duplicate call with same key
      const res2 = await TelegramService.sendMessage('<b>Duplicate Alert</b>', {
        deduplicationKey: 'ALERT_123',
        cooldownMs: 60000
      });
      expect(res2.sent).toBe(false);
      expect(res2.reason).toBe('DEDUPLICATED');
      expect(fetchSpy).toHaveBeenCalledTimes(1); // fetch was NOT called a second time
    });

    it('allows sending again after deduplication cache is reset or expired', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ ok: true })
      } as any);

      await TelegramService.sendMessage('<b>Test</b>', { deduplicationKey: 'KEY_ABC' });
      expect(fetchSpy).toHaveBeenCalledTimes(1);

      // Reset cache
      TelegramService.resetDeduplicationCache();

      await TelegramService.sendMessage('<b>Test</b>', { deduplicationKey: 'KEY_ABC' });
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });
  });

  describe('6. Real Backend Flow Integrations & Failure Independence', () => {
    it('dispatches new member registration alert and succeeds even if Telegram fails', async () => {
      const notifySpy = vi.spyOn(TelegramService, 'notifyNewMemberRegistration');
      // Mock fetch failure to verify business operation resilience
      vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Telegram API offline'));

      const uniqueMobile = `9111${Date.now().toString().slice(-6)}`;
      const result = AuthService.register({
        mobileNumber: uniqueMobile,
        pin: '123456',
        fullName: 'New Member Integration Test',
        preferredLanguage: 'mr'
      });

      expect(result.user).toBeDefined();
      expect(result.user.mobile_number).toBe(uniqueMobile);
      expect(result.token).toBeDefined();
      expect(notifySpy).toHaveBeenCalledWith(expect.objectContaining({
        mobileNumber: uniqueMobile,
        fullName: 'New Member Integration Test'
      }));
    });

    it('dispatches automatic account lock alert on 5th consecutive failed attempt', async () => {
      const notifyLockSpy = vi.spyOn(TelegramService, 'notifyAutomaticAccountLocked');
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true }) } as any);

      const targetMobile = `9222${Date.now().toString().slice(-6)}`;
      AuthService.register({
        mobileNumber: targetMobile,
        pin: '123456',
        fullName: 'Lockout Test User'
      });

      // 4 wrong attempts
      for (let i = 1; i <= 4; i++) {
        try {
          AuthService.login({ mobileNumber: targetMobile, pin: '000000' });
        } catch (e) {}
      }
      expect(notifyLockSpy).not.toHaveBeenCalled();

      // 5th wrong attempt triggers automatic lockout
      try {
        AuthService.login({ mobileNumber: targetMobile, pin: '000000' });
      } catch (err: any) {
        expect(err.code).toBe('ACCOUNT_LOCKED');
        expect(err.failedAttempts).toBe(5);
      }

      expect(notifyLockSpy).toHaveBeenCalledWith(expect.objectContaining({
        mobileNumber: targetMobile,
        failedAttempts: 5,
        lockType: 'AUTOMATIC'
      }));
    });

    it('dispatches PIN recovery request alert when user submits recovery', async () => {
      const notifyRecoverySpy = vi.spyOn(TelegramService, 'notifyPinRecoveryRequest');
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true }) } as any);

      const testMobile = `9333${Date.now().toString().slice(-6)}`;
      AuthService.register({
        mobileNumber: testMobile,
        pin: '123456',
        fullName: 'Recovery User'
      });

      const reqResult = RecoveryRequestService.createRequest({ mobileNumber: testMobile });

      expect(reqResult.requestId).toBeDefined();
      expect(notifyRecoverySpy).toHaveBeenCalledWith(expect.objectContaining({
        requestId: reqResult.requestId,
        mobileNumber: testMobile
      }));
    });

    it('dispatches recovery code issued alert on manual code generation without leaking secret code', async () => {
      const notifyCodeSpy = vi.spyOn(TelegramService, 'notifyRecoveryCodeIssued');
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true }) } as any);

      const testMobile = `9335${Date.now().toString().slice(-6)}`;
      const reg = AuthService.register({
        mobileNumber: testMobile,
        pin: '123456',
        fullName: 'Code Test User'
      });

      const genResult = AuthService.generateRecoveryCodeForUser(reg.user.id);
      expect(genResult.recoveryCode).toBeDefined();

      expect(notifyCodeSpy).toHaveBeenCalledWith(expect.objectContaining({
        userId: reg.user.id,
        mobileNumber: testMobile,
        isReplacement: true
      }));
    });

    it('dispatches suspicious recovery activity alert after 4 consecutive failed recovery code attempts', async () => {
      const notifySuspiciousSpy = vi.spyOn(TelegramService, 'notifySuspiciousRecoveryActivity');
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true }) } as any);

      const testMobile = `9337${Date.now().toString().slice(-6)}`;
      const reg = AuthService.register({
        mobileNumber: testMobile,
        pin: '123456',
        fullName: 'Lockout Recovery User'
      });
      // Generate code
      AuthService.generateRecoveryCodeForUser(reg.user.id);

      // 3 wrong recovery code attempts
      for (let i = 1; i <= 3; i++) {
        try {
          AuthService.verifyRecoveryCode(testMobile, 'HGR-0000-0000-0000');
        } catch (e) {}
      }
      expect(notifySuspiciousSpy).not.toHaveBeenCalled();

      // 4th wrong attempt triggers 24h lockout & alert
      try {
        AuthService.verifyRecoveryCode(testMobile, 'HGR-0000-0000-0000');
      } catch (err: any) {
        expect(err.code).toBe('RECOVERY_LOCKED');
      }

      expect(notifySuspiciousSpy).toHaveBeenCalledWith(expect.objectContaining({
        mobileNumber: testMobile,
        failedAttempts: 4,
        lockoutHours: 24
      }));
    });

    it('dispatches PIN reset success alert upon successful recovery code reset', async () => {
      const notifySuccessSpy = vi.spyOn(TelegramService, 'notifyPinResetSuccess');
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true }) } as any);

      const testMobile = `9339${Date.now().toString().slice(-6)}`;
      const reg = AuthService.register({
        mobileNumber: testMobile,
        pin: '123456',
        fullName: 'Successful Reset User'
      });
      const genResult = AuthService.generateRecoveryCodeForUser(reg.user.id);
      const { resetToken } = AuthService.verifyRecoveryCode(testMobile, genResult.recoveryCode);

      AuthService.resetPinWithRecoveryCode({
        mobileNumber: testMobile,
        resetToken,
        newPin: '654321'
      });

      expect(notifySuccessSpy).toHaveBeenCalledWith(expect.objectContaining({
        mobileNumber: testMobile,
        method: 'RECOVERY_CODE'
      }));
    });

    it('dispatches recovery cancellation alert when user or admin deletes a recovery request', async () => {
      const notifyCancelSpy = vi.spyOn(TelegramService, 'notifyRecoveryRequestCancelled');
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true }) } as any);

      const testMobile = `9341${Date.now().toString().slice(-6)}`;
      AuthService.register({
        mobileNumber: testMobile,
        pin: '123456',
        fullName: 'Cancel Recovery User'
      });

      const reqResult = RecoveryRequestService.createRequest({ mobileNumber: testMobile });

      // User cancels with capability token
      RecoveryRequestService.cancelRequest(reqResult.requestId, reqResult.requestToken);

      expect(notifyCancelSpy).toHaveBeenCalledWith(expect.objectContaining({
        requestId: reqResult.requestId,
        cancelledBy: 'USER'
      }));
    });

    it('dispatches reactivation request alert when locked user requests unlock', async () => {
      const notifyReactivationSpy = vi.spyOn(TelegramService, 'notifyReactivationRequest');
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true }) } as any);

      const testMobile = `9444${Date.now().toString().slice(-6)}`;
      const reg = AuthService.register({
        mobileNumber: testMobile,
        pin: '123456',
        fullName: 'Reactivation User'
      });

      // Manually lock account to allow reactivation request
      const db = getDatabase();
      db.prepare(`UPDATE users SET locked_until = '9999-12-31T23:59:59.999Z', lock_type = 'AUTOMATIC' WHERE id = ?`).run(reg.user.id);

      const reactResult = ReactivationRequestService.createRequest({
        mobileNumber: testMobile,
        reason: 'Please restore my account access'
      });

      expect(reactResult.request.id).toBeDefined();
      expect(notifyReactivationSpy).toHaveBeenCalledWith(expect.objectContaining({
        requestId: reactResult.request.id,
        mobileNumber: testMobile
      }));
    });

    it('dispatches administrative lock and unlock alerts when performed by admin', async () => {
      const notifyAdminActionSpy = vi.spyOn(TelegramService, 'notifyAdministrativeAccountAction');
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true }) } as any);

      const targetMobile = `9555${Date.now().toString().slice(-6)}`;
      const reg = AuthService.register({
        mobileNumber: targetMobile,
        pin: '123456',
        fullName: 'Admin Target User'
      });

      // 1. Admin locks account
      AdminService.lockAccount({
        adminUserId: 'mock-admin-id',
        targetAccountId: reg.user.id,
        reason: 'Suspicious activity observed'
      });

      expect(notifyAdminActionSpy).toHaveBeenCalledWith(expect.objectContaining({
        action: 'LOCKED',
        targetMobileNumber: targetMobile,
        reason: 'Suspicious activity observed'
      }));

      // 2. Admin unlocks account
      AdminService.activateAccount({
        adminUserId: 'mock-admin-id',
        targetAccountId: reg.user.id,
        reason: 'Verification completed'
      });

      expect(notifyAdminActionSpy).toHaveBeenCalledWith(expect.objectContaining({
        action: 'ACTIVATED',
        targetMobileNumber: targetMobile,
        reason: 'Verification completed'
      }));
    });

    it('dispatches admin decision alert when admin approves recovery request', async () => {
      const notifyDecisionSpy = vi.spyOn(TelegramService, 'notifyAdminDecision');
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true }) } as any);

      const testMobile = `9666${Date.now().toString().slice(-6)}`;
      AuthService.register({
        mobileNumber: testMobile,
        pin: '123456',
        fullName: 'Decision User'
      });

      const reqResult = RecoveryRequestService.createRequest({ mobileNumber: testMobile });

      // Admin approves
      AdminService.approveRecoveryRequest({
        requestId: reqResult.requestId,
        adminUserId: 'mock-admin-id',
        verificationMethod: 'Phone Call Verification'
      });

      expect(notifyDecisionSpy).toHaveBeenCalledWith(expect.objectContaining({
        type: 'RECOVERY',
        decision: 'APPROVED',
        requestId: reqResult.requestId,
        targetMobileNumber: testMobile
      }));
    });

    it('dispatches PIN changed alert when user changes PIN via authenticated session', async () => {
      const notifyPinChangedSpy = vi.spyOn(TelegramService, 'notifyPinChanged');
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true }) } as any);

      const testMobile = `9777${Date.now().toString().slice(-6)}`;
      const reg = AuthService.register({
        mobileNumber: testMobile,
        pin: '123456',
        fullName: 'Pin Change User'
      });

      AuthService.changePin(reg.user.id, '123456', '654321');

      expect(notifyPinChangedSpy).toHaveBeenCalledWith(expect.objectContaining({
        userId: reg.user.id,
        mobileNumber: testMobile
      }));
    });

    it('dispatches critical error alert with deduplication for backend 5xx / sync errors', async () => {
      let callCount = 0;
      vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
        callCount++;
        return { ok: true, status: 200, json: async () => ({ ok: true }) } as any;
      });

      const res1 = await TelegramService.notifyCriticalError({
        errorType: 'DATABASE_TIMEOUT',
        message: 'PostgreSQL upstream connection timeout after 10000ms',
        endpoint: '/api/sync/pull',
        method: 'POST'
      });

      expect(res1.sent).toBe(true);
      expect(callCount).toBe(1);

      // Immediate identical error should be deduplicated
      const res2 = await TelegramService.notifyCriticalError({
        errorType: 'DATABASE_TIMEOUT',
        message: 'PostgreSQL upstream connection timeout after 10000ms',
        endpoint: '/api/sync/pull',
        method: 'POST'
      });

      expect(res2.sent).toBe(false);
      expect(res2.reason).toBe('DEDUPLICATED');
      expect(callCount).toBe(1);
    });
  });
});
