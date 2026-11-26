import { NextResponse } from 'next/server';
import { getDb } from '@/lib/mongo';
import { toObjectId } from '@/lib/jobs';

export const dynamic = 'force-dynamic';

// POST /api/jobs/:id/cancel → a waiting job is canceled at once; a running one is stopped by the worker
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const _id = toObjectId((await params).id);
  if (!_id) return NextResponse.json({ error: 'Bad job id' }, { status: 400 });
  const jobs = (await getDb()).collection('jobs');
  const waiting = await jobs.updateOne({ _id, status: 'queued' }, { $set: { status: 'canceled', finishedAt: new Date(), 'progress.detail': 'Canceled before it started' } });
  if (waiting.modifiedCount) return NextResponse.json({ ok: true, status: 'canceled' });
  const running = await jobs.updateOne({ _id, status: 'running' }, { $set: { cancelRequested: true, 'progress.detail': 'Stopping…' } });
  if (running.modifiedCount) return NextResponse.json({ ok: true, status: 'stopping' });
  return NextResponse.json({ error: 'Only waiting or running jobs can be canceled' }, { status: 409 });
}
