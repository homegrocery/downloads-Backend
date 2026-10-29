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
let MANIFEST_FILE = path.resolve(process.cwd(), 'data', 'update-manifest.json');

export function setManifestFileForTests(file: string) {
  MANIFEST_FILE = file;
}

export interface UpdateManifest {
  hasUpdate: boolean;
  packageId: string;
  versionCode: number;
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
  const candidateBuild9 = path.join(RELEASE_DIR, 'HomeGrocery-v1.0.2-build9.apk');
  const candidateBuild9Debug = path.join(RELEASE_DIR, 'HomeGrocery-v1.0.2-build9-debug.apk');
  const candidateBuild8 = path.join(RELEASE_DIR, 'HomeGrocery-v1.0.1-build8.apk');
  const candidateBuild7 = path.join(RELEASE_DIR, 'HomeGrocery-v1.0.1-build7.apk');
  const candidateBuild6 = path.join(RELEASE_DIR, 'HomeGrocery-v1.0.1-build6.apk');
  const candidateBuild5 = path.join(RELEASE_DIR, 'HomeGrocery-v1.0.1-build5.apk');
  const candidateBuild4 = path.join(RELEASE_DIR, 'HomeGrocery-v1.0.1-build4.apk');
  const candidateBuild2 = path.join(RELEASE_DIR, 'HomeGrocery-v1.0.1-build2.apk');
  const candidateBuild1 = path.join(RELEASE_DIR, 'HomeGrocery-v1.0.1-build1.apk');
  const apkPath = fs.existsSync(candidateBuild9)
    ? candidateBuild9
    : (fs.existsSync(candidateBuild9Debug)
      ? candidateBuild9Debug
      : (fs.existsSync(candidateBuild8)
        ? candidateBuild8
        : (fs.existsSync(candidateBuild7)
          ? candidateBuild7
          : (fs.existsSync(candidateBuild6)
            ? candidateBuild6
            : (fs.existsSync(candidateBuild5)
              ? candidateBuild5
              : (fs.existsSync(candidateBuild4)
                ? candidateBuild4
                : (fs.existsSync(candidateBuild2)
                  ? candidateBuild2
                  : (fs.existsSync(candidateBuild1) ? candidateBuild1 : path.join(RELEASE_DIR, 'HomeGrocery-v1.0.0-debug.apk')))))))));
  let apkSize = 8854872;
  let sha256 = '5027d8b180d4dc0f0caf8931d8141088c42decb7e57909c64503759a13b538cd';
  let buildNumber = 9;
  let versionName = '1.0.2';
  let versionCode = 16;

  if (fs.existsSync(apkPath)) {
    const stats = fs.statSync(apkPath);
    apkSize = stats.size;
    const buffer = fs.readFileSync(apkPath);
    sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
    if (apkPath.includes('build9')) {
      buildNumber = 9;
      versionName = '1.0.2';
      versionCode = 16;
    } else if (apkPath.includes('build8')) {
      buildNumber = 8;
      versionName = '1.0.1';
      versionCode = 15;
    } else if (apkPath.includes('build7')) {
      buildNumber = 7;
      versionName = '1.0.1';
      versionCode = 14;
    } else if (apkPath.includes('build6')) {
      buildNumber = 6;
      versionName = '1.0.0';
      versionCode = 13;
    }
  }

  const filename = buildNumber >= 9 ? `HomeGrocery-v${versionName}-build${buildNumber}.apk` : `HomeGrocery-v1.0.1-build${buildNumber}.apk`;

  return {
    hasUpdate: false,
    packageId: 'com.homegrocery.app',
    versionCode,
    latestVersion: versionName,
    latestBuild: buildNumber,
    isMandatory: false,
    minSupportedBuild: 1,
    releaseNotes: 'Home Grocery v1.0.2 (Build 9) — Universal Android Build Manager, suspicious-activity account protection, universal auto-refresh, and expanded Telegram admin alerts.',
    releaseNotesMr: 'घरगुती किराणा यादी v1.0.2 (Build 9) — युनिव्हर्सल अँड्रॉइड बिल्ड मॅनेजर, संशयास्पद हालचाली सुरक्षा, स्वयंचलित डेटा रीफ्रेश आणि टेलिग्राम ॲलर्ट.',
    apkUrl: `https://homegrocery.github.io/download-app/${filename}`,
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
