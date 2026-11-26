// Small wrappers around ffprobe/ffmpeg (from the project's environment, env/reel).
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import { FFMPEG, FFPROBE } from './config';

const run = promisify(execFile);

export interface Probe { durationSec: number | null; width: number | null; height: number | null }

export async function probe(file: string): Promise<Probe> {
  try {
    const { stdout } = await run(fs.existsSync(FFPROBE) ? FFPROBE : 'ffprobe', [
      '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height:format=duration', '-of', 'json', file,
    ], { timeout: 15000 });
    const j = JSON.parse(stdout);
    const s = j.streams?.[0] || {};
    return { durationSec: j.format?.duration ? Number(j.format.duration) : null, width: s.width ?? null, height: s.height ?? null };
  } catch {
    return { durationSec: null, width: null, height: null };
  }
}

/** Center-crop an uploaded photo to a 724x1254 portrait (9:16-ish, what the avatar model is given), as PNG. */
export async function cropPortrait(input: string, output: string): Promise<void> {
  await run(fs.existsSync(FFMPEG) ? FFMPEG : 'ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y', '-i', input,
    '-vf', "crop='min(iw,ih*724/1254)':'min(ih,iw*1254/724)',scale=724:1254",
    '-frames:v', '1', output,
  ], { timeout: 30000 });
}

/** Any audio (or the sound of a video) → mono 24 kHz wav for voice cloning, optionally cut to its first maxSec seconds. */
export async function convertVoice(input: string, output: string, maxSec: number | null): Promise<void> {
  await run(fs.existsSync(FFMPEG) ? FFMPEG : 'ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y', '-i', input, '-vn', '-ac', '1', '-ar', '24000',
    ...(maxSec ? ['-t', String(maxSec)] : []), output,
  ], { timeout: 60000 });
}
