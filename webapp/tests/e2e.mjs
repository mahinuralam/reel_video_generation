#!/usr/bin/env node
// End-to-end check of the API and the worker, meant for MOCK=1 (each run takes ~1-2 minutes).
// It makes its own test image and voice with ffmpeg; its videos and uploads live in the mock
// database only.   Usage: npm run test:e2e
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BASE = process.env.BASE || 'http://127.0.0.1:3100';
const stamp = Date.now().toString(36);
let failures = 0, passes = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FFMPEG = process.env.FFMPEG || new URL('../../env/reel/bin/ffmpeg', import.meta.url).pathname;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-'));
function fixture(file, ...args) {
  execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...args, path.join(tmp, file)]);
  return fs.readFileSync(path.join(tmp, file));
}
function check(cond, label, extra = '') {
  if (cond) { passes++; console.log(`  ok   ${label}`); }
  else { failures++; console.log(`  FAIL ${label} ${extra}`); }
}
async function upload(path, fields) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  const r = await fetch(BASE + path, { method: 'POST', body: form });
  return { status: r.status, data: await r.json().catch(() => ({})) };
}
async function call(path, method = 'GET', body, headers = {}) {
  const r = await fetch(BASE + path, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: r.status, data, headers: r.headers };
}
async function waitFor(id, statuses, timeoutMs = 120000, onPoll) {
  const t0 = Date.now();
  for (;;) {
    const { data } = await call(`/api/jobs/${id}`);
    onPoll?.(data.job);
    if (statuses.includes(data.job.status)) return data.job;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timeout waiting for ${statuses} (now ${data.job.status})`);
    await sleep(700);
  }
}

console.log(`E2E against ${BASE}`);

console.log('\n1. status');
const st = await call('/api/status');
check(st.status === 200 && st.data.worker.online, 'worker is online', JSON.stringify(st.data.worker));
check(st.data.worker.mock === true, 'running in mock mode (refusing to call the paid APIs in a test)');
if (!st.data.worker.mock) { console.log('Not in mock mode; stopping.'); process.exit(2); }
let prof = await call('/api/profile');
check(prof.status === 200 && Array.isArray(prof.data.photos) && Array.isArray(prof.data.voices), 'the profile loads');
const sc = await call('/api/scripts');
check(sc.status === 200 && Array.isArray(sc.data.scripts), 'earlier scripts are listed');

console.log('\n2. uploads');
const png = fixture('photo.png', '-f', 'lavfi', '-i', 'testsrc2=size=540x960', '-frames:v', '1');
let r = await upload('/api/profile/photos', { file: new File([png], `e2e_${stamp}.png`, { type: 'image/png' }) });
check(r.status === 201 && r.data.photo?.file.endsWith('.png') && r.data.profile.photos.length === prof.data.photos.length + 1, 'an image upload is saved as a template');
const photoId = r.data.photo?.id;
r = await upload('/api/profile/photos', { file: new File(['not an image'], 'x.txt', { type: 'text/plain' }) });
check(r.status === 422, 'a non-image is refused');
const wav = fixture('voice.wav', '-f', 'lavfi', '-i', 'sine=frequency=180:duration=6', '-ac', '1', '-ar', '24000');
r = await upload('/api/voices', { file: new File([wav], `e2e_${stamp}.wav`, { type: 'audio/wav' }), transcript: 'Hello there, this is a test.' });
const words = (res) => res.data.profile?.voices.find((v) => v.id === res.data.voice?.id)?.text;
check(r.status === 201 && words(r) === 'Hello there, this is a test.' && !r.data.cut, 'a voice upload is saved with the typed words');
const voiceId = r.data.voice?.id;
const voiceFile = r.data.voice?.file;
r = await upload('/api/voices', { file: new File([wav.subarray(0, 44 + 24000 * 2)], 'short.wav', { type: 'audio/wav' }) });
check(r.status === 422 && /at least 3 s/.test(r.data.error), `a clip under 3 s is refused (${r.data.error})`);
r = await upload('/api/voices', { file: new File([wav], `e2e_nowords_${stamp}.wav`, { type: 'audio/wav' }) });
check(r.status === 201 && words(r) === '', 'a voice without words is saved; Whisper writes them on first use');

console.log('\n3. input validation');
r = await call('/api/jobs', 'POST', { script: '   ' });
check(r.status === 422 && r.data.field === 'script', 'rejects an empty script');
r = await call('/api/jobs', 'POST', { script: 'word '.repeat(700) });
check(r.status === 422 && /under 600 words/.test(r.data.errors?.[0]), 'rejects a script over 600 words');
r = await call('/api/jobs', 'POST', { script: 'hello', photoId: 'nope' });
check(r.status === 422 && r.data.field === 'photoId', 'rejects an unknown image');
r = await call('/api/jobs', 'POST', { script: 'hello', voiceId: 'nope' });
check(r.status === 422 && r.data.field === 'voiceId', 'rejects an unknown voice');

console.log('\n4. video with the uploaded image and voice, end to end');
const script = `E2e run ${stamp}. Welcome to this week's update.\nI'll walk you through what we tried, what worked, and what we plan next.`;
r = await call('/api/jobs', 'POST', { script, photoId, voiceId });
check(r.status === 201 && r.data.id && r.data.name === `e2e_run_${stamp}`, `creates the job, named from the script (${r.data.name})`);
const vid = r.data.id;
let lastPct = -1, monotonic = true, sawDesign = false, sawSpeechEarly = false, lastFaceSeen = 0;
const done = await waitFor(vid, ['done', 'failed'], 120000, (j) => {
  if (j.progress.pct < lastPct) monotonic = false;
  lastPct = j.progress.pct;
  if (j.progress.stage === 'design') sawDesign = true;
  if (j.progress.stage === 'face') lastFaceSeen = Math.max(lastFaceSeen, j.progress.faceDone);
  if (j.status === 'running' && j.speechPath) sawSpeechEarly = true;
});
check(done.status === 'done', `finishes as done (${done.status}${done.error ? ': ' + done.error : ''})`);
check(monotonic, 'progress never goes backwards');
check(sawDesign, 'progress showed the design step');
check(sawSpeechEarly, 'speech is available while the video is still rendering');
check(done.input.beats?.length === 6 && done.progress.faceTotal === 4, `Claude's design is stored with the video (${done.input.beats?.length} beats, ${done.progress.faceTotal} on camera)`);
check(lastFaceSeen >= 1 && done.progress.faceDone === 4, `every avatar clip was tracked (${done.progress.faceDone})`);
check(done.progress.costUsd > 0.04, `the HeyGen and music costs are recorded ($${done.progress.costUsd})`);
check(done.output?.video && done.output.durationSec > 0, `output recorded with duration (${done.output?.durationSec?.toFixed(1)} s)`);
check(done.input.photoId === photoId && done.input.voiceId === voiceId, 'the chosen image and voice are stored');
const lg = await call(`/api/jobs/${vid}/log?lines=40`);
check(lg.data.lines?.some((l) => l.includes(`voice clip: ${voiceFile}`)), 'the pipeline was given the chosen voice clip');
check(lg.data.lines?.some((l) => /\[OK\]/.test(l)), 'log endpoint returns the pipeline output');
const fileUrl = '/api/files/' + done.output.video;
let f = await fetch(BASE + fileUrl, { method: 'GET', headers: { Range: 'bytes=0-1023' } });
check(f.status === 206 && f.headers.get('content-range')?.startsWith('bytes 0-1023/'), 'video streams with Range requests (206)');
f = await fetch(BASE + fileUrl + '?download=1');
check(f.status === 200 && /attachment/.test(f.headers.get('content-disposition') || ''), 'download link sends the file as an attachment');
await f.body?.cancel();
r = await call('/api/jobs', 'POST', { script });
check(r.status === 201 && r.data.name === `e2e_run_${stamp}_2`, `the same script gets a new name (${r.data.name})`);
await call(`/api/jobs/${r.data.id}/cancel`, 'POST');
r = await call('/api/jobs', 'POST', { script, title: `  Café Tips #1: ${stamp} ✨ ` });
check(r.status === 201 && r.data.title === `Café Tips #1: ${stamp} ✨` && r.data.name === `cafe_tips_1_${stamp}`, `any text works as a title, with a file-safe name made from it (${r.data.title} → ${r.data.name})`);
await call(`/api/jobs/${r.data.id}/cancel`, 'POST');
r = await call('/api/jobs', 'POST', { script, title: 'x'.repeat(101) });
check(r.status === 422 && r.data.field === 'title', 'a title over 100 characters is refused');

console.log('\n5. failure, retry and remove');
r = await call('/api/jobs', 'POST', { script: 'This one will FAIL_TEST on purpose during the second segment of the video please.' });
const failId = r.data.id;
let failed = await waitFor(failId, ['done', 'failed']);
check(failed.status === 'failed' && /HeyGen could not make the clip/.test(failed.error || ''), `a failed avatar clip is reported with the error (${failed.error})`);
r = await call(`/api/jobs/${failId}/retry`, 'POST');
check(r.status === 200, 'retry is accepted');
failed = await waitFor(failId, ['done', 'failed']);
check(failed.attempts === 2, `retry ran the job again (attempts ${failed.attempts})`);
r = await call(`/api/jobs/${vid}/retry`, 'POST');
check(r.status === 409, 'a finished job cannot be retried');
r = await call(`/api/jobs/${failId}`, 'DELETE');
check(r.status === 200, 'a failed job can be removed');
r = await call(`/api/jobs/${failId}`);
check(r.status === 404, 'removed job is gone');

console.log('\n6. queue and cancel');
const longScript = 'This is a longer script so the job runs for a while. '.repeat(8);
const a = (await call('/api/jobs', 'POST', { script: longScript })).data.id;
const b = (await call('/api/jobs', 'POST', { script: longScript })).data.id;
await waitFor(a, ['running']);
r = await call(`/api/jobs/${b}`);
check(r.data.job.status === 'queued' && r.data.queue.count >= 1, `second job waits behind the first (ahead: ${r.data.queue?.count})`);
r = await call(`/api/jobs/${b}/cancel`, 'POST');
check(r.data.status === 'canceled', 'a waiting job is canceled at once');
await sleep(2500);
r = await call(`/api/jobs/${a}/cancel`, 'POST');
check(r.data.status === 'stopping', 'a running job is asked to stop');
const canceled = await waitFor(a, ['canceled', 'failed', 'done'], 30000);
check(canceled.status === 'canceled', `the running job stops and is marked canceled (${canceled.status})`);
const stat2 = await call('/api/status');
check(stat2.data.running === 0, 'nothing is left running after the cancel');

console.log('\n7. file access is limited');
for (const p of ['src/make_video.sh', 'webapp/.env.local', '.env', '..%2F..%2Fetc%2Fpasswd', `${voiceFile.replace(/\.wav$/, '.txt')}`, `webapp/data/mock/${done.name}/storyboard.json`, 'webapp/data/mongo/WiredTiger']) {
  const x = await fetch(`${BASE}/api/files/${p}`);
  check(x.status === 404, `refuses /api/files/${p} (${x.status})`);
}
prof = await call('/api/profile');
const okPhoto = await fetch(`${BASE}/api/files/${prof.data.photos[0].file}`);
check(okPhoto.status === 200 && okPhoto.headers.get('content-type') === 'image/png', 'serves saved images');
const okVoice = await fetch(`${BASE}/api/files/${voiceFile}`);
check(okVoice.status === 200 && okVoice.headers.get('content-type') === 'audio/wav', 'serves uploaded voices');

console.log('\n8. pages render');
for (const p of ['/', '/library', `/jobs/${vid}`]) {
  const x = await fetch(BASE + p);
  check(x.status === 200, `GET ${p} → ${x.status}`);
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
