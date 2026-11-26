"""Browser check of the web app (MOCK=1): clicks through every page like a person would,
fails on console errors or horizontal scrolling on a phone, and saves screenshots. It makes its own
test image and voice with ffmpeg.

Usage (from the project root):
    env/reel/bin/python webapp/tests/ui_check.py [--base http://127.0.0.1:3100] [--out webapp/data/screens]
Uses the Playwright + Chrome installed in env/reel.
"""
import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request

from playwright.sync_api import sync_playwright

ap = argparse.ArgumentParser()
ap.add_argument("--base", default="http://127.0.0.1:3100")
ap.add_argument("--out", default="webapp/data/screens")
args = ap.parse_args()
os.makedirs(args.out, exist_ok=True)
BASE = args.base
STAMP = hex(int(time.time()))[2:]
FFMPEG = os.environ.get("FFMPEG", "env/reel/bin/ffmpeg")
TMP = tempfile.mkdtemp(prefix="ui-check-")
results = []


def fixture(name, *args):
    path = os.path.join(TMP, name)
    subprocess.run([FFMPEG, "-hide_banner", "-loglevel", "error", "-y", *args, path], check=True)
    return path


PHOTO = fixture(f"ui_photo_{STAMP}.png", "-f", "lavfi", "-i", "testsrc2=size=540x960", "-frames:v", "1")
VOICE = fixture(f"ui_voice_{STAMP}.wav", "-f", "lavfi", "-i", "sine=frequency=180:duration=12", "-ac", "1", "-ar", "24000")


def check(cond, label, extra=""):
    results.append((bool(cond), label))
    print(f"  {'ok  ' if cond else 'FAIL'} {label} {'' if cond else extra}", flush=True)


status = json.load(urllib.request.urlopen(f"{BASE}/api/status"))
if not status["worker"]["mock"]:
    sys.exit("Not in mock mode; refusing to call the paid APIs from a test.")

kwargs = {"headless": True, "args": ["--disable-gpu"]}
if shutil.which("google-chrome"):
    kwargs["channel"] = "chrome"

with sync_playwright() as p:
    browser = p.chromium.launch(**kwargs)
    errors = []

    def new_page(w, h):
        page = browser.new_page(viewport={"width": w, "height": h})
        page.on("console", lambda m: errors.append(f"{page.url}: {m.text}") if m.type == "error" else None)
        page.on("pageerror", lambda e: errors.append(f"{page.url}: {e}"))
        return page

    # ---- every page at desktop and phone width ----
    print("\n1. pages at 1440 and 390 px")
    pages = {"create": "/", "videos": "/library"}
    for w, h in [(1440, 1000), (390, 844)]:
        page = new_page(w, h)
        for name, path in pages.items():
            page.goto(BASE + path)
            page.wait_for_load_state("networkidle")
            page.wait_for_timeout(600)
            overflow = page.evaluate("document.documentElement.scrollWidth - window.innerWidth")
            check(overflow <= 1, f"{name} @{w}: no horizontal scroll", f"(overflow {overflow}px)")
            page.screenshot(path=f"{args.out}/{name}_{w}.png", full_page=True)
        page.close()

    page = new_page(1440, 1000)

    # ---- create: upload, generate, progress, result ----
    print("\n2. create flow")
    page.goto(BASE + "/")
    page.wait_for_load_state("networkidle")
    gen = page.get_by_role("button", name="Generate video")
    check(gen.is_disabled(), "generate is disabled without a script")
    page.get_by_role("textbox", name="Title").fill(f"UI Check {STAMP}: My first reel!")
    page.get_by_role("textbox", name="Script", exact=True).fill(f"UI check {STAMP}. Welcome to this week's update.\nI'll walk you through what we tried and what we plan to do next.")
    check("words" in page.locator(".meta").inner_text(), "estimate shows under the script")
    page.locator("input[type=file][accept^=image]").set_input_files(PHOTO)
    page.get_by_text("saved and selected").wait_for(timeout=15000)
    check(page.locator(".tile[aria-pressed=true]", has_text=f"ui_photo_{STAMP}").count() == 1, "an uploaded image is saved and selected")
    page.get_by_text("Upload a voice").click()
    page.get_by_label("Audio, 10 to 20 s").set_input_files(VOICE)
    page.get_by_role("button", name="Add voice").click()
    page.get_by_text(f"Voice “ui_voice_{STAMP}” saved and selected").wait_for(timeout=15000)
    check(page.locator(".voice[aria-current=true]", has_text=f"ui_voice_{STAMP}").count() == 1, "an uploaded voice is saved and selected")
    page.screenshot(path=f"{args.out}/create_filled_1440.png", full_page=True)
    gen.click()
    page.wait_for_url("**/jobs/**")
    check("/jobs/" in page.url, "generating opens the video page")
    page.wait_for_selector("h1.title")
    check(page.locator("h1.title").inner_text() == f"UI Check {STAMP}: My first reel!", "the video shows the typed title")
    page.wait_for_selector(".step.active", timeout=15000)
    page.wait_for_timeout(2500)
    page.screenshot(path=f"{args.out}/job_running_1440.png", full_page=True)
    page.wait_for_selector(".beat", timeout=15000)
    check(page.locator(".beat").count() == 6, f"Claude's design is shown ({page.locator('.beat').count()} beats)")
    check("voice clip: webapp/data/uploads/voices/" in page.locator("pre.log").inner_text(), "the job uses the uploaded voice")
    page.get_by_role("heading", name="Your video is ready").wait_for(timeout=60000)
    check(page.locator("video.player").count() == 1, "finished video plays on its page")
    check(page.get_by_role("link", name="Download MP4").count() == 1, "download button shown")
    page.screenshot(path=f"{args.out}/job_done_1440.png", full_page=True)

    # ---- failure shows the error and a retry button ----
    print("\n3. failure flow")
    page.goto(BASE + "/")
    page.get_by_role("textbox", name="Script", exact=True).fill("This script will FAIL_TEST on purpose so the error screen can be checked by the test.")
    page.get_by_role("button", name="Generate video").click()
    page.wait_for_url("**/jobs/**")
    page.get_by_role("button", name="Retry").wait_for(timeout=60000)
    check(page.get_by_text("HeyGen could not make the clip").count() >= 1, "error message is shown")
    page.screenshot(path=f"{args.out}/job_failed_1440.png", full_page=True)
    page.once("dialog", lambda d: d.accept())
    page.get_by_role("button", name="Remove").click()
    page.wait_for_url(BASE + "/library")
    check(page.url.endswith("/library"), "remove returns to the videos")

    # ---- videos page ----
    print("\n4. videos")
    page.wait_for_selector(".vcard")
    check(page.locator(".vcard", has_text=f"UI Check {STAMP}").count() == 1, "the new video is listed by its title")
    page.locator(".vcard", has_text=f"UI Check {STAMP}").click()
    page.wait_for_url("**/jobs/**")
    page.wait_for_selector("h1.title")
    check(page.locator("h1.title").inner_text() == f"UI Check {STAMP}: My first reel!", "a card opens its video")

    noise = [e for e in errors if "favicon" not in e]
    check(not noise, "no console or page errors", "\n    " + "\n    ".join(noise[:10]))
    browser.close()

shutil.rmtree(TMP, ignore_errors=True)
passed = sum(1 for ok, _ in results if ok)
print(f"\n{passed} passed, {len(results) - passed} failed; screenshots in {args.out}")
sys.exit(0 if passed == len(results) else 1)
