import { Router } from 'express';
import { WebsiteReleaseService } from '../services/websiteReleaseService.js';

export const publicWebsiteRouter = Router();

/**
 * GET /api/public/website/freshness
 * Lightweight change detection endpoint for sub-5-second public site auto-refresh.
 * Supports HTTP 304 Not Modified with If-None-Match header.
 */
publicWebsiteRouter.get('/website/freshness', (req, res) => {
  const freshness = WebsiteReleaseService.getPublicFreshness();
  res.setHeader('ETag', `"${freshness.etag}"`);
  res.setHeader('Cache-Control', 'public, max-age=2, must-revalidate');

  const ifNoneMatch = req.headers['if-none-match'];
  if (ifNoneMatch) {
    const clientEtag = ifNoneMatch.replace(/^W\//, '').replace(/"/g, '');
    if (clientEtag === freshness.etag) {
      res.status(304).end();
      return;
    }
  }

  res.json({
    success: true,
    data: freshness
  });
});

/**
 * GET /api/public/website/content
 * Returns only explicitly published, sanitized website content.
 * Drafts and internal admin metadata are strictly withheld.
 */
publicWebsiteRouter.get('/website/content', (req, res) => {
  const published = WebsiteReleaseService.getWebsiteContent('published');
  const freshness = WebsiteReleaseService.getPublicFreshness();

  res.setHeader('ETag', `"${freshness.etag}"`);
  res.setHeader('Cache-Control', 'public, max-age=5, must-revalidate');

  const ifNoneMatch = req.headers['if-none-match'];
  if (ifNoneMatch) {
    const clientEtag = ifNoneMatch.replace(/^W\//, '').replace(/"/g, '');
    if (clientEtag === freshness.etag) {
      res.status(304).end();
      return;
    }
  }

  // Active verified release metadata
  const activeRelease = WebsiteReleaseService.getActiveRelease();

  res.json({
    success: true,
    data: {
      content: published.content,
      revision: published.revision,
      publishedAt: published.publishedAt,
      activeRelease: activeRelease ? {
        versionName: activeRelease.version_name,
        buildNumber: activeRelease.build_number,
        versionCode: activeRelease.version_code,
        channel: activeRelease.channel,
        apkFilename: activeRelease.apk_filename,
        apkDownloadUrl: activeRelease.apk_download_url,
        apkSizeBytes: activeRelease.apk_size_bytes,
        sha256Hash: activeRelease.sha256_hash,
        releaseNotes: activeRelease.release_notes,
        releaseNotesMr: activeRelease.release_notes_mr,
        publishedAt: activeRelease.published_at
      } : null
    }
  });
});

/**
 * GET /api/public/activity
 * Public Admin Transparency & Announcements Feed.
 * Returns only status = 'PUBLISHED' and non-expired announcements.
 * Internal account IDs, admin mobile numbers, and private audit logs are NEVER returned.
 */
publicWebsiteRouter.get('/activity', (req, res) => {
  const announcements = WebsiteReleaseService.getAnnouncements({ adminMode: false });
  const freshness = WebsiteReleaseService.getPublicFreshness();

  res.setHeader('ETag', `"${freshness.etag}"`);
  res.setHeader('Cache-Control', 'public, max-age=5, must-revalidate');

  res.json({
    success: true,
    data: {
      announcements: announcements.map(a => ({
        id: a.id,
        title: a.title,
        titleMr: a.title_mr,
        content: a.content,
        contentMr: a.content_mr,
        category: a.category,
        publishedAt: a.published_at,
        expiresAt: a.expires_at,
        safeLinks: a.safe_links
      }))
    }
  });
});
