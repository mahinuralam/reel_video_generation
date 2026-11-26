// Creating, listing and shaping job records. A job is one video: an image, a voice and a script,
// which Claude turns into a storyboard (avatar beats + animated graphics) before it is rendered.
import fs from 'node:fs';
import { ObjectId, type Db, type Document } from 'mongodb';
import { abs, MOCK } from './config';
import { countWords, estimateVideo } from './estimate';
import { initialProgress } from './progress';
import { getProfile } from './profile';
import type { Job } from './types';

const NAME_RE = /^[a-z0-9][a-z0-9_]{1,47}$/;
const MAX_WORDS = 600; // ~4 min of speech

/** Files and folders a job writes (project-relative). If any exists the name is taken. */
function pathsFor(name: string): string[] {
  if (MOCK) return [`webapp/data/mock/${name}`];
  return [`reels/${name}`, `outputs/reels/${name}`, `inputs/scripts/${name}.txt`];
}

async function nameTaken(db: Db, name: string): Promise<boolean> {
  return !!(await db.collection('jobs').findOne({ name })) || pathsFor(name).some((p) => fs.existsSync(abs(p)));
}

/** A free name made from the script's first words, e.g. "hello_everyone_welcome" or "hello_everyone_welcome_2". */
async function autoName(db: Db, script: string): Promise<string> {
  const words = script.toLowerCase().replace(/[’']/g, '').match(/[a-z0-9]+/g) || [];
  const base = words.slice(0, 3).join('_').slice(0, 40);
  const stem = NAME_RE.test(base) ? base : 'video';
  for (let i = 1; ; i++) {
    const name = i === 1 ? stem : `${stem}_${i}`;
    if (!(await nameTaken(db, name))) return name;
  }
}

export function serialize(doc: Document): Job {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(doc)) {
    out[k] = v instanceof ObjectId ? v.toHexString() : v instanceof Date ? v.toISOString() : v;
  }
  return out as unknown as Job;
}

export function toObjectId(id: string): ObjectId | null {
  return ObjectId.isValid(id) && id.length === 24 ? new ObjectId(id) : null;
}

type CreateResult = { id: string; name: string } | { errors: string[]; field?: string };

// The name is made from the script; the image and voice default to the saved defaults.
export async function createJob(db: Db, body: Record<string, unknown>): Promise<CreateResult> {
  const script = String(body.script ?? '').replace(/\r/g, '').split('\n').map((l) => l.trim()).filter(Boolean).join('\n');
  const words = countWords(script);
  if (!words) return { errors: ['Write a script first'], field: 'script' };
  if (words > MAX_WORDS) return { errors: [`Keep the script under ${MAX_WORDS} words (this one has ${words}); a minute of video takes about 40 minutes.`], field: 'script' };

  const profile = await getProfile(db);
  const photoId = String(body.photoId ?? profile.defaultPhotoId);
  if (!profile.photos.some((p) => p.id === photoId)) return { errors: [`Unknown image "${photoId}"`], field: 'photoId' };
  const voiceId = String(body.voiceId ?? profile.defaultVoiceId);
  if (!profile.voices.some((v) => v.id === voiceId)) return { errors: [`Unknown voice "${voiceId}"`], field: 'voiceId' };

  const name = await autoName(db, script);
  const now = new Date();
  const e = estimateVideo(script);
  const doc: Document = {
    name, status: 'queued', progress: initialProgress(), createdAt: now, queuedAt: now, attempts: 0, mock: MOCK,
    input: { script, photoId, voiceId },
    estimate: { speechSec: e.speechSec, minutes: e.minutes, costUsd: e.costUsd },
  };

  try {
    const r = await db.collection('jobs').insertOne(doc);
    return { id: r.insertedId.toHexString(), name };
  } catch (err) {
    if ((err as { code?: number }).code === 11000) return { errors: ['Another video with the same name was added at the same moment; press Generate again.'] };
    throw err;
  }
}

/** Jobs waiting before this one, and roughly how long until it starts. */
export async function queueAhead(db: Db, job?: { queuedAt: Date | string } | null) {
  const jobs = db.collection('jobs');
  const running = await jobs.findOne({ status: 'running' });
  const filter: Document = { status: 'queued' };
  if (job) filter.queuedAt = { $lt: new Date(job.queuedAt) };
  const ahead = await jobs.find(filter, { projection: { estimate: 1 } }).toArray();
  let waitSec = ahead.reduce((s, j) => s + (j.estimate?.minutes || 0) * 60, 0);
  if (running) waitSec += running.progress?.etaSec ?? (running.estimate?.minutes || 0) * 60;
  return { count: ahead.length + (running ? 1 : 0), waitSec };
}
