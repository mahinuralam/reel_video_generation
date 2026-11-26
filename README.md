# avatar_pipeline

Turns a script, a photo and a voice clip into a 1080×1920 video of that person presenting it, with
animated graphics, captions and background music. All AI models run in the cloud; no GPU needed.

| Step | Model | Script |
|---|---|---|
| 0 Design | Claude Opus 5.5 (Anthropic API) | `src/reel/write_storyboard.py` |
| 1 Speech | Fish Audio S2.1 Pro (OpenRouter) | `src/voice/clone_voice.py` |
| 2 Timing | Whisper (OpenRouter) | `src/reel/timing.py` |
| 3 Avatar clips | HeyGen Avatar 6 Turbo (OpenRouter) | `src/reel/render_face.py` |
| 4 Graphics | headless Chromium | `src/reel/render_visuals.py` |
| 5 Music + assembly | Lyria 3 (OpenRouter), ffmpeg | `src/reel/make_music.py`, `src/reel/assemble.py` |

A 30 s reel takes about 3 minutes and costs about $1, mostly HeyGen ($0.05 per second the avatar is on screen).

## Setup

Needs Linux and conda.

```bash
cp .env.example .env && chmod 600 .env    # fill in ANTHROPIC_API_KEY and OPENROUTER_API_KEY
bash src/setup/setup.sh                   # builds env/reel
```

## Usage

Web app: see [webapp/README.md](webapp/README.md).

Command line:

```bash
REF_AUDIO=inputs/voice/voice.wav REF_TEXT=inputs/voice/voice.txt \
  bash src/make_video.sh <name> inputs/scripts/<name>.txt inputs/photo/template.json
# → outputs/reels/<name>/<name>.mp4
```

- **Script**: plain text, one paragraph per line.
- **Voice**: `REF_AUDIO` is 10–20 s of clear speech (wav); `REF_TEXT` is its exact words. If the text
  file is missing, Whisper writes it.
- **Photo template**: `{"cond_image": "inputs/photo/portrait.png", "prompt": "<describe the person and setting>"}`.
  A 9:16 portrait works best.

Re-running reuses what already exists (design, speech, avatar clips, music), so a retry only redoes
what is missing. Set `FORCE_FACE=1` to remake the avatar clips.

Claude's design is saved as `reels/<name>/storyboard.json`; see `src/reel/example_storyboard.json`
for the format.

## Layout

```
src/make_video.sh     script → finished video (the web app runs this)
src/make_reel.sh      storyboard → finished video (steps 1-5)
src/reel/             design, timing, rendering, music, assembly; stage/ is the graphics page
src/voice/            voice cloning and transcription
src/setup/            common.sh (paths + keys), setup.sh
webapp/               Avatar Studio web app
```

Not in git: `.env`, `env/`, `inputs/`, `reels/`, `outputs/`, `logs/`.

## Licences

Inter font: SIL Open Font License (`assets/fonts/Inter-OFL.txt`). Generated content is subject to each
model provider's terms. Only use photos and voices of people who have agreed to it.
