// Turns the pipeline's console output into a progress record. The patterns are the lines that
// src/make_video.sh, src/reel/write_storyboard.py, src/make_reel.sh, src/reel/render_face.py and
// src/reel/make_music.py print.
import type { Progress } from './types';

const RE = {
  stage: /^== (\d)\/(\d) (\w+)/,
  draft: /^draft (\d+)\/(\d+) with/,
  designed: /: (?:OK, )?(\d+) beats \((\d+) on camera\)/,
  voiceTake: /^speech: ([\d.]+) s in/,
  faceDone: /^\[(ok|skip)\] /,
  cost: /cost \$([\d.]+)/,
  visual: /^([A-Za-z0-9_]+): \d+ frames in [\d.]+ s ->/,
  ok: /^\[OK\] (\S+)/,
};

const STAGES = ['design', 'speech', 'timing', 'face', 'visuals', 'assemble'];
const CLIP_SEC = 90; // HeyGen renders the avatar clips in parallel; one took about a minute and a half

export function initialProgress(): Progress {
  return { stage: 'queued', pct: 0, detail: 'Waiting to start', faceDone: 0, faceTotal: 0, visualsDone: 0, beatsTotal: 0, costUsd: 0, etaSec: null };
}

export class ProgressParser {
  p: Progress = initialProgress();
  speechSec: number | null = null;
  outputPath: string | null = null;
  /** True once Claude's storyboard exists, so the worker can show it. */
  designed = false;

  /** Feed one line of output; returns true when the progress changed. */
  feed(raw: string): boolean {
    const line = raw.trim();
    if (!line) return false;
    const p = this.p;
    let m: RegExpMatchArray | null;
    // HeyGen clips and the music print what they cost
    const cost = line.match(RE.cost);
    if (cost) p.costUsd = Math.round((p.costUsd + parseFloat(cost[1])) * 1000) / 1000;

    if ((m = line.match(RE.stage))) {
      if (!STAGES.includes(m[3])) return false;
      p.stage = m[3];
    } else if ((m = line.match(RE.draft))) {
      p.detail = `Claude is designing the video (draft ${m[1]} of up to ${m[2]})`;
      return true;
    } else if ((m = line.match(RE.designed))) {
      p.beatsTotal = parseInt(m[1], 10);
      p.faceTotal = parseInt(m[2], 10);
      this.designed = true;
    } else if ((m = line.match(RE.voiceTake))) {
      this.speechSec = parseFloat(m[1]);
    } else if (RE.faceDone.test(line)) {
      p.faceDone += 1;
    } else if ((m = line.match(RE.visual))) {
      p.visualsDone += 1;
    } else if ((m = line.match(RE.ok))) {
      this.outputPath = m[1];
    } else {
      return !!cost;
    }
    this.update();
    return true;
  }

  private update() {
    const p = this.p;
    p.etaSec = null;
    switch (p.stage) {
      case 'design': p.pct = 1; p.detail = p.faceTotal ? `Claude designed ${p.beatsTotal} beats` : 'Claude is designing the video'; break;
      case 'speech': p.pct = 3; p.detail = 'Generating the voice'; break;
      case 'timing': p.pct = 6; p.detail = 'Timing words, captions and cues'; break;
      case 'face':
        p.pct = Math.round(10 + 65 * (p.faceTotal ? p.faceDone / p.faceTotal : 1));
        p.detail = `Avatar clips from HeyGen: ${p.faceDone} of ${p.faceTotal} ready`;
        p.etaSec = (p.faceDone < p.faceTotal ? CLIP_SEC : 0) + 60;
        break;
      case 'visuals':
        p.pct = Math.round(76 + 20 * (p.visualsDone / Math.max(1, p.beatsTotal)));
        p.detail = `Drawing graphics and captions (${p.visualsDone} of ${p.beatsTotal || '?'} beats)`;
        p.etaSec = Math.round((Math.max(1, p.beatsTotal) - p.visualsDone) * 12 + 15);
        break;
      case 'assemble': p.pct = 97; p.detail = 'Putting the video together'; p.etaSec = 15; break;
    }
  }
}

/** Pick the most useful error line from the end of a failed run's log. */
export function extractError(tail: string[]): string {
  const lines = tail.map((l) => l.trim()).filter(Boolean);
  const patterns = [/^beat '.*$/, /^storyboard has .*$/, /Anthropic API.*|Claude declined.*|no valid storyboard.*/, /Error: .*/, /^\w*Error\b.*/, /Killed/];
  for (const re of patterns) {
    for (let i = lines.length - 1; i >= 0; i--) {
      const m = lines[i].match(re);
      if (m) return m[0].slice(0, 400);
    }
  }
  return (lines[lines.length - 1] || 'The pipeline stopped with an error').slice(0, 400);
}
