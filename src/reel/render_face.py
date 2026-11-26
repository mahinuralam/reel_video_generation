#!/usr/bin/env python
"""Render the avatar only for the beats where the face is on screen, with HeyGen Avatar 6 Turbo on
OpenRouter.

For each "face" or "split" beat in the timeline: cut that stretch of the speech, send it with the template's
photo and prompt to HeyGen (all beats at once, so they render in parallel), wait, and keep the clip
at outputs/reels/<name>/build/face/<beat>.raw.mp4. The clip follows the photo's shape (a 9:16
portrait gives a 9:16 clip). Beats that already have a clip are skipped, so a re-run after changing
only the graphics costs nothing. HeyGen charges $0.05 per second of clip.

Needs OPENROUTER_API_KEY in the environment (make_reel.sh loads the project's .env). Standard
library and ffmpeg only:
    python src/reel/render_face.py --timeline outputs/reels/<name>/build/timeline.json
"""
import argparse
import base64
import json
import mimetypes
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
FFMPEG = os.environ.get("FFMPEG", "ffmpeg")
API = "https://openrouter.ai/api/v1"
MODEL = "heygen/heygen-avatar-6-turbo"
POLL_S = 10
TIMEOUT_S = 20 * 60


def request(key: str, url: str, body: dict | None = None, raw: bool = False):
    """GET (or POST body) an OpenRouter URL; JSON back, or the bytes when raw."""
    req = urllib.request.Request(url, data=json.dumps(body).encode() if body else None, method="POST" if body else "GET",
                                 headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=300) as r:
            return r.read() if raw else json.load(r)
    except urllib.error.HTTPError as e:
        sys.exit(f"Error: OpenRouter returned HTTP {e.code} for {MODEL}: {e.read().decode(errors='replace')[:400]}")
    except urllib.error.URLError as e:
        sys.exit(f"Error: could not reach OpenRouter: {e.reason}")


def data_uri(path: str, mime: str | None = None) -> str:
    mime = mime or mimetypes.guess_type(path)[0] or "application/octet-stream"
    with open(path, "rb") as f:
        return f"data:{mime};base64,{base64.b64encode(f.read()).decode()}"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--timeline", required=True)
    ap.add_argument("--force", action="store_true", help="render again even if a clip exists")
    args = ap.parse_args()

    with open(args.timeline, encoding="utf-8") as f:
        tl = json.load(f)
    build = os.path.dirname(os.path.abspath(args.timeline))
    face_dir = os.path.join(build, "face")
    os.makedirs(face_dir, exist_ok=True)
    with open(os.path.join(ROOT, tl["face_template"]), encoding="utf-8") as f:
        template = json.load(f)
    photo = data_uri(os.path.join(ROOT, template["cond_image"]))
    key = os.environ.get("OPENROUTER_API_KEY", "").strip()
    if not key:
        sys.exit("Error: OPENROUTER_API_KEY is not set; put it in the project's .env")

    jobs = {}  # beat id -> (job, raw path, submitted at)
    for beat in tl["beats"]:
        if beat["type"] not in ("face", "split"):
            continue
        raw = os.path.join(face_dir, f"{beat['id']}.raw.mp4")
        if os.path.exists(raw) and not args.force:
            print(f"[skip] {beat['id']}: {raw} exists")
            continue
        duration = beat["end"] - beat["start"]
        speech_part = max(0.0, min(duration, tl["speech_duration"] - beat["start"]))
        audio = os.path.join(face_dir, f"{beat['id']}.mp3")
        subprocess.run(
            [FFMPEG, "-hide_banner", "-loglevel", "error", "-y", "-ss", f"{beat['start']:.3f}", "-t", f"{speech_part:.3f}",
             "-i", os.path.join(ROOT, tl["speech"]), "-ac", "1", "-b:a", "128k", audio],
            check=True,
        )
        job = request(key, f"{API}/videos", {
            "model": MODEL, "prompt": template["prompt"], "resolution": "1080p",
            "input_references": [
                {"type": "image_url", "image_url": {"url": photo}},
                {"type": "audio_url", "audio_url": {"url": data_uri(audio, "audio/mpeg")}},
            ],
        })
        jobs[beat["id"]] = (job, raw, time.time())
        print(f"[face] {beat['id']}: {duration:.2f} s sent to HeyGen ({job['id']})", flush=True)

    while jobs:
        time.sleep(POLL_S)
        for beat_id, (job, raw, t0) in list(jobs.items()):
            status = request(key, job["polling_url"])
            state = status.get("status")
            if state == "completed":
                with open(raw, "wb") as f:
                    f.write(request(key, f"{API}/videos/{job['id']}/content?index=0", raw=True))
                cost = (status.get("usage") or {}).get("cost") or 0
                print(f"[ok] {raw} in {time.time() - t0:.0f} s, cost ${cost:.3f}", flush=True)
                del jobs[beat_id]
            elif state in ("failed", "cancelled", "expired"):
                sys.exit(f"Error: HeyGen could not make the clip for beat '{beat_id}' ({state}): {status.get('error', '')}")
            elif time.time() - t0 > TIMEOUT_S:
                sys.exit(f"Error: HeyGen took over {TIMEOUT_S // 60} min for beat '{beat_id}' ({job['id']})")


if __name__ == "__main__":
    main()
