#!/usr/bin/env python
"""Render the avatar only for the beats where the face is on screen.

For each "face" or "split" beat in the timeline: cut that stretch of the speech, send it with the
template's photo and prompt (plus the beat's "gesture" direction and the "constraints" from
src/reel/avatar_rules.json, which keep the person and their hands the same in every clip) to the
avatar model, wait, and keep the clip at outputs/reels/<name>/build/face/<beat>.raw.mp4. The clip
follows the photo's shape (a 9:16 portrait gives a 9:16 clip). Beats that already have a clip are skipped, so a re-run after
changing only the graphics costs nothing.

Avatar models (--engine, or AVATAR_ENGINE in the environment; default heygen): each one's provider,
model, price, resolution and key are in src/reel/avatar_engines.json, which the web app reads too.
    heygen, infinitetalk, longcat  cloud models on OpenRouter and WaveSpeed (LongCat: at most 64 s per beat)
    omnihuman                      OmniHuman 2.0 on fal.ai; beats under 4 s get their audio padded with silence
    longcat-local                  LongCat Avatar 1.6 on this machine's GPU (src/reel/longcat_local.py), free,
                                   about 15 min per beat. Paths: LONGCAT_ENV, LONGCAT_REPO, LONGCAT_WEIGHTS;
                                   LONGCAT_RESOLUTION overrides the resolution
Clips smaller than 1080x1920 are scaled up when the beats are drawn.

The keys come from the environment or the project's .env. Standard library and ffmpeg only:
    python src/reel/render_face.py --timeline outputs/reels/<name>/build/timeline.json [--engine heygen] [--log-dir DIR]
"""
import argparse
import json
import math
import mimetypes
import os
import shutil
import subprocess
import sys
import time

from api import data_uri, need_key, request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
FFMPEG = os.environ.get("FFMPEG", "ffmpeg")
RULES = os.path.join(HERE, "avatar_rules.json")
ENGINES = os.path.join(HERE, "avatar_engines.json")
DEFAULT_ENGINE = "heygen"
POLL_S = 10
TIMEOUT_S = 30 * 60


def ffmpeg(*args) -> None:
    subprocess.run([FFMPEG, "-hide_banner", "-loglevel", "error", "-y", *args], check=True)


class Engine:
    """One avatar model from avatar_engines.json. submit() starts a clip and returns a job with an "id";
    poll() returns (video bytes, cost in USD) when it is done, None while it runs, and raises
    RuntimeError when it failed."""
    max_active = 1
    timeout_s = TIMEOUT_S

    def __init__(self, spec: dict):
        self.label, self.model = spec["short"], spec["model"]
        self.usd_per_s, self.resolution = spec["usd_per_sec"], spec["resolution"]


class OpenRouter(Engine):
    """HeyGen on OpenRouter's video API: inputs are data URIs, the cost is reported."""
    API = "https://openrouter.ai/api/v1"
    max_active = 99

    def __init__(self, spec: dict, photo: str):
        super().__init__(spec)
        self.auth = {"Authorization": f"Bearer {need_key(spec['key'])}"}
        self.photo = data_uri(photo, mimetypes.guess_type(photo)[0] or "image/png")

    def call(self, url, body=None, raw=False):
        out = request(url, body, self.auth, name=f"OpenRouter ({self.model})")
        return out if raw else json.loads(out)

    def submit(self, audio: str, prompt: str, sec: float, audio_sec: float) -> dict:
        sound = data_uri(audio, "audio/mpeg")
        return self.call(f"{self.API}/videos", {
            "model": self.model, "prompt": prompt, "resolution": self.resolution,
            "input_references": [{"type": "image_url", "image_url": {"url": self.photo}},
                                 {"type": "audio_url", "audio_url": {"url": sound}}],
        })

    def poll(self, job: dict):
        status = self.call(job["polling_url"])
        state = status.get("status")
        if state == "completed":
            return self.call(f"{self.API}/videos/{job['id']}/content?index=0", raw=True), (status.get("usage") or {}).get("cost") or 0
        if state in ("failed", "cancelled", "expired"):
            raise RuntimeError(f"{state}: {status.get('error', '')}")
        return None


