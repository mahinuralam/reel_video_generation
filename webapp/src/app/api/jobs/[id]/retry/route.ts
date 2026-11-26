import { NextResponse } from 'next/server';
import { getDb } from '@/lib/mongo';
import { toObjectId } from '@/lib/jobs';
import { initialProgress } from '@/lib/progress';

export const dynamic = 'force-dynamic';

// POST /api/jobs/:id/retry → puts a failed or canceled job back at the end of the queue (same name, same inputs)
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const _id = toObjectId((await params).id);
  if (!_id) return NextResponse.json({ error: 'Bad job id' }, { status: 400 });
  const jobs = (await getDb()).collection('jobs');
  const r = await jobs.updateOne(
    { _id, status: { $in: ['failed', 'canceled'] } },
    { $set: { status: 'queued', queuedAt: new Date(), progress: initialProgress(), error: null, cancelRequested: false, startedAt: null, finishedAt: null } },
  );
  if (!r.modifiedCount) return NextResponse.json({ error: 'Only failed or canceled jobs can be retried' }, { status: 409 });
  return NextResponse.json({ ok: true });
}
