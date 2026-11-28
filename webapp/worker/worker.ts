// Job worker: takes queued jobs from MongoDB one at a time and runs the pipeline script. Progress is read from its console output.
//
//   REF_AUDIO=<voice clip> REF_TEXT=<its words> bash src/make_video.sh <name> inputs/scripts/<name>.txt <template>
//
// make_video.sh has Claude design the storyboard, then renders it with make_reel.sh.
// With MOCK=1 it runs worker/mock_pipeline.mjs instead, which prints the same lines quickly.
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Db, Document, ObjectId } from 'mongodb';
import { abs, FFMPEG, JOB_LOG_DIR, MOCK, MOCK_DIR, MOCK_SEG_MS, MONGODB_DB, PROJECT_ROOT, rel, TEMPLATE_DIR, WEBAPP_DIR } from '../src/lib/config';
import { AVATARS, countWords, DEFAULT_AVATAR, WORDS_PER_SEC } from '../src/lib/estimate';
import { probe } from '../src/lib/media';
import { getClient, getDb } from '../src/lib/mongo';
import { extractError, initialProgress, ProgressParser } from '../src/lib/progress';
import { getProfile } from '../src/lib/profile';
import type { Beat, JobInput, Photo } from '../src/lib/types';

const TICK_MS = 2000;
const FLUSH_MS = 1500;
const HEARTBEAT_MS = 3000;
const KILL_GRACE_MS = 10000;

interface Running {
  id: ObjectId;
  name: string;
  child: ChildProcess;
  parser: ProgressParser;
  log: fs.WriteStream;
  tail: string[];
  partial: string;
  dirty: boolean;
  lastFlush: number;
  speechRel: string;
  outputRel: string;
  storyboardRel: string;
  speechSeen: boolean;
  beatsSaved: boolean;
  termSentAt: number | null;
  stopReason: string | null;
  finished: boolean;
}

let db: Db;
let current: Running | null = null;
let state = 'idle';
let stopping = false;

const say = (msg: string) => console.log(`${new Date().toISOString()} ${msg}`);
const jobs = () => db.collection('jobs');

function killGroup(pid: number | undefined, sig: NodeJS.Signals) {
  if (!pid) return;
  try { process.kill(-pid, sig); } catch { /* already gone */ }
}

async function heartbeat() {
  await db.collection<{ _id: string } & Document>('system').updateOne(
    { _id: 'worker' },
    { $set: { pid: process.pid, heartbeatAt: new Date(), state, mock: MOCK, currentJob: current?.name ?? null } },
    { upsert: true },
  );
}

/** Jobs a previous worker left as "running" cannot be resumed: stop their processes and mark them failed. */
async function recoverOrphans() {
  const stale = await jobs().find({ status: 'running' }).toArray();
  for (const j of stale) {
    killGroup(j.childPid, 'SIGKILL');
    await jobs().updateOne({ _id: j._id }, { $set: { status: 'failed', childPid: null, finishedAt: new Date(), error: 'The worker restarted while this job was running. Press Retry to run it again.' } });
    say(`recovered orphan job ${j.name}`);
  }
}

function writeTemplate(name: string, photo: Photo): string {
  fs.mkdirSync(TEMPLATE_DIR, { recursive: true });
  const file = path.join(TEMPLATE_DIR, `${name}.template.json`);
  fs.writeFileSync(file, JSON.stringify({ prompt: photo.prompt, cond_image: photo.file }, null, 4) + '\n');
  return rel(file);
}

