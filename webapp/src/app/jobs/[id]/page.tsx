'use client';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { Icon } from '@/components/Icon';
import { StatusBadge } from '@/components/StatusBadge';
import { api, elapsedSec, fileUrl, fmtWhen, usePoll } from '@/lib/client';
import { fmtDuration, fmtLeft, fmtMinutes, fmtUsd } from '@/lib/estimate';
import type { Beat, Job, Profile } from '@/lib/types';

type JobResp = { job: Job; queue: { count: number; waitSec: number } | null };
type StepDef = { label: string; stages: string[]; detail: (j: Job) => string };

const STEPS: StepDef[] = [
  { label: 'Design', stages: ['design'], detail: (j) => (j.input.beats ? `Claude planned ${j.input.beats.length} beats` : 'Claude plans the beats and graphics') },
  { label: 'Voice', stages: ['speech', 'timing'], detail: (j) => (j.speechSec ? `${j.speechSec.toFixed(1)} s of speech` : 'The chosen voice reads the script') },
  { label: 'Avatar clips', stages: ['face'], detail: (j) => (j.progress.faceTotal ? `${j.progress.faceDone ?? 0} of ${j.progress.faceTotal} from HeyGen` : 'On-camera beats, by HeyGen') },
  { label: 'Graphics', stages: ['visuals'], detail: (j) => `${j.progress.visualsDone ?? 0} of ${j.progress.beatsTotal || '?'} beats drawn` },
  { label: 'Assemble', stages: ['assemble', 'done'], detail: () => '1080×1920 MP4' },
];

function beatLabel(b: Beat): string {
  if (b.type === 'face') return b.overlay?.title ? `On camera · ${b.overlay.title}` : 'On camera';
  if (b.type === 'split') return `Split screen · ${b.data?.title ?? b.scene}`;
  const scene = b.scene ? b.scene[0].toUpperCase() + b.scene.slice(1) : 'Graphic';
  return `${scene}${b.data?.title ? ` · ${b.data.title}` : ''}`;
}

function stepStates(job: Job) {
  if (job.status === 'done') return STEPS.map(() => 'done');
  const idx = STEPS.findIndex((s) => s.stages.includes(job.progress.stage));
  return STEPS.map((_, i) => {
    if (idx < 0) return 'todo';
    if (i < idx) return 'done';
    if (i === idx) return job.status === 'failed' ? 'failed' : job.status === 'running' ? 'active' : 'todo';
    return 'todo';
  });
}

