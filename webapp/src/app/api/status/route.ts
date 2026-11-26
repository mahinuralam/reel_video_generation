import { NextResponse } from 'next/server';
import type { Document } from 'mongodb';
import { MOCK } from '@/lib/config';
import { getDb } from '@/lib/mongo';
import type { WorkerInfo } from '@/lib/types';

export const dynamic = 'force-dynamic';

// GET /api/status → worker and queue in one call (the sidebar polls it)
export async function GET() {
  const db = await getDb();
  const [w, running, queued] = await Promise.all([
    db.collection<{ _id: string } & Document>('system').findOne({ _id: 'worker' }),
    db.collection('jobs').countDocuments({ status: 'running' }),
    db.collection('jobs').countDocuments({ status: 'queued' }),
  ]);
  const fresh = !!w?.heartbeatAt && Date.now() - new Date(w.heartbeatAt).getTime() < 15000;
  const worker: WorkerInfo = {
    online: fresh && w?.state !== 'offline',
    state: fresh ? w?.state ?? 'idle' : 'offline',
    mock: MOCK,
    heartbeatAt: w?.heartbeatAt ? new Date(w.heartbeatAt).toISOString() : null,
    currentJob: w?.currentJob ?? null,
  };
  return NextResponse.json({ worker, running, queued });
}
