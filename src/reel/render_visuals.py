#!/usr/bin/env python
"""Draw every beat of the reel as a 1080x1920 clip.

Each frame is the stage page (src/reel/stage/) set to that frame's time and screenshotted in
headless Chrome, then piped straight into ffmpeg.

  graphic beats: the page is the whole picture.
  face beats:    the page is a transparent layer (captions + overlay) composited over the avatar
                 clip, which is scaled to fill the frame.
  split beats:   the page draws the graphic in the top half; the avatar's head and shoulders fill the
                 bottom half (from y 900), over a blurred copy of the clip.

Run in env/reel (FFMPEG from src/setup/common.sh):
    python src/reel/render_visuals.py --timeline outputs/reels/<name>/build/timeline.json
    python src/reel/render_visuals.py --timeline ... --beats assistant uses   # only some beats
    python src/reel/render_visuals.py --timeline ... --still 12.5 --out frame.png  # one frame, for checking
"""
import argparse
import json
import os
import shutil
import subprocess
import sys
import time
from concurrent.futures import ProcessPoolExecutor

from playwright.sync_api import sync_playwright

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
FFMPEG = os.environ.get("FFMPEG", "ffmpeg")
STAGE_URL = "file://" + os.path.join(ROOT, "src", "reel", "stage", "index.html")
ENCODE = ["-c:v", "libx264", "-preset", "medium", "-crf", "15", "-pix_fmt", "yuv420p"]


def shoot(page, t: float, transparent: bool, tries: int = 4) -> bytes:
    """Set the stage to time t and screenshot it; Chrome occasionally refuses a capture under load."""
    for attempt in range(tries):
        try:
            page.evaluate("t => Stage.render(t)", t)
            return page.screenshot(type="png", omit_background=transparent)
        except Exception as exc:  # noqa: BLE001 - Playwright raises its own Error type
            if attempt == tries - 1:
                raise
            print(f"[retry] screenshot at {t:.2f}s failed ({str(exc).splitlines()[0]})", file=sys.stderr, flush=True)
            time.sleep(0.5 * (attempt + 1))


def open_stage(p, timeline: dict, beat_id: str):
    # --disable-gpu: draw in software, so renders are identical from run to run on any machine.
    kwargs = {"headless": True,
              "args": ["--allow-file-access-from-files", "--force-color-profile=srgb", "--disable-gpu"]}
    if shutil.which("google-chrome"):
        kwargs["channel"] = "chrome"
    browser = p.chromium.launch(**kwargs)
    page = browser.new_page(viewport={"width": 1080, "height": 1920}, device_scale_factor=1)
    page.on("pageerror", lambda e: print(f"[page error] {e}", file=sys.stderr, flush=True))
    page.goto(STAGE_URL)
    font_ok = page.evaluate("([tl, id]) => Stage.init(tl, id)", [timeline, beat_id])
    if not font_ok:
        print("[warn] Inter font did not load; text will use a fallback font", file=sys.stderr, flush=True)
    return browser, page


