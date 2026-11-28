#!/usr/bin/env node
// Stand-in for src/make_video.sh when MOCK=1: no API calls. "Designs" with the example storyboard,
// prints the same progress lines as the real pipeline on a fast clock, and makes a tone as the speech
// and a short test-pattern video as the result (with ffmpeg), so the app can be tried and tested on a
// fresh install.
//
// Usage (the worker calls it, with cwd = project root):
//   node mock_pipeline.mjs <name> <out_dir>   env FFMPEG, MOCK_SPEECH_SEC, MOCK_SEG_MS, MOCK_FAIL_AT, REF_AUDIO,
//   MOCK_AVATAR (the avatar model's short name), MOCK_USD_PER_SEC
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const [name, outDir] = process.argv.slice(2);
const ROOT = process.cwd();
const FFMPEG = process.env.FFMPEG || 'ffmpeg';
const SEG_MS = Number(process.env.MOCK_SEG_MS || 1500);
const FAIL_AT = Number(process.env.MOCK_FAIL_AT || 0);
const EXAMPLE = 'src/reel/example_storyboard.json';
const AVATAR = process.env.MOCK_AVATAR || 'HeyGen';
const USD_PER_SEC = Number(process.env.MOCK_USD_PER_SEC || 0.05);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = (s) => process.stdout.write(s + '\n');
const err = (s) => process.stderr.write(s);
const relOut = (f) => path.relative(ROOT, path.join(outDir, f));
const ffmpeg = (...args) => execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...args]);

fs.mkdirSync(outDir, { recursive: true });

out('== 0/5 design');
out('draft 1/3 with claude-opus-5-5 ...');
await sleep(3000);
const sb = { ...JSON.parse(fs.readFileSync(EXAMPLE, 'utf8')), name };
fs.writeFileSync(path.join(outDir, 'storyboard.json'), JSON.stringify(sb, null, 4) + '\n');
const words = (b) => b.lines.join(' ').split(/\s+/).length;
const total = sb.beats.reduce((n, b) => n + words(b), 0);
const sec = Number(process.env.MOCK_SPEECH_SEC || 10);
const beats = sb.beats.map((b) => ({ id: b.id, type: b.type, sec: (sec * words(b)) / total }));
const faces = beats.filter((b) => b.type === 'face' || b.type === 'split');
out(`wrote ${relOut('storyboard.json')}: ${beats.length} beats (${faces.length} on camera), ${total} words`);

out('== 1/5 speech');
out(`voice clip: ${process.env.REF_AUDIO}`);
ffmpeg('-f', 'lavfi', '-i', `sine=frequency=220:duration=${sec.toFixed(2)}`, '-ac', '1', '-ar', '24000', path.join(outDir, 'speech.wav'));
await sleep(800);
out(`speech: ${sec.toFixed(1)} s in 1 take(s), 0.8 s -> ${relOut('speech.wav')}`);
out('== 2/5 timing');
await sleep(600);
out('== 3/5 face');
for (const b of faces) out(`[face] ${b.id}: ${b.sec.toFixed(2)} s sent to ${AVATAR} (mock-${b.id})`);
for (const [i, b] of faces.entries()) {
  await sleep(SEG_MS);
  if (FAIL_AT === i + 1) {
    err(`Error: ${AVATAR} could not make the clip for beat '${b.id}' (failed): simulated failure, the script contains FAIL_TEST\n`);
    process.exit(1);
  }
  out(`[ok] ${relOut(`build/face/${b.id}.raw.mp4`)} in ${(SEG_MS / 1000).toFixed(0)} s, cost $${(b.sec * USD_PER_SEC).toFixed(3)}`);
}
out('== 4/5 visuals');
for (const b of beats) { await sleep(300); out(`${b.id}: ${Math.round(b.sec * 25)} frames in 12 s -> ${relOut(`build/clips/${b.id}.mp4`)}`); }
out('== 5/5 assemble');
out(`[music] ${relOut('build/music.mp3')}: "${sb.music}", cost $0.040`);
ffmpeg('-f', 'lavfi', '-i', 'testsrc2=size=1080x1920:rate=25:duration=5', '-i', path.join(outDir, 'speech.wav'),
  '-t', '5', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', path.join(outDir, `${name}.mp4`));
out(`[OK] ${relOut(`${name}.mp4`)}  (5.00 s, 125 frames)`);
