import { NextResponse } from 'next/server';
import { getDb } from '@/lib/mongo';
import { createJob, queueAhead, serialize } from '@/lib/jobs';

export const dynamic = 'force-dynamic';

// GET /api/jobs → { jobs (newest first), queue }
export async function GET() {
  const db = await getDb();
  const docs = await db.collection('jobs').find().sort({ createdAt: -1 }).limit(500).toArray();
  return NextResponse.json({ jobs: docs.map(serialize), queue: await queueAhead(db) });
}

// POST /api/jobs  body: { script, title?, photoId?, voiceId? }  → 201 { id, name, title } | 422 { errors, field }
export async function POST(req: Request) {
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return NextResponse.json({ errors: ['Body must be JSON'] }, { status: 400 }); }
  const db = await getDb();
  const result = await createJob(db, body);
  if ('errors' in result) return NextResponse.json(result, { status: 422 });
  return NextResponse.json(result, { status: 201 });
}
