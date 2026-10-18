import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { config } from '../config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const updatesRouter = Router();

const RELEASE_DIR = path.resolve(process.cwd(), '..', 'release');
const MANIFEST_FILE = path.resolve(process.cwd(), 'data', 'update-manifest.json');

export interface UpdateManifest {
  hasUpdate: boolean;
  latestVersion: string;
  latestBuild: number;
  isMandatory: boolean;
  minSupportedBuild: number;
  releaseNotes: string;
  releaseNotesMr: string;
  apkUrl: string;
  apkSize: number;
  sha256: string;
  publishedAt: string;
}

function getDefaultManifest(): UpdateManifest {
  const apkPath = path.join(RELEASE_DIR, 'HomeGrocery-v1.0.0-debug.apk');
  let apkSize = 4122700;
  let sha256 = '98a350155b5e1a82747d7699d4bb2c2ac94893d73e964a139c2f9b25d86e0ea1';

  if (fs.existsSync(apkPath)) {
    const stats = fs.statSync(apkPath);
    apkSize = stats.size;
    const buffer = fs.readFileSync(apkPath);
    sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
  }

  return {
    hasUpdate: false,
    latestVersion: '1.0.0',
    latestBuild: 5,
    isMandatory: false,
    minSupportedBuild: 1,
    releaseNotes: 'Home Grocery V1.0.0 — Smart Household Grocery & Budget Manager.',
    releaseNotesMr: 'घरगुती किराणा यादी V1.0.0 — घरातील किराणा सामान आणि अंदाजपत्रक व्यवस्थापक.',
    apkUrl: '/api/updates/download/HomeGrocery-v1.0.0-debug.apk',
    apkSize,
    sha256,
    publishedAt: new Date().toISOString()
  };
}

export function getActiveManifest(): UpdateManifest {
  if (fs.existsSync(MANIFEST_FILE)) {
    try {
      const content = fs.readFileSync(MANIFEST_FILE, 'utf8');
      return JSON.parse(content);
    } catch {
      return getDefaultManifest();
    }
  }
  return getDefaultManifest();
}

/**
 * Check for updates
 * GET /api/updates/check?clientVersion=1.0.0&clientBuild=1
 */
updatesRouter.get('/check', (req, res) => {
  const clientBuild = parseInt(req.query.clientBuild as string || '1', 10);
  const manifest = getActiveManifest();

  const hasUpdate = manifest.latestBuild > clientBuild;
  const isMandatory = manifest.isMandatory && clientBuild < manifest.minSupportedBuild;

  res.json({
    success: true,
    data: {
      ...manifest,
      hasUpdate
    }
  });
});

/**
 * Download APK file
 * GET /api/updates/download/:filename
 */
updatesRouter.get('/download/:filename', (req, res) => {
  const filename = path.basename(req.params.filename);
  const candidatePaths = [
    path.join(RELEASE_DIR, filename),
    path.resolve(process.cwd(), 'release', filename),
    path.resolve(process.cwd(), 'data', 'release', filename)
  ];

  let resolvedPath: string | null = null;
  for (const p of candidatePaths) {
    if (fs.existsSync(p)) {
      resolvedPath = p;
      break;
    }
  }

  if (!resolvedPath) {
    res.status(404).json({
      success: false,
      error: 'UPDATE_ARTIFACT_NOT_FOUND: The requested APK update package was not found on this server.'
    });
    return;
  }

  const stat = fs.statSync(resolvedPath);
  res.writeHead(200, {
    'Content-Type': 'application/vnd.android.package-archive',
    'Content-Length': stat.size,
    'Content-Disposition': `attachment; filename="${filename}"`
  });

  const stream = fs.createReadStream(resolvedPath);
  stream.pipe(res);
});

/**
 * Dev / Admin helper to stage a simulated update manifest
 * POST /api/updates/stage
 */
updatesRouter.post('/stage', (req, res) => {
  const current = getActiveManifest();
  const updated: UpdateManifest = {
    ...current,
    ...req.body
  };

  const dataDir = path.dirname(MANIFEST_FILE);
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  fs.writeFileSync(MANIFEST_FILE, JSON.stringify(updated, null, 2), 'utf8');

  res.json({
    success: true,
    message: 'Update manifest staged successfully',
    data: updated
  });
});

/**
 * Reset update manifest back to default
 * POST /api/updates/reset
 */
updatesRouter.post('/reset', (req, res) => {
  if (fs.existsSync(MANIFEST_FILE)) {
    fs.unlinkSync(MANIFEST_FILE);
  }
  res.json({
    success: true,
    message: 'Update manifest reset to default',
    data: getDefaultManifest()
  });
});
