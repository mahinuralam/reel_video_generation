// Server-side settings. Everything lives under the avatar_pipeline project folder.
import path from 'node:path';

// turbopackIgnore: these are runtime paths into the project (outputs, weights…), not files to bundle
export const PROJECT_ROOT = path.resolve(/*turbopackIgnore: true*/ process.env.PROJECT_ROOT || path.join(/*turbopackIgnore: true*/ process.cwd(), '..'));
export const WEBAPP_DIR = path.join(PROJECT_ROOT, 'webapp');
export const DATA_DIR = path.join(WEBAPP_DIR, 'data');
export const TEMPLATE_DIR = path.join(DATA_DIR, 'templates');
export const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
export const MOCK_DIR = path.join(DATA_DIR, 'mock');
export const JOB_LOG_DIR = path.join(PROJECT_ROOT, 'logs', 'webapp', 'jobs');

export const MOCK = process.env.MOCK === '1';
export const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017';
// Mock runs get their own database so simulated jobs never mix with real ones.
export const MONGODB_DB = process.env.MONGODB_DB || (MOCK ? 'avatar_studio_mock' : 'avatar_studio');

export const FFMPEG = path.join(PROJECT_ROOT, 'env', 'reel', 'bin', 'ffmpeg');
export const FFPROBE = path.join(PROJECT_ROOT, 'env', 'reel', 'bin', 'ffprobe');
export const MOCK_SEG_MS = Number(process.env.MOCK_SEG_MS || 1500);

/** Project-relative path → absolute path. */
export function abs(rel: string): string {
  return path.join(/*turbopackIgnore: true*/ PROJECT_ROOT, rel);
}

/** Absolute path inside the project → project-relative path with forward slashes. */
export function rel(absPath: string): string {
  return path.relative(PROJECT_ROOT, absPath).split(path.sep).join('/');
}
