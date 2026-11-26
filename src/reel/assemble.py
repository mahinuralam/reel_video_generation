#!/usr/bin/env python
"""Join the beat clips in order and lay the sound under them:
  speech   compressed and brightened so it sits up front, at phone loudness
  effects  a whoosh on every cut and a soft pop whenever a graphic element appears on its cue
           (made here, written to build/sfx.wav)
  music    build/music.mp3 from make_music.py, if there is one: looped, pushed down while the voice
           speaks and back up in the pauses, faded in and out

Run in env/reel (FFMPEG and FFPROBE from src/setup/common.sh):
    python src/reel/assemble.py --timeline outputs/reels/<name>/build/timeline.json
Writes outputs/reels/<name>/<name>.mp4 (1080x1920, H.264 + AAC, ready to upload).
"""
import argparse
import json
import os
import subprocess

import numpy as np
import soundfile as sf

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
FFMPEG = os.environ.get("FFMPEG", "ffmpeg")
FFPROBE = os.environ.get("FFPROBE", "ffprobe")
SR = 48000


def whoosh(rng) -> np.ndarray:
    """0.45 s of noise swept up through a low-pass filter, peaking at 0.3 s (where the cut is)."""
    n = int(0.45 * SR)
    t = np.arange(n) / SR
    noise = rng.standard_normal(n)
    cutoff = 300 + 5000 * np.sin(np.pi * np.clip(t / 0.45, 0, 1)) ** 2
    alpha = 1 - np.exp(-2 * np.pi * cutoff / SR)
    out, y = np.empty(n), 0.0
    for i in range(n):
        y += alpha[i] * (noise[i] - y)
        out[i] = y
    env = np.where(t < 0.3, (t / 0.3) ** 2, np.exp(-(t - 0.3) / 0.05))
    out *= env
    return out / np.abs(out).max()


def pop() -> np.ndarray:
    """A short, soft bubble pop: a sine sweeping from 900 Hz down to 300 Hz over 90 ms."""
    n = int(0.09 * SR)
    t = np.arange(n) / SR
    phase = 2 * np.pi * np.cumsum(300 + 600 * np.exp(-t / 0.02)) / SR
    return np.sin(phase) * np.exp(-t / 0.025) * np.minimum(1, t / 0.002)


def cue_times(node) -> list[float]:
    """Every "at" / "*_at" time (seconds from the beat's start) that timing.py put next to a cue."""
    found = []
    if isinstance(node, dict):
        for k, v in node.items():
            if (k == "at" or k.endswith("_at")) and isinstance(v, (int, float)):
                found.append(float(v))
            else:
                found += cue_times(v)
    elif isinstance(node, list):
        for v in node:
            found += cue_times(v)
    return found


def make_sfx(tl: dict, duration: float, path: str) -> int:
    """Write the effects track (mono, 48 kHz) and return the number of effects in it."""
    track = np.zeros(int(duration * SR) + SR)
    rng = np.random.default_rng(7)
    events = [(b["start"] - 0.3, whoosh(rng), 0.22) for b in tl["beats"][1:]]
    events += [(b["start"] + t, pop(), 0.16) for b in tl["beats"]
               for t in cue_times([b.get("data"), b.get("overlay")])]
    for at, sound, gain in events:
        i = max(0, int(at * SR))
        piece = sound[: len(track) - i] * gain
        track[i:i + len(piece)] += piece
    sf.write(path, track[: int(duration * SR)].astype(np.float32), SR, subtype="PCM_16")
    return len(events)


def frame_count(path: str) -> int:
    out = subprocess.run(
        [FFPROBE, "-v", "error", "-select_streams", "v:0", "-count_frames", "-show_entries",
         "stream=nb_read_frames", "-of", "csv=p=0", path],
        check=True, capture_output=True, text=True,
    ).stdout.strip()
    return int(out)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--timeline", required=True)
    args = ap.parse_args()

    with open(args.timeline, encoding="utf-8") as f:
        tl = json.load(f)
    build = os.path.dirname(os.path.abspath(args.timeline))
    out = os.path.join(os.path.dirname(build), f"{tl['name']}.mp4")
    fps = tl["fps"]

    # every clip must be exactly as long as its beat, or picture and speech drift apart
    clips = []
    for beat in tl["beats"]:
        clip = os.path.join(build, "clips", f"{beat['id']}.mp4")
        want, got = beat["end_frame"] - beat["start_frame"], frame_count(clip)
        if got != want:
            raise SystemExit(f"beat '{beat['id']}': clip has {got} frames, timeline needs {want}")
        clips.append(clip)

    listing = os.path.join(build, "clips.txt")
    with open(listing, "w", encoding="utf-8") as f:
        f.writelines(f"file '{c}'\n" for c in clips)

    duration = tl["total_frames"] / fps
    sfx = os.path.join(build, "sfx.wav")
    effects = make_sfx(tl, duration, sfx)
    # speech: low cut, compressed and with a little presence so it sounds close and punchy, then a
    # phone loudness; padded with silence to the video length. loudnorm works at 192 kHz
    # internally, so the resample to 48 kHz has to come after it.
    speech = ("[1:a]highpass=f=80,acompressor=threshold=0.1:ratio=3:attack=5:release=120:makeup=2,"
              "equalizer=f=3500:t=q:w=1:g=3,loudnorm=I=-15:TP=-1.5:LRA=9,aresample=48000,apad")
    inputs = ["-i", sfx]
    music = os.path.join(build, "music.mp3")
    if os.path.exists(music):
        # music: looped, about 9 LU under the speech; the sidechain pulls it down while the voice is on
        # and lets it swell back in the pauses; 0.5 s fade in, 2 s fade out
        inputs += ["-stream_loop", "-1", "-i", music]
        audio = (f"{speech},asplit=2[sp][key];"
                 f"[3:a]loudnorm=I=-24:TP=-4:LRA=11,aresample=48000,"
                 f"afade=t=in:d=0.5,afade=t=out:st={max(0.0, duration - 2):.3f}:d=2[bed];"
                 f"[bed][key]sidechaincompress=threshold=0.03:ratio=4:attack=20:release=300[duck];"
                 f"[sp][duck][2:a]amix=inputs=3:duration=first:normalize=0[a]")
    else:
        audio = f"{speech}[sp];[sp][2:a]amix=inputs=2:duration=first:normalize=0[a]"
    subprocess.run(
        [FFMPEG, "-hide_banner", "-loglevel", "error", "-y",
         "-f", "concat", "-safe", "0", "-i", listing,
         "-i", os.path.join(ROOT, tl["speech"]), *inputs,
         "-filter_complex", audio,
         "-map", "0:v", "-map", "[a]", "-t", f"{duration:.3f}",
         "-c:v", "libx264", "-preset", "slow", "-crf", "18", "-pix_fmt", "yuv420p", "-r", str(fps),
         "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2", "-movflags", "+faststart", out],
        check=True,
    )
    print(f"sound effects: {effects}")
    print(f"[OK] {out}  ({duration:.2f} s, {tl['total_frames']} frames)")


if __name__ == "__main__":
    main()
