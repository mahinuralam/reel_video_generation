import Link from 'next/link';
import { fileUrl, fmtWhen } from '@/lib/client';
import { fmtDuration } from '@/lib/estimate';
import type { Job } from '@/lib/types';
import { StatusBadge } from './StatusBadge';

// One video in a grid: the finished clip (a frame from 1 s in as the thumbnail), or its progress.
export function VideoCard({ job }: { job: Job }) {
  const out = job.status === 'done' ? job.output : null;
  return (
    <Link href={`/jobs/${job._id}`} className="vcard">
      <div className="vthumb">
        {out ? <video preload="metadata" muted src={`${fileUrl(out.video)}#t=1`} aria-hidden="true" tabIndex={-1} /> : null}
        {job.status === 'running' ? <div className="bar vbar"><span style={{ width: `${job.progress.pct}%` }} /></div> : null}
        <span className="vbadge"><StatusBadge job={job} /></span>
        {out ? <span className="len">{fmtDuration(out.durationSec)}</span> : null}
      </div>
      <span className="vname">{job.name}</span>
      <span className="muted small">{fmtWhen(job.finishedAt || job.createdAt)}</span>
    </Link>
  );
}
