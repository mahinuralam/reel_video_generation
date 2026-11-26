import { NextResponse } from 'next/server';
import { getDb } from '@/lib/mongo';
import { queueAhead, serialize, toObjectId } from '@/lib/jobs';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

// GET /api/jobs/:id → { job, queue } (queue = jobs ahead of this one while it waits)
export async function GET(_req: Request, { params }: Ctx) {
  const _id = toObjectId((await params).id);
  if (!_id) return NextResponse.json({ error: 'Bad job id' }, { status: 400 });
  const db = await getDb();
  const doc = await db.collection('jobs').findOne({ _id });
  if (!doc) return NextResponse.json({ error: 'Job not found' }, { status: 404 });
  const queue = doc.status === 'queued' ? await queueAhead(db, { queuedAt: doc.queuedAt }) : null;
  return NextResponse.json({ job: serialize(doc), queue });
}

// DELETE /api/jobs/:id → removes the record of a failed or canceled job (files on disk are kept)
export async function DELETE(_req: Request, { params }: Ctx) {
  const _id = toObjectId((await params).id);
  if (!_id) return NextResponse.json({ error: 'Bad job id' }, { status: 400 });
  const db = await getDb();
  const r = await db.collection('jobs').deleteOne({ _id, status: { $in: ['failed', 'canceled'] } });
  if (!r.deletedCount) return NextResponse.json({ error: 'Only failed or canceled jobs can be removed' }, { status: 409 });
  return NextResponse.json({ ok: true });
}
