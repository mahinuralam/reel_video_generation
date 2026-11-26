'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '@/components/Icon';
import { VideoCard } from '@/components/VideoCard';
import { api, fileUrl, usePoll } from '@/lib/client';
import { estimateVideo, fmtDuration, fmtMinutes, fmtUsd } from '@/lib/estimate';
import type { Job, Profile, ScriptTemplate } from '@/lib/types';

type JobsResp = { jobs: Job[]; queue: { count: number; waitSec: number } };

// Create: an image, a voice and a script → a queued video, which Claude designs (avatar beats,
// animated graphics, captions) before it renders. Saved images, voices and earlier scripts are
// offered as templates; uploads are saved as new templates.
export default function Create() {
  const router = useRouter();
  const { data: loaded, error: loadErr } = usePoll<Profile>('/api/profile', 0);
  const { data: scripts } = usePoll<{ scripts: ScriptTemplate[] }>('/api/scripts', 0);
  const { data: jobs } = usePoll<JobsResp>('/api/jobs', 5000);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [photoId, setPhotoId] = useState<string | null>(null);
  const [voiceId, setVoiceId] = useState<string | null>(null);
  const [script, setScript] = useState('');
  const [transcript, setTranscript] = useState('');
  const [note, setNote] = useState<{ text: string; bad?: boolean } | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState<'photo' | 'voice' | 'submit' | null>(null);
  const [playing, setPlaying] = useState<string | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  const voiceFile = useRef<HTMLInputElement>(null);

  useEffect(() => { if (loaded) setProfile(loaded); }, [loaded]);
  useEffect(() => () => audio.current?.pause(), []);

  const photo = photoId ?? profile?.defaultPhotoId ?? null;
  const voice = voiceId ?? profile?.defaultVoiceId ?? null;
  const est = useMemo(() => estimateVideo(script), [script]);
  const canGo = est.words > 0 && !!photo && !!voice && !busy;

  function play(id: string, file: string) {
    audio.current?.pause();
    if (playing === id) { setPlaying(null); return; }
    audio.current = new Audio(fileUrl(file));
    audio.current.onended = () => setPlaying(null);
    void audio.current.play();
    setPlaying(id);
  }

  async function uploadPhoto(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setBusy('photo'); setNote(null);
    const body = new FormData();
    body.append('file', file);
    const r = await fetch('/api/profile/photos', { method: 'POST', body });
    const j = await r.json().catch(() => ({}));
    setBusy(null);
    if (r.ok) { setProfile(j.profile); setPhotoId(j.photo.id); setNote({ text: `Image “${j.photo.label}” saved and selected.` }); }
    else setNote({ text: j.error || 'Upload failed', bad: true });
  }

  async function uploadVoice() {
    const file = voiceFile.current?.files?.[0];
    if (!file) { setNote({ text: 'Choose an audio file first', bad: true }); return; }
    setBusy('voice'); setNote(null);
    const body = new FormData();
    body.append('file', file);
    body.append('transcript', transcript);
    const r = await fetch('/api/voices', { method: 'POST', body });
    const j = await r.json().catch(() => ({}));
    setBusy(null);
    if (!r.ok) { setNote({ text: j.error || 'Upload failed', bad: true }); return; }
    setProfile(j.profile); setVoiceId(j.voice.id); setTranscript('');
    if (voiceFile.current) voiceFile.current.value = '';
    setNote({ text: `Voice “${j.voice.label}” saved and selected${j.cut ? '; it was longer than 30 s, so its first 20 s are used' : ''}.` });
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!canGo) return;
    setBusy('submit'); setErrors([]);
    const r = await api<{ id?: string; errors?: string[] }>('/api/jobs', 'POST', { script, photoId: photo, voiceId: voice });
    if (r.ok && r.data.id) { router.push(`/jobs/${r.data.id}`); return; }
    setErrors(r.data.errors || ['Could not add the video']);
    setBusy(null);
  }

  const recent = (jobs?.jobs ?? []).slice(0, 4);
  const queue = jobs?.queue;

  return (
    <>
      <section className="hero">
        <h1>Make <span className="grad">your</span> video</h1>
        <p className="lede">Choose an image and a voice, write the script, and Claude designs the animated video.</p>
      </section>
      {loadErr ? <div className="alert alert-error" role="alert"><b>Cannot reach the database</b><span>{loadErr}. Is MongoDB running? Check with webapp/scripts/status.sh on the server.</span></div> : null}

      <form className="create" onSubmit={submit} noValidate>
        <div className="prompt">
          <label htmlFor="script" className="sr-only">Script</label>
          <textarea id="script" rows={6} value={script} onChange={(e) => setScript(e.target.value)}
            placeholder="Write your script here…" />
          <div className="prompt-bar">
            <select className="pill-select" aria-label="Start from a saved script" value="" onChange={(e) => {
              const s = scripts?.scripts.find((x) => x.id === e.target.value);
              if (s) setScript(s.text);
            }}>
              <option value="">Saved scripts</option>
              {scripts?.scripts.map((s) => <option key={s.id} value={s.id}>{s.label} ({s.words} words)</option>)}
            </select>
            <span className="meta">
              {est.words ? `${est.words} words · ${fmtDuration(est.speechSec)} of speech · about ${est.minutes} min · about ${fmtUsd(est.costUsd)}` : 'Under 600 words'}
              {queue?.count ? ` · ${queue.count} ahead (~${fmtMinutes(queue.waitSec)})` : ''}
            </span>
            <button type="submit" className="btn btn-cta" disabled={!canGo}>
              <Icon name="sparkles" />{busy === 'submit' ? 'Adding…' : 'Generate video'}
            </button>
          </div>
        </div>
        {errors.length ? <ul className="problems" role="alert">{errors.map((e) => <li key={e}>{e}</li>)}</ul> : null}

        <div className="pickers">
          <fieldset className="panel">
            <legend><Icon name="image" size={16} />Image</legend>
            <div className="tiles">
              {profile?.photos.map((p) => (
                <button key={p.id} type="button" className="tile" aria-pressed={photo === p.id} onClick={() => setPhotoId(p.id)}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={fileUrl(p.file)} alt="" />
                  <span>{p.label}</span>
                </button>
              ))}
              <label className="tile tile-add">
                <input type="file" accept="image/png,image/jpeg,image/webp" className="sr-only" onChange={uploadPhoto} disabled={!!busy} />
                <Icon name="upload" size={22} />
                <span>{busy === 'photo' ? 'Uploading…' : 'Upload image'}</span>
              </label>
            </div>
            <span className="help">Portrait, upper body, facing the camera. It is cropped to 9 : 16.</span>
          </fieldset>

          <fieldset className="panel">
            <legend><Icon name="mic" size={16} />Voice</legend>
            <div className="voices">
              {profile?.voices.map((v) => (
                <div key={v.id} className="voice" aria-current={voice === v.id ? 'true' : undefined}>
                  <button type="button" className="voice-pick" aria-pressed={voice === v.id} onClick={() => setVoiceId(v.id)}>
                    <b>{v.label}</b>
                    <span className="muted small">{v.sec ? `${v.sec} s clip` : 'Clip'}{v.text ? '' : ' · words found on first use'}</span>
                  </button>
                  <button type="button" className="icon-btn" aria-label={`${playing === v.id ? 'Stop' : 'Play'} ${v.label}`} onClick={() => play(v.id, v.file)}>
                    <Icon name={playing === v.id ? 'stop' : 'play'} size={16} />
                  </button>
                </div>
              ))}
            </div>
            <details className="add-voice">
              <summary><Icon name="upload" size={16} />Upload a voice</summary>
              <div className="stack">
                <div className="field">
                  <label htmlFor="voice-file" className="small">Audio, 10 to 20 s of clear speech (WAV, MP3, M4A…)</label>
                  <input id="voice-file" ref={voiceFile} type="file" accept="audio/*,video/webm" />
                </div>
                <div className="field">
                  <label htmlFor="voice-text" className="small">What is said in it (optional)</label>
                  <textarea id="voice-text" className="textarea" rows={2} value={transcript} onChange={(e) => setTranscript(e.target.value)} placeholder="Leave empty and Whisper writes it down on first use" />
                </div>
                <button type="button" className="btn" onClick={uploadVoice} disabled={!!busy}>{busy === 'voice' ? 'Uploading…' : 'Add voice'}</button>
              </div>
            </details>
          </fieldset>
        </div>
        {note ? <p className={note.bad ? 'err' : 'help'} role="status">{note.text}</p> : null}
      </form>

      {recent.length ? (
        <section className="recent" aria-labelledby="recent-h">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <h2 id="recent-h">Recent videos</h2>
            <Link href="/library" className="small">See all</Link>
          </div>
          <div className="vgrid">{recent.map((j) => <VideoCard key={j._id} job={j} />)}</div>
        </section>
      ) : null}
    </>
  );
}
