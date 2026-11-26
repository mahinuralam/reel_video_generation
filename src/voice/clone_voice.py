#!/usr/bin/env python
"""Speak a script in a cloned voice with Fish Audio S2.1 Pro on OpenRouter.

The voice is cloned from a short reference clip plus its exact words. Consecutive lines of the
script are spoken together in one take of up to --take-words words, so the voice flows from one
sentence to the next like one person talking; a short pause is only added between takes (very long
single generations are less stable).

A take can stop early and cut off its last word, so every take is transcribed back with Whisper
(src/voice/transcribe.py) and one that is missing words is generated again (up to --tries times);
the most complete one is kept.

Writes <out>.wav and <out>.json: {"sample_rate", "duration", "segments": one {text, start, end} per
take (text = its lines joined by spaces)}. src/reel/timing.py finds where each line falls inside a take.

Needs OPENROUTER_API_KEY in the environment (src/setup/common.sh loads the project's .env):
    python src/voice/clone_voice.py --ref-audio voice.wav --ref-text voice.txt \
        --script script.txt --out speech.wav
"""
import argparse
import base64
import difflib
import io
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request

import numpy as np
import soundfile as sf
from transcribe import transcribe

FFMPEG = os.environ.get("FFMPEG", "ffmpeg")
MODEL = "fish-audio/s2.1-pro"
SAMPLE_RATE = 24000


def read_lines(path: str) -> list[str]:
    with open(path, encoding="utf-8") as f:
        return [" ".join(line.split()) for line in f if line.strip()]


def group_takes(lines: list[str], max_words: int) -> list[str]:
    """Consecutive lines joined into takes of at most max_words words (a longer line is a take of its own)."""
    takes, cur, words = [], [], 0
    for line in lines:
        n = len(line.split())
        if cur and words + n > max_words:
            takes.append(" ".join(cur))
            cur, words = [], 0
        cur.append(line)
        words += n
    if cur:
        takes.append(" ".join(cur))
    return takes


def trim_silence(wav: np.ndarray, sr: int, threshold_db: float = -45.0, keep_head_s: float = 0.05, keep_tail_s: float = 0.15) -> np.ndarray:
    """Drop leading/trailing silence so the pauses between takes are the ones we insert.
    More is kept after the last loud sample, so soft word endings ("…s") are not clipped."""
    if wav.size == 0:
        return wav
    limit = 10 ** (threshold_db / 20)
    loud = np.flatnonzero(np.abs(wav) > limit)
    if loud.size == 0:
        return wav
    return wav[max(0, loud[0] - int(keep_head_s * sr)): min(len(wav), loud[-1] + int(keep_tail_s * sr))]


def norm(text: str) -> str:
    """Letters and digits only, lower case (as in src/reel/timing.py)."""
    return re.sub(r"[^a-z0-9]+", "", text.lower().replace("’", "'"))


def completeness(script: str, heard: str) -> float:
    """Share of the script's characters found, in order, in what Whisper heard. A missing last
    word counts double, since that is how a take usually fails."""
    want, got = norm(script), norm(heard)
    if not want:
        return 1.0
    matched = sum(b.size for b in difflib.SequenceMatcher(None, want, got, autojunk=False).get_matching_blocks())
    last = norm(script.split()[-1])
    tail_ok = not last or last in got[-(len(last) + 8):]
    return matched / len(want) * (1.0 if tail_ok else 0.5)


