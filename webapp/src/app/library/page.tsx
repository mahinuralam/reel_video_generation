'use client';
import Link from 'next/link';
import { VideoCard } from '@/components/VideoCard';
import { usePoll } from '@/lib/client';
import type { Job } from '@/lib/types';

export default function Library() {
  const { data, error } = usePoll<{ jobs: Job[] }>('/api/jobs', 5000);
  const jobs = data?.jobs ?? [];

  return (
    <>
      <div className="page-head">
        <h1 className="title">Videos</h1>
        <p className="lede">Everything you have made, newest first.</p>
      </div>
      {error ? <div className="alert alert-error" role="alert">{error}</div> : null}
      <div className="vgrid">{jobs.map((j) => <VideoCard key={j._id} job={j} />)}</div>
      {data && !jobs.length ? <p className="empty">Nothing here yet. <Link href="/">Make your first video</Link>.</p> : null}
    </>
  );
}
