// Time and cost estimates. The beats with the avatar (face and split screen) need a clip from HeyGen
// Avatar 6 Turbo, $0.05 per second; Claude keeps them to at most about 70% of the words. The clips
// render in parallel, about a minute and a half; the rest (design, voice, timing, graphics,
// assembly) takes about three more minutes.

export const WORDS_PER_SEC = 2.5;   // cloned voice: ~140 words in 56 s
const FACE_SHARE = 0.65;
const HEYGEN_USD_PER_SEC = 0.05;
const OTHER_USD = 0.15;             // Claude's design, the voice and the music ($0.04), a few cents each
const MINUTES = 5;

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
export function estimateVideo(script: string) {
  const words = countWords(script);
  const speechSec = words / WORDS_PER_SEC;
  const costUsd = words ? speechSec * FACE_SHARE * HEYGEN_USD_PER_SEC + OTHER_USD : 0;
  return { words, speechSec, minutes: words ? MINUTES : 0, costUsd: Math.round(costUsd * 100) / 100 };
}