class WaveSpeed(Engine):
    """InfiniteTalk and LongCat on WaveSpeed: inputs are uploaded files, billed per started second of audio (3 s minimum)."""
    API = "https://api.wavespeed.ai/api/v3"
    max_active = int(os.environ.get("WAVESPEED_CONCURRENCY", "2"))  # the default account runs 2 jobs at a time

    def __init__(self, spec: dict, photo: str):
        super().__init__(spec)
        self.auth = {"Authorization": f"Bearer {need_key(spec['key'])}"}
        self.photo = self.upload(photo)

    def call(self, path: str, body=None) -> dict:
        reply = json.loads(request(f"{self.API}/{path}", body, self.auth, name=f"WaveSpeed ({self.model})"))
        return reply.get("data", reply)

    def upload(self, path: str) -> str:
        mime = mimetypes.guess_type(path)[0] or "application/octet-stream"
        slot = self.call("media/uploads", {"filename": os.path.basename(path), "size": os.path.getsize(path), "content_type": mime})
        with open(path, "rb") as f:
            request(slot["upload"]["url"], f.read(), slot["upload"].get("headers") or {}, method=slot["upload"].get("method", "PUT"),
                    name="WaveSpeed upload")
        return slot["download_url"]

    def submit(self, audio: str, prompt: str, sec: float, audio_sec: float) -> dict:
        job = self.call(self.model, {"image": self.photo, "audio": self.upload(audio), "prompt": prompt,
                                     "resolution": self.resolution, "seed": -1})
        return {**job, "cost": self.usd_per_s * max(3, math.ceil(audio_sec))}

    def poll(self, job: dict):
        result = self.call(f"predictions/{job['id']}/result")
        state = result.get("status")
        if state == "completed":
            return request(result["outputs"][0], name="WaveSpeed download"), job["cost"]
        if state in ("failed", "cancelled", "timeout", "deleted"):
            raise RuntimeError(f"{state}: {result.get('error', '')}")
        return None


class Fal(Engine):
    """OmniHuman on fal.ai's queue API: inputs are uploaded to fal's storage, the audio must be 4-300 s
    long, and the result reports the seconds it is billed for."""
    API = "https://queue.fal.run"
    UPLOAD = "https://rest.fal.ai/storage/upload/initiate?storage_type=gcs"
    MIN_AUDIO_S = 4
    max_active = 2

    def __init__(self, spec: dict, photo: str):
        super().__init__(spec)
        self.auth = {"Authorization": f"Key {need_key(spec['key'])}"}
        self.photo = self.upload(photo)

    def call(self, url: str, body=None) -> dict:
        return json.loads(request(url, body, self.auth, name=f"fal ({self.model})"))

    def upload(self, path: str) -> str:
        mime = mimetypes.guess_type(path)[0] or "application/octet-stream"
        slot = self.call(self.UPLOAD, {"file_name": os.path.basename(path), "content_type": mime})
        with open(path, "rb") as f:
            request(slot["upload_url"], f.read(), {"Content-Type": mime}, method="PUT", name="fal upload")
        return slot["file_url"]

    def submit(self, audio: str, prompt: str, sec: float, audio_sec: float) -> dict:
        if audio_sec < self.MIN_AUDIO_S:  # pad short beats with silence; the clip is cut to the beat when drawn
            padded = audio.removesuffix(".mp3") + ".padded.mp3"
            ffmpeg("-i", audio, "-af", "apad", "-t", str(self.MIN_AUDIO_S), "-ac", "1", "-b:a", "128k", padded)
            audio = padded
        job = self.call(f"{self.API}/{self.model}", {"image_url": self.photo, "audio_url": self.upload(audio), "prompt": prompt})
        return {**job, "id": job["request_id"]}

    def poll(self, job: dict):
        status = self.call(job["status_url"])
        if status.get("status") != "COMPLETED":
            return None
        if status.get("error"):  # a failed request is also COMPLETED, with an error
            raise RuntimeError(f"{status.get('error_type', 'failed')}: {status['error']}")
        result = self.call(job["response_url"])
        return request(result["video"]["url"], name="fal download"), self.usd_per_s * result["duration"]