def speak(text: str, clip: str, ref_text: str, key: str) -> np.ndarray:
    """One take, cloning the reference clip (a data URI); mono float32 at SAMPLE_RATE, silence trimmed."""
    body = {"model": MODEL, "input": text, "response_format": "mp3", "input_references": [
        {"type": "input_audio", "input_audio": {"data": clip}}, {"type": "text", "text": ref_text}]}
    req = urllib.request.Request("https://openrouter.ai/api/v1/audio/speech", data=json.dumps(body).encode(), method="POST",
                                 headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=300) as r:
            mp3 = r.read()
    except urllib.error.HTTPError as e:
        sys.exit(f"Error: OpenRouter returned HTTP {e.code} for {MODEL}: {e.read().decode(errors='replace')[:400]}")
    except urllib.error.URLError as e:
        sys.exit(f"Error: could not reach OpenRouter: {e.reason}")
    pcm = subprocess.run([FFMPEG, "-hide_banner", "-loglevel", "error", "-i", "-", "-f", "f32le", "-ac", "1", "-ar", str(SAMPLE_RATE), "-"],
                         input=mp3, capture_output=True, check=True).stdout
    return trim_silence(np.frombuffer(pcm, dtype=np.float32).copy(), SAMPLE_RATE)


def score(text: str, wav: np.ndarray) -> tuple[float, str]:
    buf = io.BytesIO()
    sf.write(buf, wav, SAMPLE_RATE, format="WAV", subtype="PCM_16")
    heard = transcribe(buf.getvalue())["text"]
    return completeness(text, heard), heard


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--ref-audio", required=True, help="the voice to clone (wav, 10-20 s of clear speech)")
    ap.add_argument("--ref-text", required=True, help="text file with the exact words of --ref-audio")
    ap.add_argument("--script", required=True, help="text file to speak, one line per caption/timing unit")
    ap.add_argument("--out", required=True, help="output wav; the segment timings go next to it as .json")
    ap.add_argument("--pause", type=float, default=0.2, help="seconds of silence between takes")
    ap.add_argument("--take-words", type=int, default=45, help="most words spoken in one take")
    ap.add_argument("--tries", type=int, default=3, help="generations per take when words are missing")
    args = ap.parse_args()

    key = os.environ.get("OPENROUTER_API_KEY", "").strip()
    if not key:
        sys.exit("Error: OPENROUTER_API_KEY is not set; put it in the project's .env")
    with open(args.ref_text, encoding="utf-8") as f:
        ref_text = " ".join(f.read().split())
    with open(args.ref_audio, "rb") as f:
        clip = "data:audio/wav;base64," + base64.b64encode(f.read()).decode()
    takes = group_takes(read_lines(args.script), args.take_words)

    t0 = time.time()
    wavs = []
    for i, text in enumerate(takes):
        wav = speak(text, clip, ref_text, key)
        best, heard = score(text, wav)
        for attempt in range(2, args.tries + 1):
            if best >= 0.97:
                break
            print(f"take {i + 1}: words missing (heard \"{heard}\"), try {attempt}", flush=True)
            again = speak(text, clip, ref_text, key)
            s, h = score(text, again)
            if s > best:
                best, heard, wav = s, h, again
        if best < 0.97:
            print(f"[warn] take {i + 1} may still be missing words after {args.tries} tries: \"{heard}\"")
        wavs.append(wav)

    pause = np.zeros(int(args.pause * SAMPLE_RATE), dtype=np.float32)
    pieces, segments, cursor = [], [], 0.0
    for text, wav in zip(takes, wavs):
        segments.append({"text": text, "start": round(cursor, 3), "end": round(cursor + len(wav) / SAMPLE_RATE, 3)})
        pieces += [wav, pause]
        cursor += (len(wav) + len(pause)) / SAMPLE_RATE
    speech = np.concatenate(pieces[:-1])  # no pause after the last take
    speech = speech / (float(np.abs(speech).max()) or 1.0) * 0.89  # about -1 dBFS

    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    sf.write(args.out, speech, SAMPLE_RATE, subtype="PCM_16")
    with open(os.path.splitext(args.out)[0] + ".json", "w", encoding="utf-8") as f:
        json.dump({"sample_rate": SAMPLE_RATE, "duration": round(len(speech) / SAMPLE_RATE, 3), "segments": segments}, f, indent=2, ensure_ascii=False)
    print(f"speech: {len(speech) / SAMPLE_RATE:.1f} s in {len(takes)} take(s), {time.time() - t0:.1f} s -> {args.out}")


if __name__ == "__main__":
    main()
