// Creating, listing and shaping job records. A job is one video: an image, a voice and a script,
// which Claude turns into a storyboard (avatar beats + animated graphics) before it is rendered.
import fs from 'node:fs';
import { ObjectId, type Db, type Document } from 'mongodb';
import { abs, MOCK } from './config';
import { countWords, DEFAULT_AVATAR, estimateVideo, isAvatar, MAX_TITLE, MAX_WORDS } from './estimate';
import { initialProgress } from './progress';
import { getProfile } from './profile';
import type { Job } from './types';

const NAME_RE = /^[a-z0-9][a-z0-9_]{1,47}$/;

/** Files and folders a job writes (project-relative). If any exists the name is taken. */
function pathsFor(name: string): string[] {
  if (MOCK) return [`webapp/data/mock/${name}`];
  return [`reels/${name}`, `outputs/reels/${name}`, `inputs/scripts/${name}.txt`];
}

async function nameTaken(db: Db, name: string): Promise<boolean> {
  return !!(await db.collection('jobs').findOne({ name })) || pathsFor(name).some((p) => fs.existsSync(abs(p)));
}

/** Lower-case words of a text, accents removed: "Café Tips #1!" → ["cafe", "tips", "1"]. */
function slugWords(text: string): string[] {
  return text.normalize('NFKD').replace(/[\u0300-\u036f’']/g, '').toLowerCase().match(/[a-z0-9]+/g) || [];
}

/** The first line of the script, cut to about 60 characters at a word: the title when none is typed. */
function defaultTitle(script: string): string {
  const line = script.split('\n')[0];
  if (line.length <= 60) return line;
  return line.slice(0, 60).replace(/\s+\S*$/, '') + '…';
}

/** A free file-safe name for the job's folders, made from the typed title (else the script's first words),
 *  e.g. "my_first_reel" or "my_first_reel_2". The title itself can be any text. */
async function autoName(db: Db, title: string, script: string): Promise<string> {
  const fromTitle = slugWords(title).join('_').slice(0, 40).replace(/_+$/, '');
  const fromScript = slugWords(script).slice(0, 3).join('_').slice(0, 40);
  const stem = [fromTitle, fromScript].find((s) => NAME_RE.test(s)) ?? 'video';
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

type CreateResult = { id: string; name: string; title: string } | { errors: string[]; field?: string };

// The title is any text (default: the script's first line); the image and voice default to the saved
// defaults, the avatar model to DEFAULT_AVATAR.
export async function createJob(db: Db, body: Record<string, unknown>): Promise<CreateResult> {
  const script = String(body.script ?? '').replace(/\r/g, '').split('\n').map((l) => l.trim()).filter(Boolean).join('\n');
  const words = countWords(script);
  if (!words) return { errors: ['Write a script first'], field: 'script' };
  if (words > MAX_WORDS) return { errors: [`Keep the script under ${MAX_WORDS} words (this one has ${words}).`], field: 'script' };

  const typed = String(body.title ?? '').replace(/\s+/g, ' ').trim();
  const title = typed || defaultTitle(script);
  if (title.length > MAX_TITLE) return { errors: [`Keep the title under ${MAX_TITLE} characters`], field: 'title' };

  const profile = await getProfile(db);
  const photoId = String(body.photoId ?? profile.defaultPhotoId);
  if (!profile.photos.some((p) => p.id === photoId)) return { errors: [`Unknown image "${photoId}"`], field: 'photoId' };
  const voiceId = String(body.voiceId ?? profile.defaultVoiceId);
  if (!profile.voices.some((v) => v.id === voiceId)) return { errors: [`Unknown voice "${voiceId}"`], field: 'voiceId' };

  const avatar = body.avatar ?? DEFAULT_AVATAR;
  if (!isAvatar(avatar)) return { errors: [`Unknown avatar model "${String(avatar)}"`], field: 'avatar' };

  const name = await autoName(db, typed, script);
  const now = new Date();
  const e = estimateVideo(script, avatar);
  const doc: Document = {
    name, title, status: 'queued', progress: initialProgress(), createdAt: now, queuedAt: now, attempts: 0, mock: MOCK,
    input: { script, photoId, voiceId, avatar },
    estimate: { speechSec: e.speechSec, minutes: e.minutes, costUsd: e.costUsd },
  };

  try {
    const r = await db.collection('jobs').insertOne(doc);
    return { id: r.insertedId.toHexString(), name, title };
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
