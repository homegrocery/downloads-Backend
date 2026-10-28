/**
 * Home Grocery — Telegram Alert Animation Generator
 *
 * Generates lightweight, looping branded MP4 and GIF alert animations for Telegram
 * Bot API sendAnimation alerts.
 *
 * Requirements:
 * - ffmpeg in PATH (or pre-bundled binary)
 *
 * Output specifications:
 * - Format: H.264 MP4 (yuv420p) & GIF89a
 * - Resolution: 480x270 (16:9 compact mobile size)
 * - Frame rate: 25 fps (MP4), 15 fps (GIF)
 * - Duration: 3.0 seconds seamless loop
 * - Color palette: Deep navy (#070F2B), glowing cyan pulse (#38BDF8), emerald beacon (#10B981)
 * - File size target: < 50 KB (well within Telegram limits)
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export function getAlertAnimationDir(): string {
  const primary = path.resolve(__dirname, '../assets/telegram');
  if (!fs.existsSync(primary)) {
    fs.mkdirSync(primary, { recursive: true });
  }
  return primary;
}

export function generateAlertAnimations(): { mp4Path: string; gifPath: string; generated: boolean } {
  const outputDir = getAlertAnimationDir();
  const mp4Path = path.join(outputDir, 'alert_animation.mp4');
  const gifPath = path.join(outputDir, 'alert_animation.gif');

  // If both files already exist and are non-empty, report existing
  if (fs.existsSync(mp4Path) && fs.statSync(mp4Path).size > 0 &&
      fs.existsSync(gifPath) && fs.statSync(gifPath).size > 0) {
    return { mp4Path, gifPath, generated: false };
  }

  // Attempt ffmpeg generation
  try {
    const filter = [
      'color=c=0x070F2B:s=480x270:d=3:r=25[bg]',
      'drawbox=x=0:y=0:w=480:h=6:color=0x38BDF8@0.9:t=fill[topbar]',
      'drawbox=x=0:y=264:w=480:h=6:color=0x38BDF8@0.9:t=fill[botbar]',
      'drawtext=text=\'HOME GROCERY\':fontsize=28:fontcolor=0xFFFFFF:x=(w-text_w)/2:y=105[title]',
      'drawtext=text=\'ADMIN SECURITY & CONTROL CENTER\':fontsize=14:fontcolor=0x94A3B8:x=(w-text_w)/2:y=145[sub]',
      'drawbox=x=240-20*sin(2*PI*t/1.5):y=180:w=40*sin(2*PI*t/1.5)+1:h=3:color=0x38BDF8@0.8:t=fill[pulse]'
    ].join(';');

    // Generate MP4
    execSync(`ffmpeg -y -f lavfi -i "${filter}" -c:v libx264 -pix_fmt yuv420p -movflags +faststart -t 3 "${mp4Path}"`, {
      stdio: 'pipe'
    });

    // Generate GIF
    execSync(`ffmpeg -y -i "${mp4Path}" -vf "fps=15,scale=480:-1:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse" -t 3 "${gifPath}"`, {
      stdio: 'pipe'
    });

    return { mp4Path, gifPath, generated: true };
  } catch (err: any) {
    console.warn('[generateAlertAnimation] ffmpeg generation skipped or failed:', err?.message || err);
    return { mp4Path, gifPath, generated: false };
  }
}

if (process.argv[1] && process.argv[1].endsWith('generateAlertAnimation.ts')) {
  const result = generateAlertAnimations();
  console.log('Alert animation check result:', result);
}