export default function JobPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [fullLog, setFullLog] = useState(false);
  const [actionErr, setActionErr] = useState<string | null>(null);
  const { data, error, reload } = usePoll<JobResp>(`/api/jobs/${id}`, 2000);
  const { data: profile } = usePoll<Profile>('/api/profile', 0);
  const live = data?.job.status === 'running' || data?.job.status === 'queued';
  const log = usePoll<{ lines: string[]; path?: string }>(`/api/jobs/${id}/log?lines=${fullLog ? 400 : 40}${fullLog ? '&all=1' : ''}`, live ? 3000 : 0);
  // keep the newest log lines in view
  const logRef = useRef<HTMLPreElement>(null);
  useEffect(() => { if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight; }, [log.data]);

  if (error && !data) return <div className="alert alert-error" role="alert"><b>{error}</b><Link href="/library">Back to the videos</Link></div>;
  if (!data) return <p className="muted">Loading…</p>;
  const job = data.job;
  const p = job.progress;
  const states = stepStates(job);
  const took = elapsedSec(job.startedAt, job.finishedAt);
  const photo = profile?.photos.find((x) => x.id === job.input.photoId);
  const voice = profile?.voices.find((x) => x.id === job.input.voiceId);

  async function act(path: string, method = 'POST', confirmText?: string) {
    if (confirmText && !window.confirm(confirmText)) return;
    setActionErr(null);
    const r = await api<{ error?: string }>(path, method);
    if (!r.ok) setActionErr(r.data.error || 'That did not work');
    else if (method === 'DELETE') { router.push('/library'); return; } // the job is gone; do not fetch it again
    reload();
  }

  return (
    <>
      <div className="page-head">
        <Link href="/library" className="back">← Videos</Link>
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <div className="row">
            <h1 className="title" style={{ overflowWrap: 'anywhere' }}>{job.title || job.name}</h1>
            <StatusBadge job={job} />
          </div>
          <div className="row">
            {job.status === 'queued' || (job.status === 'running' && !job.cancelRequested) ? (
              <button type="button" className="btn btn-danger" onClick={() => act(`/api/jobs/${id}/cancel`, 'POST', job.status === 'running' ? 'Stop this video? What it has cost so far is not refunded.' : undefined)}>
                <Icon name="x" />Cancel
              </button>
            ) : null}
            {job.status === 'failed' || job.status === 'canceled' ? (
              <>
                <button type="button" className="btn" onClick={() => act(`/api/jobs/${id}`, 'DELETE', 'Remove this video from the list? Files already written on the server are kept.')}><Icon name="trash" />Remove</button>
                <button type="button" className="btn btn-cta" onClick={() => act(`/api/jobs/${id}/retry`)}><Icon name="retry" />Retry</button>
              </>
            ) : null}
          </div>
        </div>
        <p className="lede">
          {photo?.label ?? job.input.photoId} image · {voice?.label ?? job.input.voiceId} voice · designed by Claude
          {job.startedAt ? ` · started ${fmtWhen(job.startedAt)}` : ` · added ${fmtWhen(job.createdAt)}`}
          {job.mock ? ' · mock run' : ''}
        </p>
      </div>
      {actionErr ? <div className="alert alert-error" role="alert">{actionErr}</div> : null}

      <section className="card" aria-label="Progress">
        <ol className="steps">
          {STEPS.map((s, i) => (
            <li key={s.label} className={`step ${states[i]}`}>
              <span className="num">{states[i] === 'done' ? <Icon name="check" size={16} strokeWidth={3} /> : i + 1}</span>
              <span><b>{s.label}</b><span className="small">{s.detail(job)}</span></span>
            </li>
          ))}
        </ol>

        {job.status === 'queued' ? (
          <div className="alert alert-info">
            <span><b>Waiting to start.</b> {data.queue?.count ? `${data.queue.count} video${data.queue.count > 1 ? 's' : ''} ahead, starts in about ${fmtMinutes(data.queue.waitSec)}.` : 'Starts within a few seconds.'} This one takes about {job.estimate.minutes} min and costs about {fmtUsd(job.estimate.costUsd)}.</span>
          </div>
        ) : null}

        {job.status === 'running' ? (
          <div className="stack">
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <span><strong>{p.pct}%</strong> · {p.detail}</span>
              <span className="muted">{fmtDuration(took)} elapsed{p.etaSec != null ? ` · ${fmtLeft(p.etaSec)}` : ''}</span>
            </div>
            <div className="bar" role="progressbar" aria-valuenow={p.pct} aria-valuemin={0} aria-valuemax={100} aria-label="Render progress" style={{ height: 10 }}><span style={{ width: `${p.pct}%` }} /></div>
          </div>
        ) : null}

        {job.status === 'failed' ? (
          <div className="alert alert-error" role="alert">
            <span style={{ color: 'var(--bad)' }}><Icon name="alert" size={22} /></span>
            <div className="grow">
              <b style={{ display: 'block' }}>Stopped{p.detail && p.stage !== 'queued' ? ` during: ${p.detail.toLowerCase()}` : ''}</b>
              <span className="mono small">{job.error}</span>
            </div>
          </div>
        ) : null}
        {job.status === 'canceled' ? <div className="alert alert-info">Canceled. Retry puts it back in the queue with the same inputs.</div> : null}
      </section>

      <div className="split">
        <div className="grow stack" style={{ gap: 20 }}>
          {job.status === 'done' && job.output ? (
            <section className="card result" aria-labelledby="out-h">
              <video className="player" controls preload="metadata" src={fileUrl(job.output.video)} />
              <div className="stack">
                <h2 id="out-h">Your video is ready</h2>
                <p className="muted" style={{ margin: 0 }}>
                  {fmtDuration(job.output.durationSec)}{job.output.width ? ` · ${job.output.width}×${job.output.height}` : ''}{took ? ` · rendered in ${fmtMinutes(took)}` : ''}{p.costUsd ? ` · cost ${fmtUsd(p.costUsd)}` : ''}
                </p>
                <a className="btn btn-cta" href={fileUrl(job.output.video, true)}><Icon name="download" />Download MP4</a>
                <Link className="btn" href="/">Make another</Link>
              </div>
            </section>
          ) : null}

          {job.input.beats?.length ? (
            <section className="card" aria-labelledby="design-h">
              <h2 id="design-h">Claude&apos;s design</h2>
              <ol className="beats">
                {job.input.beats.map((b) => (
                  <li key={b.id} className={`beat ${b.type}`}>
                    <b>{beatLabel(b)}</b>
                    <span>{b.lines.join(' ')}</span>
                  </li>
                ))}
              </ol>
            </section>
          ) : null}

          <section className="card" aria-labelledby="in-h">
            <h2 id="in-h">Inputs</h2>
            <div className="inputs">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              {photo ? <img className="input-img" src={fileUrl(photo.file)} alt={`${photo.label} image`} /> : null}
              <div className="stack grow">
                {job.speechPath ? (
                  <>
                    <span className="help">{job.status === 'running' ? 'The generated speech, ready before the video:' : 'The generated speech:'}</span>
                    <audio className="audio" controls preload="none" src={fileUrl(job.speechPath)} />
                  </>
                ) : live ? <span className="help">The speech appears here as soon as it is generated.</span> : null}
                {job.input.script ? <div className="script">{job.input.script}</div> : null}
              </div>
            </div>
          </section>
        </div>

        <section className="card grow" aria-labelledby="log-h">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <h2 id="log-h">Log</h2>
            {job.logPath ? <button type="button" className="btn btn-small" onClick={() => setFullLog((v) => !v)}>{fullLog ? 'Short log' : 'Full log'}</button> : null}
          </div>
          {log.data?.lines.length ? <pre className="log" ref={logRef}>{log.data.lines.join('\n')}</pre> : <p className="help" style={{ margin: 0 }}>'The log starts when the job does.'</p>}
          {job.logPath ? <span className="help mono">{job.logPath}</span> : null}
        </section>
      </div>
    </>
  );
}
