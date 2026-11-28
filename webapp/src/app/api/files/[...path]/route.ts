import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { MIME, resolveSafe } from '@/lib/files';

export const dynamic = 'force-dynamic';

// GET /api/files/outputs/reels/<name>/<name>.mp4[?download=1]
// Streams videos, audio and images only. Supports Range so the browser can seek in videos.
export async function GET(req: Request, { params }: { params: Promise<{ path: string[] }> }) {
  const parts = (await params).path.map((p) => decodeURIComponent(p));
  const file = resolveSafe(parts.join('/'));
  if (!file) return new Response('Not found', { status: 404 });
  const stat = fs.statSync(file);
  if (!stat.isFile()) return new Response('Not found', { status: 404 });

  const type = MIME[path.extname(file).toLowerCase()];
  if (!type) return new Response('Not found', { status: 404 });
  const headers: Record<string, string> = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache' };
  if (new URL(req.url).searchParams.get('download') === '1') {
    headers['Content-Disposition'] = `attachment; filename="${parts[parts.length - 1].replace(/"/g, '')}"`;
  }

  const range = req.headers.get('range');
  const m = range?.match(/^bytes=(\d*)-(\d*)$/);
  if (m && (m[1] || m[2])) {
    let start = m[1] ? parseInt(m[1], 10) : stat.size - parseInt(m[2], 10);
    let end = m[1] && m[2] ? parseInt(m[2], 10) : stat.size - 1;
    start = Math.max(0, start);
    end = Math.min(end, stat.size - 1);
    if (start > end) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${stat.size}` } });
    const stream = Readable.toWeb(fs.createReadStream(file, { start, end })) as ReadableStream;
    return new Response(stream, { status: 206, headers: { ...headers, 'Content-Range': `bytes ${start}-${end}/${stat.size}`, 'Content-Length': String(end - start + 1) } });
  }
  const stream = Readable.toWeb(fs.createReadStream(file)) as ReadableStream;
  return new Response(stream, { status: 200, headers: { ...headers, 'Content-Length': String(stat.size) } });
}
