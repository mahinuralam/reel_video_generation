import fs from 'node:fs';
import path from 'node:path';
import { NextResponse } from 'next/server';
import { rel, UPLOAD_DIR } from '@/lib/config';
import { convertVoice, probe } from '@/lib/media';
import { getDb } from '@/lib/mongo';
import { getProfile } from '@/lib/profile';
import type { Profile, Voice } from '@/lib/types';

export const dynamic = 'force-dynamic';

const MAX_BYTES = 25 * 1024 * 1024;
const MIN_SEC = 3;
const MAX_SEC = 30;   // longer clips are cut to their first CUT_SEC seconds
const CUT_SEC = 20;

// POST /api/profile/voices  multipart: file (any audio ffmpeg can read), transcript?
// Saves the clip as a reusable voice: mono 24 kHz wav. Its exact words come from the transcript if
// given, otherwise Whisper writes them on the first video that uses the voice.  → { profile, voice }
export async function POST(req: Request) {
  const form = await req.formData().catch(() => null);
  const file = form?.get('file');
  if (!(file instanceof File) || !file.size) return NextResponse.json({ error: 'Choose an audio file' }, { status: 422 });
  if (file.size > MAX_BYTES) return NextResponse.json({ error: 'Keep the audio file under 25 MB' }, { status: 422 });
  if (file.type && !/^(audio|video)\//.test(file.type)) return NextResponse.json({ error: 'That is not an audio file (use WAV, MP3, M4A, OGG or WebM)' }, { status: 422 });
  let transcript = String(form?.get('transcript') ?? '').replace(/\s+/g, ' ').trim();
  const label = file.name.replace(/\.[^.]+$/, '').slice(0, 40) || 'Uploaded voice';

  const id = `v${Date.now().toString(36)}`;
  const dir = path.join(UPLOAD_DIR, 'voices');
  fs.mkdirSync(dir, { recursive: true });
  const original = path.join(dir, `${id}_original${path.extname(file.name).slice(0, 6) || '.audio'}`);
  const wav = path.join(dir, `${id}.wav`);
  fs.writeFileSync(original, Buffer.from(await file.arrayBuffer()));

  const fail = (msg: string) => {
    for (const f of [original, wav]) fs.rmSync(f, { force: true });
    return NextResponse.json({ error: msg }, { status: 422 });
  };
  const full = (await probe(original)).durationSec;
  if (!full) return fail('Could not read that audio file');
  if (full < MIN_SEC) return fail(`The clip is ${full.toFixed(1)} s; use at least ${MIN_SEC} s of clear speech (10 to 20 s works best)`);
  const cut = full > MAX_SEC;
  try {
    await convertVoice(original, wav, cut ? CUT_SEC : null);
  } catch (e) {
    return fail(`Could not convert that audio: ${(e as Error).message.slice(0, 120)}`);
  }
  if (cut) transcript = ''; // the typed words no longer match the shortened clip; Whisper will write them
  const textFile = path.join(dir, `${id}.txt`);
  if (transcript) fs.writeFileSync(textFile, transcript + '\n');

  const sec = (await probe(wav)).durationSec;
  const voice: Voice = { id, label, file: rel(wav), textFile: rel(textFile), sec: sec ? Math.round(sec * 10) / 10 : null };
  const db = await getDb();
  const { defaultVoiceId } = await getProfile(db);
  await db.collection<Profile>('profiles').updateOne({ _id: 'default' }, {
    $push: { voices: voice },
    $set: { updatedAt: new Date().toISOString(), ...(defaultVoiceId ? {} : { defaultVoiceId: id }) }, // the first voice becomes the default
  });
  return NextResponse.json({ profile: await getProfile(db), voice, cut }, { status: 201 });
}
