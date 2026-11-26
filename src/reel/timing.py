#!/usr/bin/env python
"""Turn a storyboard + its speech into a frame-accurate timeline.

For every beat: start/end frame. For every spoken word: start/end time (from Whisper on OpenRouter,
run on each take's audio and aligned back to the exact script words). A take (one segment of the speech
timings) speaks one or more consecutive script lines without a break; where a line or beat
starts inside a take comes from these word times. From those: caption chunks and
the time of every "cue" in the storyboard (a cue names a spoken word; the visual it belongs to
appears when that word is said).

Run with any Python 3 (standard library; FFMPEG and OPENROUTER_API_KEY from src/setup/common.sh):
    python src/reel/timing.py --storyboard reels/<name>/storyboard.json \
        --speech outputs/reels/<name>/build/speech.wav --out outputs/reels/<name>/build/timeline.json
"""
import argparse
import difflib
import json
import math
import os
import re
import subprocess
import sys
import tempfile

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
FFMPEG = os.environ.get("FFMPEG", "ffmpeg")
sys.path.insert(0, os.path.join(ROOT, "src", "voice"))
from transcribe import transcribe  # noqa: E402


def norm(text: str) -> str:
    """Letters and digits only, lower case: what both the script and Whisper agree on."""
    return re.sub(r"[^a-z0-9]+", "", text.lower().replace("’", "'"))


def slice_audio(src: str, start: float, end: float, dst: str) -> None:
    subprocess.run(
        [FFMPEG, "-hide_banner", "-loglevel", "error", "-y", "-ss", f"{start:.3f}", "-to", f"{end:.3f}",
         "-i", src, "-ac", "1", "-ar", "16000", dst],
        check=True,
    )


def align_line(script_words: list[str], heard: list[dict], line_start: float, line_end: float) -> list[dict]:
    """Give each script word a start/end time using the words Whisper heard in the same audio."""
    # one time span per normalised character Whisper heard
    h_chars, h_start, h_end = [], [], []
    for w in heard:
        chars = norm(w["word"])
        if not chars or w["start"] is None:
            continue
        s, e = w["start"], w["end"] if w["end"] is not None else w["start"] + 0.2
        for i, ch in enumerate(chars):
            h_chars.append(ch)
            h_start.append(s + (e - s) * i / len(chars))
            h_end.append(s + (e - s) * (i + 1) / len(chars))
    s_spans, s_chars = [], []
    for w in script_words:
        chars = norm(w)
        s_spans.append((len(s_chars), len(s_chars) + len(chars)))
        s_chars.extend(chars)

    s_str, h_str = "".join(s_chars), "".join(h_chars)
    mapping = [None] * len(s_chars)
    matched = 0
    for a, b, size in difflib.SequenceMatcher(None, s_str, h_str, autojunk=False).get_matching_blocks():
        for k in range(size):
            mapping[a + k] = b + k
        matched += size

    duration = line_end - line_start
    if not s_chars or matched / len(s_chars) < 0.6:
        # Whisper did not hear this line reliably (very short lines): spread words by length.
        total = sum(max(1, b - a) for a, b in s_spans)
        out, cursor = [], 0
        for word, (a, b) in zip(script_words, s_spans):
            n = max(1, b - a)
            out.append({"w": word, "s": line_start + duration * cursor / total,
                        "e": line_start + duration * (cursor + n) / total})
            cursor += n
        return out

    out = []
    for word, (a, b) in zip(script_words, s_spans):
        idx = [mapping[i] for i in range(a, b) if mapping[i] is not None]
        if idx:
            s, e = line_start + h_start[idx[0]], line_start + h_end[idx[-1]]
        else:  # punctuation-only or unheard word: sits right after the previous one
            prev = out[-1]["e"] if out else line_start
            s, e = prev, prev + 0.05
        out.append({"w": word, "s": s, "e": e})

    # Whisper tends to stretch a word backwards over a pause; cap implausibly long words.
    for item in out:
        longest = 0.11 * max(1, len(norm(item["w"]))) + 0.35
        if item["e"] - item["s"] > longest:
            item["s"] = item["e"] - longest
    # keep times ordered and inside the line
    prev = line_start
    for item in out:
        item["s"] = min(max(item["s"], prev), line_end)
        item["e"] = min(max(item["e"], item["s"] + 0.03), line_end + 0.05)
        prev = item["s"]
    return out


