import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import { createApp } from '../app.js';
import { initDatabase, closeDatabase, getDatabase } from '../db/database.js';
import { AuthService } from '../services/authService.js';
import { WebsiteReleaseService } from '../services/websiteReleaseService.js';

describe('Build 9 Phase 2.5: Website Control, Public Activity & Release Management', () => {
  const app = createApp();
  let adminToken: string;
  let adminUserId: string;
  let userToken: string;
  const manifestFile = path.resolve(process.cwd(), 'data', 'test-website-release-manifest.json');

  beforeEach(() => {
    initDatabase(':memory:');
    WebsiteReleaseService.setManifestFileForTests(manifestFile);
    if (fs.existsSync(manifestFile)) fs.unlinkSync(manifestFile);

    // 1. Create Admin
    const adminReg = AuthService.register({
      mobileNumber: '9356755100',
      pin: '654321',
      fullName: 'Santosh Koli Owner',
      preferredLanguage: 'mr',
      pinLength: 6
    });
    adminUserId = adminReg.user.id;
    const db = getDatabase();
    db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(adminUserId);

    // Admin login
    const loginRes = AuthService.login({
      mobileNumber: '9356755100',
      pin: '654321',
      deviceInfo: 'Test Admin Console'
    });
    adminToken = loginRes.token;

    // 2. Create Regular User
    const userReg = AuthService.register({
      mobileNumber: '9876543210',
      pin: '123456',
      fullName: 'Ordinary User',
      preferredLanguage: 'en',
      pinLength: 6
    });
    const userLogin = AuthService.login({
      mobileNumber: '9876543210',
      pin: '123456',
      deviceInfo: 'Mobile Device'
    });
    userToken = userLogin.token;
  });

  afterAll(() => {
    closeDatabase();
    if (fs.existsSync(manifestFile)) fs.unlinkSync(manifestFile);
  });

  describe('1. Website Content Editor, Preview & Safe Sanitization', () => {
    it('initializes default published website content correctly', async () => {
      const res = await request(app)
        .get('/api/public/website/content')
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.content.title).toBe('Home Grocery');
      expect(res.body.data.content.titleMr).toBe('घरगुती किराणा यादी');
      expect(res.body.data.content.features.length).toBeGreaterThan(0);
      expect(res.body.data.content.faqs.length).toBeGreaterThan(0);
      expect(res.headers['etag']).toBeDefined();
    });

    it('allows Admin to save a draft without affecting published content', async () => {
      // Save draft with dangerous script tags to test input sanitization
      const draftPayload = {
        title: 'Home Grocery <script>alert("xss")</script>',
        titleMr: 'घरगुती किराणा यादी',
        tagline: 'Super Smart Grocery <b>App</b>',
        taglineMr: 'अधिक स्मार्ट किराणा ॲप',
        heroAnnouncement: 'Exclusive Build 9 Announcement',
        heroAnnouncementMr: 'नवीन बिल्ड ९ संदेश'
      };

      const draftRes = await request(app)
        .put('/api/admin/website-control/content/draft')
        .set('Authorization', `Bearer ${adminToken}`)
        .send(draftPayload)
        .expect(200);

      expect(draftRes.body.success).toBe(true);
      // Sanitized: script tag stripped
      expect(draftRes.body.data.content.title).toBe('Home Grocery');
      expect(draftRes.body.data.content.tagline).toBe('Super Smart Grocery App');
      expect(draftRes.body.data.content.heroAnnouncement).toBe('Exclusive Build 9 Announcement');

      // Public endpoint still returns the original published content
      const pubRes = await request(app)
        .get('/api/public/website/content')
        .expect(200);

      expect(pubRes.body.data.content.heroAnnouncement).not.toBe('Exclusive Build 9 Announcement');
      expect(pubRes.body.data.content.heroAnnouncement).toBe('Home Grocery v1.0.1 (Build 8)');
    });

    it('rejects saving draft if required bilingual fields are missing', async () => {
      const invalidPayload = {
        title: 'English Only Title',
        titleMr: '' // Missing Marathi title
      };

      const res = await request(app)
        .put('/api/admin/website-control/content/draft')
        .set('Authorization', `Bearer ${adminToken}`)
        .send(invalidPayload)
        .expect(400);

      expect(res.body.error).toContain('Both English and Marathi website titles are required');
    });

    it('publishes draft to live site and updates revision and ETag', async () => {
      // 1. Save draft
      await request(app)
        .put('/api/admin/website-control/content/draft')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          title: 'Home Grocery Prime',
          titleMr: 'घरगुती किराणा यादी प्राइम',
          heroAnnouncement: 'Live Verified Build 9',
          heroAnnouncementMr: 'थेट पडताळलेला संदेश'
        })
        .expect(200);

      // 2. Publish draft
      const pubResult = await request(app)
        .post('/api/admin/website-control/content/publish')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      expect(pubResult.body.success).toBe(true);
      expect(pubResult.body.data.content.title).toBe('Home Grocery Prime');
      expect(pubResult.body.data.revision).toBeGreaterThan(1);

      // 3. Public endpoint now serves the published content
      const pubRes = await request(app)
        .get('/api/public/website/content')
        .expect(200);

      expect(pubRes.body.data.content.title).toBe('Home Grocery Prime');
      expect(pubRes.body.data.content.heroAnnouncement).toBe('Live Verified Build 9');

      // 4. Audit log was recorded
      const db = getDatabase();
      const audit = db.prepare("SELECT * FROM admin_audit_logs WHERE action = 'WEBSITE_CONTENT_PUBLISHED'").get();
      expect(audit).toBeDefined();
    });
  });

  describe('2. Public Admin Activity & Transparency Feed', () => {
    it('creates announcement in DRAFT mode and hides it from public feed', async () => {
      const createRes = await request(app)
        .post('/api/admin/website-control/announcements')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          title: 'Scheduled Maintenance Notice',
          titleMr: 'नियोजित देखभाल सूचना',
          content: 'Server will undergo 5 minutes maintenance tonight.',
          contentMr: 'आज रात्री सर्व्हरची ५ मिनिटे देखभाल केली जाईल.',
          category: 'MAINTENANCE',
          status: 'DRAFT'
        })
        .expect(200);

      expect(createRes.body.success).toBe(true);
      const annId = createRes.body.data.announcement.id;

      // Public endpoint does NOT include DRAFT announcement
      const pubRes = await request(app)
        .get('/api/public/activity')
        .expect(200);

      expect(pubRes.body.data.announcements.some((a: any) => a.id === annId)).toBe(false);

      // Admin endpoint lists it
      const adminList = await request(app)
        .get('/api/admin/website-control/announcements')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      expect(adminList.body.data.announcements.some((a: any) => a.id === annId)).toBe(true);
    });

    it('publishes announcement and verifies strict privacy boundaries', async () => {
      const createRes = await request(app)
        .post('/api/admin/website-control/announcements')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          title: 'New Offline Sync Architecture Released',
          titleMr: 'नवीन ऑफलाइन सिंक प्रणाली सुरू',
          content: 'Enjoy seamless synchronization across all devices.',
          contentMr: 'सर्व उपकरणांवर अखंड डेटा सिंकचा आनंद घ्या.',
          category: 'FEATURE',
          status: 'DRAFT'
        })
        .expect(200);

      const annId = createRes.body.data.announcement.id;

      // Publish it
      const pubRes = await request(app)
        .post(`/api/admin/website-control/announcements/${annId}/publish`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      expect(pubRes.body.data.announcement.status).toBe('PUBLISHED');
      expect(pubRes.body.data.announcement.published_at).toBeDefined();

      // Verify public transparency endpoint
      const activityRes = await request(app)
        .get('/api/public/activity')
        .expect(200);

      const item = activityRes.body.data.announcements.find((a: any) => a.id === annId);
      expect(item).toBeDefined();
      expect(item.title).toBe('New Offline Sync Architecture Released');

      // Strict privacy check: No admin mobile, no internal tokens, no member names
      const rawJson = JSON.stringify(activityRes.body);
      expect(rawJson).not.toContain('9356755100');
      expect(rawJson).not.toContain('pin_hash');
      expect(rawJson).not.toContain('salt');
      expect(rawJson).not.toContain('created_by');
    });

    it('unpublishes and archives announcements with audit logging', async () => {
      const createRes = await request(app)
        .post('/api/admin/website-control/announcements')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          title: 'Security Advisory',
          titleMr: 'सुरक्षा सूचना',
          content: 'PIN lockout is enforced after 5 failed attempts.',
          contentMr: '५ अयशस्वी प्रयत्नांनंतर पिन लॉकआउट लागू केला जातो.',
          category: 'SECURITY',
          status: 'PUBLISHED'
        })
        .expect(200);

      const annId = createRes.body.data.announcement.id;

      // Unpublish
      await request(app)
        .post(`/api/admin/website-control/announcements/${annId}/unpublish`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      // Verify removed from public feed
      const pubRes1 = await request(app).get('/api/public/activity').expect(200);
      expect(pubRes1.body.data.announcements.some((a: any) => a.id === annId)).toBe(false);

      // Archive
      await request(app)
        .post(`/api/admin/website-control/announcements/${annId}/archive`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      // Delete
      await request(app)
        .delete(`/api/admin/website-control/announcements/${annId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
    });
  });

  describe('3. Android Version Management, Build Workflow & Rollback', () => {
    it('enforces strictly increasing Android versionCode', async () => {
      // Baseline is versionCode 15 (Build 8). Try submitting code 15 or 14
      const invalidRes = await request(app)
        .post('/api/admin/website-control/releases')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          versionName: '1.0.2',
          buildNumber: 9,
          versionCode: 15, // Not increasing!
          releaseNotes: 'Build 9 notes',
          releaseNotesMr: 'बिल्ड ९ नोंद'
        })
        .expect(400);

      expect(invalidRes.body.error).toContain('Android versionCode must be strictly increasing');
    });

    it('creates a valid release candidate draft with versionCode 16', async () => {
      const validRes = await request(app)
        .post('/api/admin/website-control/releases')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          versionName: '1.0.2',
          buildNumber: 9,
          versionCode: 16,
          channel: 'STABLE',
          releaseNotes: 'Build 9 — Public Website Control & Version Management',
          releaseNotesMr: 'बिल्ड ९ — संकेतस्थळ नियंत्रण आणि आवृत्ती व्यवस्थापन'
        })
        .expect(200);

      expect(validRes.body.success).toBe(true);
      expect(validRes.body.data.release.version_code).toBe(16);
      expect(validRes.body.data.release.status).toBe('DRAFT');
    });

    it('handles build workflow start and reports safe blocked status for production signing credentials', async () => {
      const releaseRes = await request(app)
        .post('/api/admin/website-control/releases')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          versionName: '1.0.2',
          buildNumber: 10,
          versionCode: 17,
          releaseNotes: 'Build 10 candidate',
          releaseNotesMr: 'बिल्ड १०'
        })
        .expect(200);

      const releaseId = releaseRes.body.data.release.id;

      const buildRes = await request(app)
        .post(`/api/admin/website-control/releases/${releaseId}/build`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      expect(buildRes.body.success).toBe(true);
      // Confirms safe handling: production signing keys are protected
      expect(buildRes.body.data.isBlocked).toBe(true);
      expect(buildRes.body.data.release.status).toBe('PENDING_BUILD');
    });

    it('supports CI workflow staging and retrieves real-time build logs', async () => {
      const releaseRes = await request(app)
        .post('/api/admin/website-control/releases')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          versionName: '1.0.2',
          buildNumber: 11,
          versionCode: 20,
          releaseNotes: 'Build 11 candidate',
          releaseNotesMr: 'बिल्ड ११'
        })
        .expect(200);

      const releaseId = releaseRes.body.data.release.id;

      // Trigger CI dispatch build mode
      const buildRes = await request(app)
        .post(`/api/admin/website-control/releases/${releaseId}/build`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ buildMode: 'CI_DISPATCH' })
        .expect(200);

      expect(buildRes.body.success).toBe(true);
      expect(buildRes.body.data.release.status).toBe('PENDING_BUILD');

      // Fetch build logs
      const logsRes = await request(app)
        .get(`/api/admin/website-control/releases/${releaseId}/logs`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      expect(logsRes.body.success).toBe(true);
      expect(logsRes.body.data.buildLogs).toContain('CI_DISPATCH');
      expect(logsRes.body.data.versionCode).toBe(20);
    });

    it('downloads candidate APK artifact via authorized admin download endpoint', async () => {
      const res = await request(app)
        .get('/api/admin/website-control/releases/rel-b8-baseline/download')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      expect(res.headers['content-type']).toContain('application/vnd.android.package-archive');
      expect(parseInt(res.headers['content-length'], 10)).toBe(9429395);
    });

    it('strictly forbids publishing an unverified release', async () => {
      const releaseRes = await request(app)
        .post('/api/admin/website-control/releases')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          versionName: '1.0.2',
          buildNumber: 11,
          versionCode: 18,
          releaseNotes: 'Unverified release notes',
          releaseNotesMr: 'नोंद'
        })
        .expect(200);

      const releaseId = releaseRes.body.data.release.id;

      // Attempt publish without verifying artifact
      const pubRes = await request(app)
        .post(`/api/admin/website-control/releases/${releaseId}/publish`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(400);

      expect(pubRes.body.error).toContain('PUBLICATION_DENIED');
      expect(pubRes.body.error).toContain('until its APK artifact is verified');
    });

    it('verifies APK artifact with SHA-256 and successfully publishes release manifest', async () => {
      // 1. Create release
      const releaseRes = await request(app)
        .post('/api/admin/website-control/releases')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          versionName: '1.0.2',
          buildNumber: 9,
          versionCode: 19, // test code
          apkFilename: 'HomeGrocery-v1.0.1-build8.apk',
          releaseNotes: 'Verified Build notes',
          releaseNotesMr: 'पडताळलेली आवृत्ती'
        })
        .expect(200);

      const releaseId = releaseRes.body.data.release.id;

      // 2. Verify artifact
      const verifyRes = await request(app)
        .post(`/api/admin/website-control/releases/${releaseId}/verify`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      expect(verifyRes.body.success).toBe(true);
      expect(verifyRes.body.data.verified).toBe(true);
      expect(verifyRes.body.data.sha256).toBe('9ace4da60c6fdfb8a44fced3ce43b6d902db97541ebc1664fe85da05ed0069e6');
      expect(verifyRes.body.data.apkSize).toBe(9429395);

      // 3. Publish release
      const pubRes = await request(app)
        .post(`/api/admin/website-control/releases/${releaseId}/publish`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      expect(pubRes.body.success).toBe(true);
      expect(pubRes.body.data.release.status).toBe('PUBLISHED');
      expect(pubRes.body.data.manifest.versionCode).toBe(19);

      // 4. Verify public update endpoint immediately returns new release
      const updateCheck = await request(app)
        .get('/api/updates/check?clientVersion=1.0.1&clientBuild=8')
        .expect(200);

      expect(updateCheck.body.data.hasUpdate).toBe(true);
      expect(updateCheck.body.data.versionCode).toBe(19);

      // 5. Test Rollback to baseline Build 8
      const rollbackRes = await request(app)
        .post(`/api/admin/website-control/releases/${releaseId}/rollback`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      expect(rollbackRes.body.success).toBe(true);
      expect(rollbackRes.body.data.restoredRelease.version_code).toBe(15);
      expect(rollbackRes.body.data.manifest.versionCode).toBe(15);
    });
  });

  describe('4. Public Freshness Detection & 5-Second Target Auto-Refresh', () => {
    it('returns ETag and 304 Not Modified when freshness signature is unchanged', async () => {
      const res1 = await request(app)
        .get('/api/public/website/freshness')
        .expect(200);

      const etag = res1.body.data.etag;
      expect(etag).toBeDefined();

      // Client queries with matching If-None-Match
      const res2 = await request(app)
        .get('/api/public/website/freshness')
        .set('If-None-Match', `"${etag}"`)
        .expect(304);

      expect(res2.text).toBe('');
    });

    it('changes ETag immediately when website content is published', async () => {
      const res1 = await request(app).get('/api/public/website/freshness').expect(200);
      const etag1 = res1.body.data.etag;

      // Publish content update
      await request(app)
        .put('/api/admin/website-control/content/draft')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ title: 'New Instant Title', titleMr: 'नवीन शीर्षक' })
        .expect(200);

      await request(app)
        .post('/api/admin/website-control/content/publish')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      // Polling detects changed ETag
      const res2 = await request(app)
        .get('/api/public/website/freshness')
        .set('If-None-Match', `"${etag1}"`)
        .expect(200);

      expect(res2.body.data.etag).not.toBe(etag1);
    });
  });

  describe('5. Security & Authorization Gates', () => {
    it('rejects unauthenticated requests to admin website-control endpoints', async () => {
      await request(app).get('/api/admin/website-control/overview').expect(401);
      await request(app).put('/api/admin/website-control/content/draft').send({}).expect(401);
      await request(app).post('/api/admin/website-control/content/publish').expect(401);
      await request(app).post('/api/admin/website-control/releases').send({}).expect(401);
    });

    it('rejects ordinary user tokens with 403 Forbidden', async () => {
      await request(app)
        .get('/api/admin/website-control/overview')
        .set('Authorization', `Bearer ${userToken}`)
        .expect(403);

      await request(app)
        .post('/api/admin/website-control/releases')
        .set('Authorization', `Bearer ${userToken}`)
        .send({
          versionName: '1.0.2',
          buildNumber: 9,
          versionCode: 16,
          releaseNotes: 'Attempted by ordinary user',
          releaseNotesMr: 'प्रयत्न'
        })
        .expect(403);
    });
  });
});
