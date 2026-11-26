import fs from 'node:fs';
import path from 'node:path';
import { NextResponse } from 'next/server';
import { rel, UPLOAD_DIR } from '@/lib/config';
import { cropPortrait } from '@/lib/media';
import { getDb } from '@/lib/mongo';
import { GENERIC_PROMPT, getProfile } from '@/lib/profile';
import type { Photo, Profile } from '@/lib/types';

export const dynamic = 'force-dynamic';

const MAX_BYTES = 15 * 1024 * 1024;
const TYPES: Record<string, string> = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp' };

// POST /api/profile/photos  multipart: file → saves the image as a reusable template (center-cropped
// to a 724x1254 portrait, described with the generic prompt) → { profile, photo }
export async function POST(req: Request) {
  const form = await req.formData().catch(() => null);
  const file = form?.get('file');
  if (!(file instanceof File)) return NextResponse.json({ error: 'Choose an image' }, { status: 422 });
  if (!TYPES[file.type]) return NextResponse.json({ error: 'Use a PNG, JPG or WebP image' }, { status: 422 });
  if (file.size > MAX_BYTES) return NextResponse.json({ error: 'Keep the image under 15 MB' }, { status: 422 });
  const label = file.name.replace(/\.[^.]+$/, '').slice(0, 40) || 'Uploaded image';

  const id = `up${Date.now().toString(36)}`;
  const dir = path.join(UPLOAD_DIR, 'photos');
  fs.mkdirSync(dir, { recursive: true });
  const original = path.join(dir, `${id}_original${TYPES[file.type]}`);
  const portrait = path.join(dir, `${id}.png`);
  fs.writeFileSync(original, Buffer.from(await file.arrayBuffer()));
  try {
    await cropPortrait(original, portrait);
  } catch (e) {
    fs.rmSync(original, { force: true });
    return NextResponse.json({ error: `Could not read that image: ${(e as Error).message.slice(0, 120)}` }, { status: 422 });
  }
  const photo: Photo = { id, label, file: rel(portrait), prompt: GENERIC_PROMPT, uploaded: true };
  const db = await getDb();
  const { defaultPhotoId } = await getProfile(db);
  await db.collection<Profile>('profiles').updateOne({ _id: 'default' }, {
    $push: { photos: photo },
    $set: { updatedAt: new Date().toISOString(), ...(defaultPhotoId ? {} : { defaultPhotoId: id }) }, // the first image becomes the default
  });
  return NextResponse.json({ profile: await getProfile(db), photo }, { status: 201 });
}