def render_beat(timeline_path: str, beat_id: str) -> str:
    with open(timeline_path, encoding="utf-8") as f:
        tl = json.load(f)
    beat = next(b for b in tl["beats"] if b["id"] == beat_id)
    build = os.path.dirname(os.path.abspath(timeline_path))
    os.makedirs(os.path.join(build, "clips"), exist_ok=True)
    final = os.path.join(build, "clips", f"{beat_id}.mp4")
    out = os.path.join(build, "clips", f"{beat_id}.part.mp4")  # renamed to `final` only on success
    fps, n = tl["fps"], beat["end_frame"] - beat["start_frame"]
    face = beat["type"] in ("face", "split")
    pipe_in = ["-f", "image2pipe", "-framerate", str(fps), "-c:v", "png", "-i", "-"]

    if face:
        raw = os.path.join(build, "face", f"{beat_id}.raw.mp4")
        if not os.path.exists(raw):
            raise SystemExit(f"face clip missing for beat '{beat_id}': run render_face.py first ({raw})")
        # Avatar clip (portrait, e.g. 1088x1884): scale to full height, trim the sides to 1080, sharpen lightly. The last
        # frame is held so the clip always covers the beat even if the avatar clip is a frame short.
        if beat["type"] == "split":
            # 1080x1020 at y 900: the top of the portrait (head and shoulders) at 1100 px high, centred;
            # the sides are its left edge stretched and blurred, so they continue the photo's backdrop
            fit = ("scale=-2:1100:flags=lanczos,crop=iw:1020:0:ih*0.02,split[a][b];"
                   "[a]crop=12:ih:0:0,scale=1080:1020,boxblur=20[fill];"
                   "[fill][b]overlay=(W-w)/2:0,pad=1080:1920:0:900:color=black")
        else:
            fit = "scale=-2:1920:flags=lanczos,crop=1080:1920"
        chain = (f"[0:v]fps={fps},{fit},unsharp=5:5:0.6:5:5:0.0,"
                 f"tpad=stop_mode=clone:stop_duration=2[bg];[bg][1:v]overlay=0:0:format=auto:shortest=1[v]")
        cmd = [FFMPEG, "-hide_banner", "-loglevel", "error", "-y", "-i", raw, *pipe_in,
               "-filter_complex", chain, "-map", "[v]", "-frames:v", str(n), *ENCODE, "-r", str(fps), out]
    else:
        cmd = [FFMPEG, "-hide_banner", "-loglevel", "error", "-y", *pipe_in,
               "-frames:v", str(n), *ENCODE, "-r", str(fps), out]

    t0 = time.time()
    with sync_playwright() as p:
        browser, page = open_stage(p, tl, beat_id)
        proc = subprocess.Popen(cmd, stdin=subprocess.PIPE)
        ok = False
        try:
            for frame in range(beat["start_frame"], beat["end_frame"]):
                proc.stdin.write(shoot(page, frame / fps, face))
            ok = True
        finally:
            proc.stdin.close()
            code = proc.wait()
            browser.close()
            if not ok or code != 0:
                if os.path.exists(out):
                    os.remove(out)  # never leave a half-written clip where the assembler could find it
    if code != 0:
        raise SystemExit(f"ffmpeg failed for beat '{beat_id}' (exit {code})")
    os.replace(out, final)
    return f"{beat_id}: {n} frames in {time.time() - t0:.0f} s -> {final}"


def render_still(timeline_path: str, t: float, out: str) -> None:
    with open(timeline_path, encoding="utf-8") as f:
        tl = json.load(f)
    frame = int(t * tl["fps"])
    beat = next(b for b in tl["beats"] if b["start_frame"] <= frame < b["end_frame"])
    with sync_playwright() as p:
        browser, page = open_stage(p, tl, beat["id"])
        with open(out, "wb") as f:
            f.write(shoot(page, frame / tl["fps"], beat["type"] in ("face", "split")))
        browser.close()
    print(f"{beat['id']} @ {t:.2f}s -> {out}")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--timeline", required=True)
    ap.add_argument("--beats", nargs="*", help="beat ids to render (default: all)")
    ap.add_argument("--only", choices=["visual", "face", "split"], help="render only beats of this type")
    ap.add_argument("--jobs", type=int, default=4)
    ap.add_argument("--still", type=float, help="render a single frame at this time (seconds)")
    ap.add_argument("--out", help="output PNG for --still")
    args = ap.parse_args()

    if args.still is not None:
        render_still(args.timeline, args.still, args.out or "still.png")
        return

    with open(args.timeline, encoding="utf-8") as f:
        tl = json.load(f)
    ids = [b["id"] for b in tl["beats"]
           if (not args.beats or b["id"] in args.beats) and (not args.only or b["type"] == args.only)]
    with ProcessPoolExecutor(max_workers=min(args.jobs, max(1, len(ids)))) as pool:
        for line in pool.map(render_beat, [args.timeline] * len(ids), ids):
            print(line, flush=True)


if __name__ == "__main__":
    main()