class LongCatLocal(Engine):
    """LongCat Avatar 1.6 on this machine's GPU, through src/reel/longcat_local.py in LongCat's own
    environment. One beat at a time; the video is made in segments of 93 frames, then 80 more each."""
    LAUNCHER = os.path.join(HERE, "longcat_local.py")
    FIRST, EXTRA, FPS = 93, 80, 25
    timeout_s = None  # about 15 min per beat at 720p; cancelling the job stops it

    def __init__(self, spec: dict, photo: str, log_dir: str):
        super().__init__(spec)
        self.photo, self.log_dir = photo, log_dir
        env = self.path("LONGCAT_ENV", "env/longcat")
        self.repo = self.path("LONGCAT_REPO", "third_party/LongCat-Video")
        self.weights = self.path("LONGCAT_WEIGHTS", "weights/LongCat-Video-Avatar-1.6")
        self.torchrun = os.path.join(env, "bin", "torchrun")
        self.resolution = os.environ.get("LONGCAT_RESOLUTION") or self.resolution
        for need in (self.torchrun, os.path.join(self.repo, "run_demo_avatar_single_audio_to_video.py"), self.weights):
            if not os.path.exists(need):
                sys.exit(f"Error: {need} not found; the local LongCat needs its repo, environment and weights (see the README)")

    @staticmethod
    def path(var: str, default: str) -> str:
        return os.path.join(ROOT, os.environ.get(var) or default)

    def submit(self, audio: str, prompt: str, sec: float, audio_sec: float) -> dict:
        beat = os.path.basename(audio).removesuffix(".mp3")
        work = os.path.join(os.path.dirname(audio), f"longcat_{beat}")
        shutil.rmtree(work, ignore_errors=True)
        os.makedirs(work)
        segments = max(1, math.ceil((sec * self.FPS - self.FIRST) / self.EXTRA) + 1)
        # the audio covers every generated frame, plus a second
        padded = (self.FIRST + (segments - 1) * self.EXTRA) / self.FPS + 1.0
        wav = os.path.join(work, "audio.wav")
        ffmpeg("-i", audio, "-ac", "1", "-af", "apad", "-t", f"{padded:.3f}", wav)
        config = os.path.join(work, "input.json")
        with open(config, "w", encoding="utf-8") as f:
            json.dump({"prompt": prompt, "cond_image": self.photo, "cond_audio": {"person1": wav}}, f, indent=2, ensure_ascii=False)
        out = os.path.join(work, "out")
        log = os.path.join(self.log_dir, f"longcat_{beat}.log")
        with open(log, "w", encoding="utf-8") as f:
            proc = subprocess.Popen(
                [self.torchrun, "--nproc_per_node=1", self.LAUNCHER, "--context_parallel_size=1",
                 f"--checkpoint_dir={self.weights}", f"--input_json={config}", f"--output_dir={out}",
                 "--model_type", self.model, "--use_distill", "--use_int8",
                 "--lora_path", "loraB/lora.safetensors", "--mix_steps=4", "--mix_alpha=1.0",
                 "--resolution", self.resolution, "--num_segments", str(segments)],
                cwd=self.repo, env={**os.environ, "PYTORCH_CUDA_ALLOC_CONF": "expandable_segments:True"},
                stdout=f, stderr=subprocess.STDOUT)
        return {"id": f"pid {proc.pid}", "proc": proc, "work": work, "out": out, "log": log, "segments": segments, "sec": sec}

    def poll(self, job: dict):
        code = job["proc"].poll()
        if code is None:
            return None
        if code:
            raise RuntimeError(f"exit code {code}, see {job['log']}")
        name = f"video_continue_{job['segments']}.mp4" if job["segments"] > 1 else "ai2v_demo_1.mp4"
        video = os.path.join(job["out"], name)
        if not os.path.exists(video):
            raise RuntimeError(f"{video} was not written, see {job['log']}")
        clip = os.path.join(job["work"], "clip.mp4")
        ffmpeg("-i", video, "-t", f"{job['sec']:.3f}", "-an", "-c:v", "libx264", "-crf", "16", "-pix_fmt", "yuv420p", clip)
        with open(clip, "rb") as f:
            return f.read(), 0.0


