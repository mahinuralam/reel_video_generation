// Shared shapes for jobs and the saved images and voices (used by the UI, the API and the worker).

export type JobStatus = 'queued' | 'running' | 'done' | 'failed' | 'canceled';

/** One beat of a storyboard: the words spoken during it, on camera ("face") or over a graphic. */
export interface Beat {
  id: string;
  type: 'face' | 'split' | 'visual';
  lines: string[];
  scene?: string;                                   // visual and split beats: checklist | grid | chat | callout
  data?: { title?: string };
  overlay?: { kind: string; title?: string };       // face beats: lower_third | keywords
}

// What a video is made from; beats are filled in once Claude has designed it.
export interface JobInput { script: string; photoId: string; voiceId: string; beats?: Beat[] }

export interface Progress {
  stage: string;        // queued | design | speech | timing | face | visuals | assemble | done
  pct: number;          // 0..100
  detail: string;       // one human line, e.g. "Avatar clips from HeyGen: 1 of 2 ready"
  faceDone: number;     // avatar clips back from HeyGen
  faceTotal: number;    // on-camera beats in Claude's design
  visualsDone: number;
  beatsTotal: number;
  costUsd: number;      // what HeyGen and the music charged so far
  etaSec?: number | null;
}

export interface JobOutput {
  video: string;        // project-relative path of the mp4
  durationSec: number | null;
  width: number | null;
  height: number | null;
}

export interface Job {
  _id: string;
  name: string;
  status: JobStatus;
  input: JobInput;
  estimate: { speechSec: number; minutes: number; costUsd: number };
  progress: Progress;
  speechSec?: number | null;
  speechPath?: string | null;
  output?: JobOutput | null;
  logPath?: string | null;
  error?: string | null;
  cancelRequested?: boolean;
  mock?: boolean;
  attempts?: number;
  createdAt: string;
  queuedAt: string;
  startedAt?: string | null;
  finishedAt?: string | null;
}

export interface Photo { id: string; label: string; file: string; prompt: string; source?: string; uploaded?: boolean }

/** A voice to clone: a short clip of someone speaking plus (once known) its exact words. */
export interface Voice {
  id: string;
  label: string;
  file: string;         // project-relative wav
  textFile: string;     // project-relative txt with the clip's words; Whisper writes it on first use if missing
  text?: string;        // filled in by the API from textFile when it exists
  sec: number | null;
  uploaded?: boolean;
}

export interface Profile {
  _id: 'default';
  photos: Photo[];
  defaultPhotoId: string;
  voices: Voice[];
  defaultVoiceId: string;
  updatedAt: string;
}

/** A script used before (inputs/scripts/*.txt), offered as a starting point. */
export interface ScriptTemplate { id: string; label: string; text: string; words: number }

export interface WorkerInfo {
  online: boolean;
  state: string;        // idle | running | offline
  mock: boolean;
  heartbeatAt: string | null;
  currentJob?: string | null;
}
