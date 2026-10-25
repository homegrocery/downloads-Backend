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
      .get('/api/updates/check?clientVersion=1.0.1&clientBuild=6')
      .expect(200);

    expect(res.body.success).toBe(true);
    expect(res.body.data.hasUpdate).toBe(false);
    expect(res.body.data.latestVersion).toBe('1.0.1');
    expect(res.body.data.latestBuild).toBe(6);
    expect(res.body.data.sha256).toBeDefined();
    expect(res.body.data.apkSize).toBeGreaterThan(0);
  });

  it('detects available update when a newer build is staged', async () => {
    // Stage version 1.0.1 (build 7)
    await request(app)
      .post('/api/updates/stage')
      .send({
        latestVersion: '1.0.1',
        latestBuild: 7,
        isMandatory: true,
        minSupportedBuild: 7,
        releaseNotes: 'New feature release',
        releaseNotesMr: 'नवीन वैशिष्ट्ये जोडली'
      })
      .expect(200);

    // Client with build 6 queries
    const res = await request(app)
      .get('/api/updates/check?clientVersion=1.0.1&clientBuild=6')
      .expect(200);

    expect(res.body.success).toBe(true);
    expect(res.body.data.hasUpdate).toBe(true);
    expect(res.body.data.latestVersion).toBe('1.0.1');
    expect(res.body.data.latestBuild).toBe(7);
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
