import { NextResponse } from 'next/server';
import { abs } from '@/lib/config';
import { tailFile } from '@/lib/files';
import { getDb } from '@/lib/mongo';
import { toObjectId } from '@/lib/jobs';

export const dynamic = 'force-dynamic';

// Blank lines are dropped from the short log.
const NOISE = /^\s*$/;

// GET /api/jobs/:id/log?lines=40&all=1 → { lines }
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const _id = toObjectId((await params).id);
  if (!_id) return NextResponse.json({ error: 'Bad job id' }, { status: 400 });
  const doc = await (await getDb()).collection('jobs').findOne({ _id }, { projection: { logPath: 1 } });
  if (!doc) return NextResponse.json({ error: 'Job not found' }, { status: 404 });
  if (!doc.logPath) return NextResponse.json({ lines: [] });
  const url = new URL(req.url);
  const n = Math.min(2000, Math.max(1, Number(url.searchParams.get('lines') || 40)));
  const all = url.searchParams.get('all') === '1';
  let lines = tailFile(abs(doc.logPath), all ? n : n * 4);
  if (!all) lines = lines.filter((l) => !NOISE.test(l)).slice(-n);
  return NextResponse.json({ lines, path: doc.logPath });
}
