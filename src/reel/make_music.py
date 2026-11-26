#!/usr/bin/env python
"""Make the background music for a reel with Google Lyria 3 on OpenRouter: a 30 s instrumental from
the storyboard's "music" brief (written by Claude), saved as outputs/reels/<name>/build/music.mp3.
assemble.py loops it under the speech. $0.04 per clip; an existing music.mp3 is reused. A storyboard
without a "music" brief gets no music.

Needs OPENROUTER_API_KEY in the environment (src/setup/common.sh loads the project's .env).
Standard library only:
    python src/reel/make_music.py --timeline outputs/reels/<name>/build/timeline.json
"""
import argparse
import base64
import json
import os
import sys
import urllib.error
import urllib.request

MODEL = "google/lyria-3-clip-preview"
TRIES = 3  # Lyria now and then ends a stream without audio; the next request usually works


def generate(brief: str, key: str) -> tuple[bytes, float, str]:
    """One streamed Lyria request -> (mp3 bytes, cost, problem). Lyria returns its audio only on a
    streamed response, as base64 MP3 in the deltas."""
    body = {"model": MODEL, "modalities": ["audio", "text"], "stream": True, "messages": [{"role": "user", "content": brief}]}
    req = urllib.request.Request("https://openrouter.ai/api/v1/chat/completions", data=json.dumps(body).encode(), method="POST",
                                 headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"})
    chunks, cost, problem = [], 0.0, "no audio in the response"
    try:
        with urllib.request.urlopen(req, timeout=300) as r:
            for raw in r:
                line = raw.decode().strip()
                if not line.startswith("data: ") or line == "data: [DONE]":
                    continue
                event = json.loads(line[6:])
                cost = (event.get("usage") or {}).get("cost", cost)
                if event.get("error"):
                    problem = f"error: {json.dumps(event['error'])[:300]}"
                for choice in event.get("choices", []):
                    data = (choice.get("delta", {}).get("audio") or {}).get("data")
                    if data:
                        chunks.append(data)
                    if choice.get("finish_reason") not in (None, "stop"):
                        problem = f"finish reason {choice['finish_reason']}"
    except urllib.error.HTTPError as e:
        return b"", cost, f"HTTP {e.code}: {e.read().decode(errors='replace')[:300]}"
    except urllib.error.URLError as e:
        return b"", cost, f"could not reach OpenRouter: {e.reason}"
    return base64.b64decode("".join(chunks)), cost, problem


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--timeline", required=True)
    ap.add_argument("--force", action="store_true", help="make new music even if music.mp3 exists")
    args = ap.parse_args()

    with open(args.timeline, encoding="utf-8") as f:
        brief = json.load(f).get("music")
    out = os.path.join(os.path.dirname(os.path.abspath(args.timeline)), "music.mp3")
    if not brief:
        print("[music] none: the storyboard has no music brief")
        return
    if os.path.exists(out) and not args.force:
        print(f"[music] reusing {out}")
        return
    key = os.environ.get("OPENROUTER_API_KEY", "").strip()
    if not key:
        sys.exit("Error: OPENROUTER_API_KEY is not set; put it in the project's .env")

    total = 0.0
    for attempt in range(1, TRIES + 1):
        mp3, cost, problem = generate(brief, key)
        total += cost
        if mp3:
            with open(out, "wb") as f:
                f.write(mp3)
            print(f"[music] {out}: \"{brief}\", cost ${total:.3f}")
            return
        print(f"[warn] music try {attempt} of {TRIES}: {problem}", flush=True)
    sys.exit(f"Error: {MODEL} gave no music after {TRIES} tries ({problem}); the video is fine without it: "
             f"remove \"music\" from the storyboard and press Retry")


if __name__ == "__main__":
    main()
