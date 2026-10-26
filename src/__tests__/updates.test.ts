import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import { createApp } from '../app.js';
import { initDatabase, closeDatabase } from '../db/database.js';

describe('APK Update Management API', () => {
  const app = createApp();
  const manifestFile = path.resolve(process.cwd(), 'data', 'update-manifest.json');

  beforeEach(() => {
    initDatabase(':memory:');
    if (fs.existsSync(manifestFile)) fs.unlinkSync(manifestFile);
  });

  afterAll(() => {
    closeDatabase();
    if (fs.existsSync(manifestFile)) fs.unlinkSync(manifestFile);
  });

  it('checks for updates and returns up-to-date state for current build', async () => {
    const res = await request(app)
      .get('/api/updates/check?clientVersion=1.0.1&clientBuild=8')
      .expect(200);

    expect(res.body.success).toBe(true);
    expect(res.body.data.hasUpdate).toBe(false);
    expect(res.body.data.packageId).toBe('com.homegrocery.app');
    expect(res.body.data.versionCode).toBe(15);
    expect(res.body.data.latestVersion).toBe('1.0.1');
    expect(res.body.data.latestBuild).toBe(8);
    expect(res.body.data.sha256).toBe('9ace4da60c6fdfb8a44fced3ce43b6d902db97541ebc1664fe85da05ed0069e6');
    expect(res.body.data.apkSize).toBe(9429395);
  });

  it('detects available update when a newer build is staged', async () => {
    // Stage version 1.0.1 (build 9)
    await request(app)
      .post('/api/updates/stage')
      .send({
        latestVersion: '1.0.1',
        latestBuild: 9,
        isMandatory: true,
        minSupportedBuild: 9,
        releaseNotes: 'New feature release',
        releaseNotesMr: 'नवीन वैशिष्ट्ये जोडली'
      })
      .expect(200);

    // Client with build 8 queries
    const res = await request(app)
      .get('/api/updates/check?clientVersion=1.0.1&clientBuild=8')
      .expect(200);

    expect(res.body.success).toBe(true);
    expect(res.body.data.hasUpdate).toBe(true);
    expect(res.body.data.latestVersion).toBe('1.0.1');
    expect(res.body.data.latestBuild).toBe(9);
    expect(res.body.data.isMandatory).toBe(true);
  });

  it('handles download for existing artifact or returns 404 cleanly', async () => {
    // Non-existent file
    const res = await request(app)
      .get('/api/updates/download/non-existent.apk')
      .expect(404);

    expect(res.body.success).toBe(false);
    expect(res.body.error).toContain('NOT_FOUND');
  });
});