async function start(job: Document) {
  const profile = await getProfile(db);
  const inp = job.input as JobInput;
  const script = inp.script;
  const photo = profile.photos.find((p) => p.id === inp.photoId) || profile.photos.find((p) => p.id === profile.defaultPhotoId) || profile.photos[0];
  const voice = profile.voices.find((v) => v.id === inp.voiceId) || profile.voices.find((v) => v.id === profile.defaultVoiceId) || profile.voices[0];
  fs.mkdirSync(JOB_LOG_DIR, { recursive: true });
  const logAbs = path.join(JOB_LOG_DIR, `${job.name}.log`);
  const log = fs.createWriteStream(logAbs, { flags: 'a' });
  log.write(`\n===== ${new Date().toISOString()} attempt ${job.attempts} (${MOCK ? 'mock pipeline' : 'pipeline'}) =====\n`);

  const avatar = inp.avatar || DEFAULT_AVATAR;
  const env: NodeJS.ProcessEnv = { ...process.env, REF_AUDIO: voice.file, REF_TEXT: voice.textFile, AVATAR_ENGINE: avatar, PYTHONUNBUFFERED: '1' };
  let cmd: string, args: string[], speechRel: string, outputRel: string, storyboardRel: string;
  if (MOCK) {
    const dir = path.join(MOCK_DIR, job.name);
    fs.mkdirSync(dir, { recursive: true });
    speechRel = rel(path.join(dir, 'speech.wav'));
    outputRel = rel(path.join(dir, `${job.name}.mp4`));
    storyboardRel = rel(path.join(dir, 'storyboard.json'));
    cmd = process.execPath;
    args = [path.join(WEBAPP_DIR, 'worker', 'mock_pipeline.mjs'), job.name, dir];
    Object.assign(env, { FFMPEG, MOCK_SPEECH_SEC: (countWords(script) / WORDS_PER_SEC).toFixed(2), MOCK_SEG_MS: String(MOCK_SEG_MS), MOCK_FAIL_AT: /FAIL_TEST/.test(script) ? '2' : '',
      MOCK_AVATAR: AVATARS[avatar].short, MOCK_USD_PER_SEC: String(AVATARS[avatar].usdPerSec) });
  } else {
    const scriptRel = `inputs/scripts/${job.name}.txt`;
    fs.writeFileSync(abs(scriptRel), script + '\n');
    const tplRel = writeTemplate(job.name, photo);
    speechRel = `outputs/reels/${job.name}/build/speech.wav`;
    outputRel = `outputs/reels/${job.name}/${job.name}.mp4`;
    storyboardRel = `reels/${job.name}/storyboard.json`;
    cmd = 'bash';
    args = ['src/make_video.sh', job.name, scriptRel, tplRel];
  }

  // detached: the job gets its own process group, so cancel stops the pipeline and all its children
  const child = spawn(cmd, args, { cwd: PROJECT_ROOT, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  say(`started ${job.name} (pid ${child.pid}): ${cmd === process.execPath ? 'node' : cmd} ${args.join(' ')}`);
  const run: Running = {
    id: job._id, name: job.name, child, parser: new ProgressParser(AVATARS[avatar].clipSec, AVATARS[avatar].parallel), log, tail: [], partial: '',
    dirty: true, lastFlush: 0, speechRel, outputRel, storyboardRel, speechSeen: false, beatsSaved: false,
    termSentAt: null, stopReason: null, finished: false,
  };
  current = run;
  state = 'running';
  await jobs().updateOne({ _id: job._id }, { $set: { childPid: child.pid ?? null, logPath: rel(logAbs), speechPath: null } });

  const onData = (chunk: Buffer) => {
    log.write(chunk);
    run.partial += chunk.toString('utf8');
    const parts = run.partial.split(/\r|\n/);
    run.partial = parts.pop() ?? '';
    for (const line of parts) {
      if (run.parser.feed(line)) run.dirty = true;
      if (line.trim()) { run.tail.push(line); if (run.tail.length > 80) run.tail.shift(); }
    }
  };
  child.stdout!.on('data', onData);
  child.stderr!.on('data', onData);
  child.on('error', (err) => { run.tail.push(`could not start: ${err.message}`); void finish(run, -1); });
  child.on('close', (code) => { void finish(run, code ?? -1); });
}

async function flush(run: Running, force = false) {
  if (!force && (!run.dirty || Date.now() - run.lastFlush < FLUSH_MS)) return;
  run.dirty = false;
  run.lastFlush = Date.now();
  const set: Document = { progress: run.parser.p };
  if (run.parser.speechSec) set.speechSec = run.parser.speechSec;
  if (run.parser.designed && !run.beatsSaved) {
    // show Claude's design on the video page while the rest renders
    run.beatsSaved = true;
    set['input.beats'] = (JSON.parse(fs.readFileSync(abs(run.storyboardRel), 'utf8')).beats as Beat[]);
  }
  await jobs().updateOne({ _id: run.id }, { $set: set });
}

async function finish(run: Running, code: number) {
  if (run.finished) return;
  run.finished = true;
  if (run.partial) run.parser.feed(run.partial);
  run.log.write(`===== exit code ${code} =====\n`);
  run.log.end();

  const job = await jobs().findOne({ _id: run.id });
  const reported = run.parser.outputPath ? (path.isAbsolute(run.parser.outputPath) ? rel(run.parser.outputPath) : run.parser.outputPath) : null;
  const outputRel = reported && fs.existsSync(abs(reported)) ? reported : run.outputRel;
  const set: Document = { finishedAt: new Date(), childPid: null };

  if (job?.cancelRequested) {
    Object.assign(set, { status: 'canceled', error: null, progress: { ...run.parser.p, detail: 'Canceled', etaSec: null } });
  } else if (run.stopReason) {
    Object.assign(set, { status: 'failed', error: run.stopReason, progress: { ...run.parser.p, etaSec: null } });
  } else if (code === 0 && fs.existsSync(abs(outputRel))) {
    const meta = await probe(abs(outputRel));
    Object.assign(set, { status: 'done', error: null, output: { video: outputRel, ...meta }, progress: { ...run.parser.p, stage: 'done', pct: 100, detail: 'Done', etaSec: 0 } });
  } else {
    const error = code === 0 ? `The pipeline finished but ${outputRel} is missing` : extractError(run.tail);
    Object.assign(set, { status: 'failed', error, progress: { ...run.parser.p, etaSec: null } });
  }
  if (fs.existsSync(abs(run.speechRel))) set.speechPath = run.speechRel;
  if (run.parser.speechSec) set.speechSec = run.parser.speechSec;
  await jobs().updateOne({ _id: run.id }, { $set: set });
  say(`finished ${run.name}: ${set.status}${set.error ? ` (${set.error})` : ''}`);
  if (current === run) { current = null; state = 'idle'; }
}

async function tick() {
  if (current) {
    const run = current;
    const doc = await jobs().findOne({ _id: run.id }, { projection: { cancelRequested: 1 } });
    if ((doc?.cancelRequested || run.stopReason) && !run.termSentAt) {
      say(`stopping ${run.name}`);
      killGroup(run.child.pid, 'SIGTERM');
      run.termSentAt = Date.now();
    } else if (run.termSentAt && Date.now() - run.termSentAt > KILL_GRACE_MS) {
      killGroup(run.child.pid, 'SIGKILL');
    }
    if (!run.speechSeen && fs.existsSync(abs(run.speechRel))) {
      run.speechSeen = true;
      await jobs().updateOne({ _id: run.id }, { $set: { speechPath: run.speechRel } });
    }
    await flush(run);
    return;
  }
  if (stopping) return;

  const next = await jobs().findOne({ status: 'queued' }, { sort: { queuedAt: 1 } });
  if (!next) { state = 'idle'; return; }
  const claimed = await jobs().findOneAndUpdate(
    { _id: next._id, status: 'queued' },
    { $set: { status: 'running', startedAt: new Date(), finishedAt: null, progress: initialProgress(), error: null, output: null, cancelRequested: false }, $inc: { attempts: 1 } },
    { returnDocument: 'after' },
  );
  if (claimed) {
    try { await start(claimed); } catch (e) {
      await jobs().updateOne({ _id: claimed._id }, { $set: { status: 'failed', finishedAt: new Date(), error: `Could not start: ${(e as Error).message}` } });
      current = null; state = 'idle';
    }
  }
}

async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  say(`${signal}: shutting down`);
  const run = current;
  if (run) {
    run.stopReason = 'The worker was stopped while this job was running. Press Retry to run it again.';
    killGroup(run.child.pid, 'SIGTERM');
    const t0 = Date.now();
    while (!run.finished && Date.now() - t0 < KILL_GRACE_MS) await new Promise((r) => setTimeout(r, 250));
    if (!run.finished) { killGroup(run.child.pid, 'SIGKILL'); await finish(run, -1); }
  }
  state = 'offline';
  await heartbeat().catch(() => {});
  await (await getClient()).close();
  process.exit(0);
}

async function main() {
  db = await getDb();
  say(`worker up: db=${MONGODB_DB} mock=${MOCK} project=${PROJECT_ROOT}`);
  await recoverOrphans();
  await heartbeat();
  setInterval(() => { heartbeat().catch((e) => say(`heartbeat failed: ${e.message}`)); }, HEARTBEAT_MS);
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  for (;;) {
    try { await tick(); } catch (e) { say(`tick error: ${(e as Error).stack}`); }
    await new Promise((r) => setTimeout(r, TICK_MS));
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