def find_cue(words: list[dict], cue: str, beat_id: str) -> float:
    target, _, nth = cue.partition("#")
    nth = int(nth) if nth else 1
    hits = [w for w in words if norm(w["w"]) == norm(target)]
    if len(hits) < nth:
        spoken = " ".join(w["w"] for w in words)
        raise SystemExit(f"beat '{beat_id}': cue '{cue}' is not spoken in this beat. Spoken: {spoken}")
    return hits[nth - 1]["s"]


def resolve_cues(node, words: list[dict], beat_start: float, beat_id: str, lead: float = 0.12) -> None:
    """Add "at" (seconds from the beat's start) next to every "cue"/"*_cue" in the beat's data."""
    if isinstance(node, dict):
        for key in list(node.keys()):
            if key == "cue" or key.endswith("_cue"):
                at_key = "at" if key == "cue" else key[:-4] + "_at"
                node[at_key] = round(max(0.0, find_cue(words, node[key], beat_id) - beat_start - lead), 3)
            else:
                resolve_cues(node[key], words, beat_start, beat_id, lead)
    elif isinstance(node, list):
        for item in node:
            resolve_cues(item, words, beat_start, beat_id, lead)


def caption_chunks(lines_words: list[list[dict]], max_words: int = 4, max_chars: int = 26) -> list[dict]:
    """Short caption groups: break at sentence punctuation, commas, and after a few words."""
    chunks = []
    for words in lines_words:
        cur = []
        for w in words:
            length = sum(len(x["w"]) + 1 for x in cur) + len(w["w"])
            if cur and (len(cur) >= max_words or length > max_chars):
                chunks.append(cur)
                cur = []
            cur.append(w)
            if re.search(r"[.!?]$", w["w"]) or (re.search(r"[,;:]$", w["w"]) and len(cur) >= 2):
                chunks.append(cur)
                cur = []
        if cur:
            chunks.append(cur)
    out = []
    for i, c in enumerate(chunks):
        end = c[-1]["e"] + 0.25
        if i + 1 < len(chunks):
            end = min(end, chunks[i + 1][0]["s"])
        out.append({"s": round(c[0]["s"], 3), "e": round(max(end, c[-1]["e"]), 3),
                    "words": [{"w": w["w"], "s": round(w["s"], 3), "e": round(w["e"], 3)} for w in c]})
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--storyboard", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--speech", required=True, help="speech wav from clone_voice.py (its .json sits next to it)")
    args = ap.parse_args()

    with open(args.storyboard, encoding="utf-8") as f:
        sb = json.load(f)
    with open(os.path.splitext(args.speech)[0] + ".json", encoding="utf-8") as f:
        speech = json.load(f)
    fps, tail = sb.get("fps", 25), sb.get("tail", 0.6)
    segments = speech["segments"]  # one per take, in order; a take speaks one or more consecutive lines

    lines = [(b["id"], line) for b in sb["beats"] for line in b["lines"]]
    takes, k = [], 0  # takes[i] = indices of the lines segment i speaks
    for seg in segments:
        first, spoken = k, ""
        while k < len(lines) and len(norm(spoken)) < len(norm(seg["text"])):
            spoken += " " + lines[k][1]
            k += 1
        if norm(spoken) != norm(seg["text"]):
            beat_id = lines[first][0] if first < len(lines) else "-"
            raise SystemExit(f"beat '{beat_id}': lines do not match the spoken take:\n  {spoken.strip()}\n  {seg['text']}")
        takes.append(list(range(first, k)))
    if k != len(lines):
        raise SystemExit(f"storyboard has {len(lines)} lines but the speech covers {k}")

    # Word timings only depend on the speech and its text, so they are cached next to the timeline.
    # Editing graphics in the storyboard and re-running then costs nothing.
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    cache_path = os.path.join(os.path.dirname(os.path.abspath(args.out)), "words.json")
    cache_key = {"speech": args.speech, "duration": speech["duration"], "lines": [line for _, line in lines]}
    line_words = None
    if os.path.exists(cache_path):
        with open(cache_path, encoding="utf-8") as f:
            cached = json.load(f)
        if cached.get("key") == cache_key:
            line_words = cached["line_words"]
            print(f"word timings: reused {cache_path}")
    if line_words is None:
        line_words = []
        with tempfile.TemporaryDirectory() as tmp:
            for i, (take, seg) in enumerate(zip(takes, segments)):
                wav = os.path.join(tmp, f"take{i}.wav")
                slice_audio(args.speech, seg["start"], seg["end"], wav)
                with open(wav, "rb") as f:
                    heard = transcribe(f.read())["words"]
                if not heard:
                    print(f"[warn] take {i}: no word times came back; spreading words evenly")
                words = align_line(" ".join(lines[j][1] for j in take).split(), heard, seg["start"], seg["end"])
                for j in take:  # the take's words back into its lines
                    n = len(lines[j][1].split())
                    line_words.append(words[:n])
                    words = words[n:]
        with open(cache_path, "w", encoding="utf-8") as f:
            json.dump({"key": cache_key, "line_words": line_words}, f, ensure_ascii=False)

    # where each line starts and ends: its take's edges, or inside a take the words around it
    line_start, line_end = [0.0] * len(lines), [0.0] * len(lines)
    for take, seg in zip(takes, segments):
        for j in take:
            line_start[j] = seg["start"] if j == take[0] else line_words[j][0]["s"]
            line_end[j] = seg["end"] if j == take[-1] else line_words[j][-1]["e"]

    # beat boundaries: the middle of the pause between the last line of one beat and the first of the next
    total = speech["duration"] + tail
    beats, k = [], 0
    for b in sb["beats"]:
        n = len(b["lines"])
        beats.append({"spec": b, "first": k, "last": k + n - 1})
        k += n
    bounds = [0.0]
    for prev, nxt in zip(beats, beats[1:]):
        bounds.append((line_end[prev["last"]] + line_start[nxt["first"]]) / 2)
    bounds.append(total)
    frames = [round(t * fps) for t in bounds]
    frames[-1] = math.ceil(total * fps)

    out_beats = []
    for i, b in enumerate(beats):
        spec = json.loads(json.dumps(b["spec"]))  # deep copy
        words = [w for j in range(b["first"], b["last"] + 1) for w in line_words[j]]
        start = frames[i] / fps
        resolve_cues(spec.get("data", {}), words, start, spec["id"])
        resolve_cues(spec.get("overlay", {}), words, start, spec["id"])
        out_beats.append({**spec, "start_frame": frames[i], "end_frame": frames[i + 1],
                          "start": round(start, 3), "end": round(frames[i + 1] / fps, 3)})

    timeline = {
        "name": sb["name"], "topic": sb.get("topic", ""), "fps": fps, "size": [1080, 1920],
        "speech": args.speech, "speech_duration": speech["duration"], "face_template": sb.get("face_template"),
        "music": sb.get("music"),
        "total_frames": frames[-1], "beats": out_beats, "captions": caption_chunks(line_words),
    }
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(timeline, f, indent=1, ensure_ascii=False)

    for b in out_beats:
        print(f"{b['id']:10s} {b['type']:6s} {b['start']:6.2f}-{b['end']:6.2f} s  frames {b['start_frame']}-{b['end_frame']}")
    print(f"{len(timeline['captions'])} caption chunks, {frames[-1]} frames -> {args.out}")


if __name__ == "__main__":
    main()
