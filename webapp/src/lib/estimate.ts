// Time and cost estimates. The beats with the avatar (face and split screen) need a clip from the
// avatar model, paid per second; Claude keeps them to at most about 70% of the words. Each engine in
// avatar_engines.json gives a typical time per clip ("clip_sec") and whether its clips render at the
// same time ("parallel"); the rest (design, voice, timing, graphics, assembly) takes about five minutes.
import engines from '../../../src/reel/avatar_engines.json';

// Measured from recent reels (about 2.8 words/s); must match WORDS_PER_SECOND in src/reel/write_storyboard.py.
export const WORDS_PER_SEC = 2.7;
export const MAX_WORDS = 600;       // ~4 min of speech
export const MAX_TITLE = 100;
const FACE_SHARE = 0.65;

/** The avatar models src/reel/render_face.py can use (AVATAR_ENGINE), from the shared src/reel/avatar_engines.json. */
export type AvatarEngine = keyof typeof engines;
export const AVATARS = Object.fromEntries(
  Object.entries(engines).map(([id, e]) => [id, { label: e.label, short: e.short, usdPerSec: e.usd_per_sec, clipSec: e.clip_sec, parallel: e.parallel }]),
) as Record<AvatarEngine, { label: string; short: string; usdPerSec: number; clipSec: number; parallel: boolean }>;
export const DEFAULT_AVATAR: AvatarEngine = 'heygen';
export const isAvatar = (v: unknown): v is AvatarEngine => typeof v === 'string' && Object.hasOwn(AVATARS, v);
const OTHER_USD = 0.15;             // Claude's design, the voice and the music ($0.04), a few cents each
const MINUTES = 5;
const BEAT_SEC = 5;                 // a typical on-camera beat

export function countWords(text: string): number {
  return (text.trim().match(/\S+/g) || []).length;
}

export function fmtDuration(sec: number | null | undefined): string {
  if (sec == null || !isFinite(sec)) return '–';
  const s = Math.round(sec);
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}

export function fmtMinutes(sec: number | null | undefined): string {
  if (sec == null || !isFinite(sec)) return '–';
  if (sec < 60) return 'under a minute';
  const m = Math.round(sec / 60);
  return m === 1 ? '1 min' : `${m} min`;
}

export function fmtLeft(sec: number | null | undefined): string {
  if (sec == null || !isFinite(sec)) return '';
  return sec < 60 ? 'less than a minute left' : `about ${fmtMinutes(sec)} left`;
}

export function fmtUsd(usd: number): string {
  return `$${usd.toFixed(2)}`;
}

/** Before Claude has designed it: assume about two thirds of the speech with the avatar. */
export function estimateVideo(script: string, avatar: AvatarEngine = DEFAULT_AVATAR) {
  const words = countWords(script);
  const speechSec = words / WORDS_PER_SEC;
  const a = AVATARS[avatar];
  const costUsd = words ? speechSec * FACE_SHARE * a.usdPerSec + OTHER_USD : 0;
  // engines that render one clip at a time add their clip time per on-camera beat
  const clips = Math.ceil((speechSec * FACE_SHARE) / BEAT_SEC);
  const minutes = words ? MINUTES + (a.parallel ? 0 : Math.round((clips * a.clipSec) / 60)) : 0;
  return { words, speechSec, minutes, costUsd: Math.round(costUsd * 100) / 100 };
}