def make_engine(name: str, photo: str, log_dir: str) -> Engine:
    with open(ENGINES, encoding="utf-8") as f:
        engines = json.load(f)
    if name not in engines:
        sys.exit(f"Error: unknown avatar engine '{name}' ({', '.join(engines)})")
    spec = engines[name]
    if spec["provider"] == "local":
        return LongCatLocal(spec, photo, log_dir)
    return {"openrouter": OpenRouter, "wavespeed": WaveSpeed, "fal": Fal}[spec["provider"]](spec, photo)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--timeline", required=True)
    ap.add_argument("--engine", default=os.environ.get("AVATAR_ENGINE") or DEFAULT_ENGINE)
    ap.add_argument("--log-dir", help="where a local engine writes its full output (default: next to the clips)")
    ap.add_argument("--force", action="store_true", help="render again even if a clip exists")
    args = ap.parse_args()

    with open(args.timeline, encoding="utf-8") as f:
        tl = json.load(f)
    build = os.path.dirname(os.path.abspath(args.timeline))
    face_dir = os.path.join(build, "face")
    os.makedirs(face_dir, exist_ok=True)
    with open(os.path.join(ROOT, tl["face_template"]), encoding="utf-8") as f:
        template = json.load(f)

    with open(RULES, encoding="utf-8") as f:
        constraints = " ".join(json.load(f)["constraints"])
    todo = []  # (beat id, audio clip, beat seconds, audio seconds, prompt, raw path)
    for beat in tl["beats"]:
        if beat["type"] not in ("face", "split"):
            continue
        raw = os.path.join(face_dir, f"{beat['id']}.raw.mp4")
        if os.path.exists(raw) and not args.force:
            print(f"[skip] {beat['id']}: {raw} exists")
            continue
        speech_part = max(0.0, min(beat["end"] - beat["start"], tl["speech_duration"] - beat["start"]))
        audio = os.path.join(face_dir, f"{beat['id']}.mp3")
        ffmpeg("-ss", f"{beat['start']:.3f}", "-t", f"{speech_part:.3f}", "-i", os.path.join(ROOT, tl["speech"]),
               "-ac", "1", "-b:a", "128k", audio)
        prompt = " ".join(p for p in (template["prompt"], beat.get("gesture"), constraints) if p)
        todo.append((beat["id"], audio, beat["end"] - beat["start"], speech_part, prompt, raw))
    if not todo:
        return

    log_dir = os.path.abspath(args.log_dir) if args.log_dir else face_dir
    engine = make_engine(args.engine, os.path.join(ROOT, template["cond_image"]), log_dir)
    running = {}  # beat id -> (job, raw path, submitted at)
    while todo or running:
        while todo and len(running) < engine.max_active:
            beat_id, audio, sec, audio_sec, prompt, raw = todo.pop(0)
            job = engine.submit(audio, prompt, sec, audio_sec)
            running[beat_id] = (job, raw, time.time())
            print(f"[face] {beat_id}: {sec:.2f} s sent to {engine.label} ({job['id']})", flush=True)
        time.sleep(POLL_S)
        for beat_id, (job, raw, t0) in list(running.items()):
            try:
                done = engine.poll(job)
            except RuntimeError as e:
                sys.exit(f"Error: {engine.label} could not make the clip for beat '{beat_id}' ({e})")
            if done:
                video, cost = done
                with open(raw, "wb") as f:
                    f.write(video)
                print(f"[ok] {raw} in {time.time() - t0:.0f} s, cost ${cost:.3f}", flush=True)
                del running[beat_id]
            elif engine.timeout_s and time.time() - t0 > engine.timeout_s:
                sys.exit(f"Error: {engine.label} took over {engine.timeout_s // 60} min for beat '{beat_id}' ({job['id']})")


if __name__ == "__main__":
    main()
