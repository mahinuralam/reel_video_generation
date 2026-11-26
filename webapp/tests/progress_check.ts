// Feeds recorded pipeline lines to the progress parser and checks what it reports.
// Usage: npx tsx tests/progress_check.ts     (no database, no network)
import { extractError, ProgressParser } from '../src/lib/progress';

let fails = 0;
const check = (cond: boolean, label: string, extra = '') => { console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label} ${cond ? '' : extra}`); if (!cond) fails++; };

// lines as src/make_video.sh, write_storyboard.py, make_reel.sh and render_face.py print them
const r = new ProgressParser();
for (const l of ['== 0/5 design', 'draft 1/3 with claude-opus-5-5 ...']) r.feed(l);
check(r.p.stage === 'design' && /draft 1/.test(r.p.detail), 'design step and draft shown');
r.feed('wrote reels/x/storyboard.json: 6 beats (2 on camera), 132 words (about 57 s), avatar on screen about 16 s');
check(r.designed && r.p.beatsTotal === 6 && r.p.faceTotal === 2, 'beats and on-camera beats read from the design');
const reuse = new ProgressParser();
reuse.feed('reels/x/storyboard.json: OK, 4 beats (1 on camera), 40 words (about 17 s), avatar on screen about 5 s');
check(reuse.designed && reuse.p.faceTotal === 1, 'a reused design (retry) is read too');
for (const l of ['== 1/5 speech', 'speech: 15.6 s in 2 take(s), 9.5 s -> outputs/reels/x/build/speech.wav', '== 2/5 timing', '== 3/5 face',
  '[face] hook: 4.64 s sent to HeyGen (gen-vid-1)', '[face] close: 3.32 s sent to HeyGen (gen-vid-2)']) r.feed(l);
check(r.speechSec === 15.6 && r.p.faceDone === 0 && r.p.pct === 10, 'speech length read; no avatar clip back yet');
r.feed('[ok] /x/build/face/hook.raw.mp4 in 92 s, cost $0.232');
check(r.p.faceDone === 1 && r.p.pct === Math.round(10 + 65 / 2) && r.p.costUsd === 0.232, `one clip back, its cost added (${r.p.pct}%, $${r.p.costUsd})`);
r.feed('[ok] /x/build/face/close.raw.mp4 in 95 s, cost $0.166');
check(r.p.faceDone === 2 && r.p.costUsd === 0.398 && r.p.etaSec === 60, `both clips back, costs summed ($${r.p.costUsd})`);
const skip = new ProgressParser();
skip.feed('== 3/5 face'); skip.feed('[skip] hook: /x/build/face/hook.raw.mp4 exists');
check(skip.p.faceDone === 1 && skip.p.costUsd === 0, 'a reused clip (retry) counts as done, at no cost');
for (const l of ['== 4/5 visuals', 'hook: 70 frames in 13 s -> /x/build/clips/hook.mp4']) r.feed(l);
check(r.p.stage === 'visuals' && r.p.visualsDone === 1, 'graphics progress counted');
r.feed('== 5/5 assemble');
r.feed('[music] /x/build/music.mp3: "Calm lo-fi, 80 BPM, soft piano, no vocals", cost $0.040');
check(r.p.costUsd === 0.438, `the music's cost is added ($${r.p.costUsd})`);
r.feed('[OK] outputs/reels/x/x.mp4  (6.40 s, 160 frames)');
check(r.outputPath === 'outputs/reels/x/x.mp4', 'output path read');

check(/HeyGen could not make/.test(extractError(['[face] hook: 4.64 s sent to HeyGen (gen-vid-1)', "Error: HeyGen could not make the clip for beat 'hook' (failed): bad photo"])), 'error: a failed HeyGen clip is reported');
check(/HTTP 402/.test(extractError(['Error: OpenRouter returned HTTP 402 for heygen/heygen-avatar-6-turbo: {"error":{"message":"credits"}}'])), 'error: an OpenRouter error is reported');
check(/rejected ANTHROPIC_API_KEY/.test(extractError(['draft 1/3 with claude-opus-5-5 ...', 'the Anthropic API rejected ANTHROPIC_API_KEY; check the key in .env'])), 'error: a bad Anthropic key is reported');

console.log(fails ? `${fails} failed` : 'all passed');
process.exit(fails ? 1 : 0);
