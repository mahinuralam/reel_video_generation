import { STATUS_LABEL } from '@/lib/client';
import type { Job } from '@/lib/types';

export function StatusBadge({ job }: { job: Pick<Job, 'status' | 'progress' | 'cancelRequested'> }) {
  let text: string = STATUS_LABEL[job.status];
  if (job.status === 'running') text = job.cancelRequested ? 'Stopping…' : `Rendering · ${job.progress?.pct ?? 0}%`;
  return <span className={`badge tone-${job.status}`}>{text}</span>;
}
