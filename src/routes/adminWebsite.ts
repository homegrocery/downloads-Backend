import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { requireAdmin, type AuthenticatedRequest } from '../middleware/auth.js';
import { WebsiteReleaseService } from '../services/websiteReleaseService.js';
import { AdminService } from '../services/adminService.js';

export const adminWebsiteRouter = Router();

// All routes require authoritative Owner Admin authorization
adminWebsiteRouter.use(requireAdmin);

/**
 * GET /api/admin/website/overview
 * Overview of published website, deployment status, active release, and preview state
 */
adminWebsiteRouter.get('/overview', (req: AuthenticatedRequest, res, next) => {
  try {
    const published = WebsiteReleaseService.getWebsiteContent('published');
    const draft = WebsiteReleaseService.getWebsiteContent('draft');
    const activeRelease = WebsiteReleaseService.getActiveRelease();
    const freshness = WebsiteReleaseService.getPublicFreshness();
    const allAnnouncements = WebsiteReleaseService.getAnnouncements({ adminMode: true });

    const hasUnpublishedDraft = draft.revision > published.revision ||
      JSON.stringify(draft.content) !== JSON.stringify(published.content);

    res.json({
      success: true,
      data: {
        publishedUrl: 'https://homegrocery.github.io/download-app/',
        deploymentStatus: 'ONLINE',
        lastPublishedAt: published.publishedAt,
        publishedRevision: published.revision,
        publishedEtag: freshness.etag,
        hasUnpublishedDraft,
        activeRelease: activeRelease ? {
          versionName: activeRelease.version_name,
          buildNumber: activeRelease.build_number,
          versionCode: activeRelease.version_code,
          channel: activeRelease.channel,
          status: activeRelease.status,
          apkFilename: activeRelease.apk_filename,
          apkDownloadUrl: activeRelease.apk_download_url,
          apkSizeBytes: activeRelease.apk_size_bytes,
          sha256Hash: activeRelease.sha256_hash,
          publishedAt: activeRelease.published_at
        } : null,
        announcementCounts: {
          total: allAnnouncements.length,
          published: allAnnouncements.filter(a => a.status === 'PUBLISHED').length,
          draft: allAnnouncements.filter(a => a.status === 'DRAFT').length,
          archived: allAnnouncements.filter(a => a.status === 'ARCHIVED').length
        }
      }
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/admin/website/content
 * Get both published and draft content for comparison and preview
 */
adminWebsiteRouter.get('/content', (req: AuthenticatedRequest, res, next) => {
  try {
    const published = WebsiteReleaseService.getWebsiteContent('published');
    const draft = WebsiteReleaseService.getWebsiteContent('draft');

    res.json({
      success: true,
      data: {
        published,
        draft
      }
    });
  } catch (err) {
    next(err);
  }
});

/**
 * PUT /api/admin/website/content/draft
 * Save draft edits without publishing to live website
 */
adminWebsiteRouter.put('/content/draft', (req: AuthenticatedRequest, res, next) => {
  try {
    const result = WebsiteReleaseService.saveWebsiteDraft(req.user!.id, req.body);
    res.json({
      success: true,
      message: 'Website content draft saved successfully',
      messageMr: 'संकेतस्थळ मजकूर मसुदा यशस्वीरित्या जतन केला गेला',
      data: result
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/admin/website/content/publish
 * Explicitly publish draft content to live website
 */
adminWebsiteRouter.post('/content/publish', (req: AuthenticatedRequest, res, next) => {
  try {
    const result = WebsiteReleaseService.publishWebsiteContent(req.user!.id);
    res.json({
      success: true,
      message: 'Website content published to live site successfully',
      messageMr: 'संकेतस्थळ मजकूर थेट संकेतस्थळावर यशस्वीरित्या प्रकाशित केला गेला',
      data: result
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Announcements / Public Activity Routes
 */
adminWebsiteRouter.get('/announcements', (req: AuthenticatedRequest, res, next) => {
  try {
    const status = req.query.status as string | undefined;
    const category = req.query.category as string | undefined;
    const announcements = WebsiteReleaseService.getAnnouncements({
      adminMode: true,
      status,
      category
    });
    res.json({
      success: true,
      data: { announcements }
    });
  } catch (err) {
    next(err);
  }
});

adminWebsiteRouter.post('/announcements', (req: AuthenticatedRequest, res, next) => {
  try {
    const announcement = WebsiteReleaseService.createAnnouncement(req.user!.id, req.body);
    res.json({
      success: true,
      message: 'Public announcement created successfully',
      messageMr: 'सार्वजनिक संदेश यशस्वीरित्या तयार केला गेला',
      data: { announcement }
    });
  } catch (err) {
    next(err);
  }
});

adminWebsiteRouter.put('/announcements/:id', (req: AuthenticatedRequest, res, next) => {
  try {
    const updated = WebsiteReleaseService.updateAnnouncement(req.user!.id, req.params.id, req.body);
    res.json({
      success: true,
      message: 'Public announcement updated successfully',
      messageMr: 'सार्वजनिक संदेश यशस्वीरित्या अद्यतनित केला गेला',
      data: { announcement: updated }
    });
  } catch (err) {
    next(err);
  }
});

adminWebsiteRouter.post('/announcements/:id/publish', (req: AuthenticatedRequest, res, next) => {
  try {
    const published = WebsiteReleaseService.updateAnnouncement(req.user!.id, req.params.id, { status: 'PUBLISHED' });
    res.json({
      success: true,
      message: 'Public announcement published to transparency feed',
      messageMr: 'सार्वजनिक संदेश पारदर्शकता पानावर प्रकाशित केला गेला',
      data: { announcement: published }
    });
  } catch (err) {
    next(err);
  }
});

adminWebsiteRouter.post('/announcements/:id/unpublish', (req: AuthenticatedRequest, res, next) => {
  try {
    const unpublished = WebsiteReleaseService.updateAnnouncement(req.user!.id, req.params.id, { status: 'DRAFT' });
    res.json({
      success: true,
      message: 'Public announcement unpublished to draft',
      messageMr: 'सार्वजनिक संदेश अप्रकाशित करून मसुद्यात हलवला गेला',
      data: { announcement: unpublished }
    });
  } catch (err) {
    next(err);
  }
});

adminWebsiteRouter.post('/announcements/:id/archive', (req: AuthenticatedRequest, res, next) => {
  try {
    const archived = WebsiteReleaseService.updateAnnouncement(req.user!.id, req.params.id, { status: 'ARCHIVED' });
    res.json({
      success: true,
      message: 'Public announcement archived',
      messageMr: 'सार्वजनिक संदेश संग्रहित केला गेला',
      data: { announcement: archived }
    });
  } catch (err) {
    next(err);
  }
});

adminWebsiteRouter.delete('/announcements/:id', (req: AuthenticatedRequest, res, next) => {
  try {
    WebsiteReleaseService.deleteAnnouncement(req.user!.id, req.params.id);
    res.json({
      success: true,
      message: 'Public announcement deleted successfully',
      messageMr: 'सार्वजनिक संदेश यशस्वीरित्या हटवला गेला'
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Release & Manual Build Routes
 */
adminWebsiteRouter.get('/releases', (req: AuthenticatedRequest, res, next) => {
  try {
    const releases = WebsiteReleaseService.getReleases(req.user!.id);
    const active = WebsiteReleaseService.getActiveRelease();
    res.json({
      success: true,
      data: {
        releases,
        activeRelease: active
      }
    });
  } catch (err) {
    next(err);
  }
});

adminWebsiteRouter.post('/releases', (req: AuthenticatedRequest, res, next) => {
  try {
    const release = WebsiteReleaseService.createReleaseDraft(req.user!.id, req.body);
    res.json({
      success: true,
      message: 'Release candidate draft created successfully',
      messageMr: 'नवीन रिलीज उमेदवार मसुदा यशस्वीरित्या तयार केला गेला',
      data: { release }
    });
  } catch (err) {
    next(err);
  }
});

adminWebsiteRouter.post('/releases/:id/build', (req: AuthenticatedRequest, res, next) => {
  try {
    const buildMode = req.body?.buildMode;
    const result = WebsiteReleaseService.startBuildWorkflow(req.user!.id, req.params.id, { buildMode });
    res.json({
      success: true,
      message: result.message,
      data: result
    });
  } catch (err) {
    next(err);
  }
});

adminWebsiteRouter.get('/releases/:id/logs', (req: AuthenticatedRequest, res, next) => {
  try {
    const logs = WebsiteReleaseService.getReleaseLogs(req.params.id);
    res.json({
      success: true,
      data: logs
    });
  } catch (err) {
    next(err);
  }
});

const handleVerifyArtifact = (req: AuthenticatedRequest, res: any, next: any) => {
  try {
    const result = WebsiteReleaseService.verifyReleaseArtifact(req.user!.id, req.params.id, req.body);
    res.json({
      success: true,
      message: 'Release artifact verified successfully with SHA-256 integrity check',
      messageMr: 'रिलीज फाईल SHA-256 सुरक्षिततेसह यशस्वीरित्या पडताळली गेली',
      data: result
    });
  } catch (err) {
    next(err);
  }
};

adminWebsiteRouter.post('/releases/:id/verify', handleVerifyArtifact);
adminWebsiteRouter.post('/releases/:id/verify-artifact', handleVerifyArtifact);

adminWebsiteRouter.get('/releases/:id/download', (req: AuthenticatedRequest, res, next) => {
  try {
    const release = WebsiteReleaseService.getReleaseById(req.params.id);
    if (!release) {
      return res.status(404).json({
        success: false,
        error: 'RELEASE_NOT_FOUND: Release record not found'
      });
    }

    const releaseDir = path.resolve(process.cwd(), '..', 'release');
    const candidatePaths = [
      path.join(releaseDir, release.apk_filename),
      path.resolve(process.cwd(), 'release', release.apk_filename),
      path.resolve(process.cwd(), '..', 'frontend', 'android', 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk'),
      path.join(releaseDir, 'HomeGrocery-v1.0.1-build8.apk')
    ];

    let resolvedPath: string | null = null;
    for (const p of candidatePaths) {
      if (fs.existsSync(p)) {
        resolvedPath = p;
        break;
      }
    }

    if (!resolvedPath) {
      return res.status(404).json({
        success: false,
        error: `ARTIFACT_NOT_FOUND: File ${release.apk_filename} not found on server`
      });
    }

    res.download(resolvedPath, release.apk_filename);
  } catch (err) {
    next(err);
  }
});

adminWebsiteRouter.post('/releases/:id/publish', (req: AuthenticatedRequest, res, next) => {
  try {
    const result = WebsiteReleaseService.publishRelease(req.user!.id, req.params.id);
    res.json({
      success: true,
      message: 'Release published successfully and distribution manifest updated',
      messageMr: 'रिलीज यशस्वीरित्या प्रकाशित केली गेली आणि अपडेट मॅनिफेस्ट अद्यतनित केले गेले',
      data: result
    });
  } catch (err) {
    next(err);
  }
});

adminWebsiteRouter.post('/releases/:id/rollback', (req: AuthenticatedRequest, res, next) => {
  try {
    const result = WebsiteReleaseService.rollbackRelease(req.user!.id, req.params.id, req.body?.targetReleaseId);
    res.json({
      success: true,
      message: 'Release rolled back to previous verified release successfully',
      messageMr: 'रिलीज मागील पडताळलेल्या आवृत्तीवर यशस्वीरित्या परत आणली गेली',
      data: result
    });
  } catch (err) {
    next(err);
  }
});
