// The saved inputs every video can reuse: images (each with the prompt the avatar model gets) and voices (a clip
// to clone plus its words), all added from the app, and the scripts used before.
import fs from 'node:fs';
import path from 'node:path';
import type { Db } from 'mongodb';
import { abs } from './config';
import { countWords } from './estimate';
import type { Profile, ScriptTemplate, Voice } from './types';

/** Prompt for uploaded images. The avatar model gets it along with the photo. */
export const GENERIC_PROMPT = 'A person looks straight at the camera and talks in a warm, lively way, with natural hand gestures that match the words. Natural blinking and head movement, sharp realistic detail.';

/** The clip's words, if they are known yet (an uploaded clip gets them on its first video). */
function withText(v: Voice): Voice {
  try { return { ...v, text: fs.readFileSync(abs(v.textFile), 'utf8').trim() }; } catch { return { ...v, text: '' }; }
}

export async function getProfile(db: Db): Promise<Profile> {
  const col = db.collection<Profile>('profiles');
  const empty: Profile = { _id: 'default', photos: [], defaultPhotoId: '', voices: [], defaultVoiceId: '', updatedAt: new Date().toISOString() };
  await col.updateOne({ _id: 'default' }, { $setOnInsert: empty }, { upsert: true });
  const found = (await col.findOne({ _id: 'default' })) as Profile;
  return { ...found, voices: found.voices.map(withText) };
}

/** Scripts used before (inputs/scripts/*.txt), newest first. */
export function scriptTemplates(limit = 24): ScriptTemplate[] {
  const dir = abs('inputs/scripts');
  let files: string[] = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.txt')); } catch { return []; }
  return files
    .map((f) => ({ f, mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, limit)
    .map(({ f }) => {
      const text = fs.readFileSync(path.join(dir, f), 'utf8').trim();
      const id = f.replace(/\.txt$/, '');
      return { id, label: id.replace(/_/g, ' '), text, words: countWords(text) };
    })
    .filter((s) => s.words > 0);
}
