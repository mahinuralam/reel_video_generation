// Which project files the browser may read. Everything else under the project stays private.
import fs from 'node:fs';
import path from 'node:path';
import { PROJECT_ROOT } from './config';

// Checked against the real path (after symlinks), so a link cannot point outside these folders.
const ALLOWED = ['outputs', 'inputs/photo', 'inputs/voice', 'webapp/data/uploads', 'webapp/data/mock'].map((p) => path.join(PROJECT_ROOT, p));

function inside(p: string, root: string) {
  return p === root || p.startsWith(root + path.sep);
}

/** Project-relative path → absolute real path if the browser may read it, else null. */
export function resolveSafe(relPath: string): string | null {
  if (!relPath || relPath.includes('\0')) return null;
  const candidate = path.resolve(/*turbopackIgnore: true*/ PROJECT_ROOT, relPath);
  if (!inside(candidate, PROJECT_ROOT)) return null;
  if (!ALLOWED.some((root) => inside(candidate, root))) return null;
  let real: string;
  try { real = fs.realpathSync(candidate); } catch { return null; }
  // mock outputs are links into outputs/, which is allowed; nothing may resolve elsewhere
  if (!ALLOWED.some((root) => inside(real, root))) return null;
  return real;
}

/** The only file types the browser is given (media); anything else is refused. */
export const MIME: Record<string, string> = {
  '.mp4': 'video/mp4', '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
};

/** Last n lines of a text file (reads at most the final 256 KB). */
export function tailFile(file: string, n: number): string[] {
  try {
    const st = fs.statSync(file);
    const len = Math.min(st.size, 256 * 1024);
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, st.size - len);
    fs.closeSync(fd);
    // progress bars rewrite one line with \r; keep only the last state of each
    const lines = buf.toString('utf8').split('\n').map((l) => { const parts = l.split('\r').filter(Boolean); return parts[parts.length - 1] || ''; });
    return lines.slice(-n);
  } catch {
    return [];
  }
}
