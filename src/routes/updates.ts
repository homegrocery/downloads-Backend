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
  const candidateBuild2 = path.join(RELEASE_DIR, 'HomeGrocery-v1.0.1-build2.apk');
  const candidateBuild1 = path.join(RELEASE_DIR, 'HomeGrocery-v1.0.1-build1.apk');
  const apkPath = fs.existsSync(candidateBuild2) ? candidateBuild2 : (fs.existsSync(candidateBuild1) ? candidateBuild1 : path.join(RELEASE_DIR, 'HomeGrocery-v1.0.0-debug.apk'));
  let apkSize = 8894137;
  let sha256 = '7F6477CFADFE772DA89C35770337FD4AD0EE92B441F7A4AAFC09BF1C5D2AE244';

  if (fs.existsSync(apkPath)) {
    const stats = fs.statSync(apkPath);
    apkSize = stats.size;
    const buffer = fs.readFileSync(apkPath);
    sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
  }

  return {
    hasUpdate: false,
    latestVersion: '1.0.1',
    latestBuild: 2,
    isMandatory: false,
    minSupportedBuild: 1,
    releaseNotes: 'Home Grocery v1.0.1 (Build 2) — In-app APK updater, Firebase Cloud Sync, and App Server Status fixes.',
    releaseNotesMr: 'घरगुती किराणा यादी v1.0.1 (Build 2) — इन-ॲप अपडेटर, फायरबेस क्लाउड सिंक, आणि सर्व्हर स्थिती सुधारणा.',
    apkUrl: 'https://homegrocery.github.io/download-app/HomeGrocery-v1.0.1-build2.apk',
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
