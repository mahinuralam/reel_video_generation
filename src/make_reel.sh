#!/usr/bin/env bash
# Storyboard -> finished video (steps 1-5 of the pipeline).
#
# Usage: REF_AUDIO=<voice.wav> REF_TEXT=<voice.txt> make_reel.sh reels/<name>/storyboard.json
#   REF_AUDIO  10-20 s of clear speech in the voice to clone (wav)
#   REF_TEXT   its exact words; if the file is missing or empty, Whisper writes it first
#   FORCE_FACE=1 makes the avatar clips again even if they exist
#
# A storyboard is a list of beats. Each beat has the lines spoken during it and is either
#   "face"   - the avatar speaks on camera (optional overlay: lower_third, keywords),
#   "split"  - an animated graphic on top, the avatar in the bottom half, or
#   "visual" - an animated graphic (scene: checklist, grid, chat, callout) with its data.
# A "cue" in the data names a spoken word; that element appears when the word is said.
#
# Steps (each is skipped or cheap when its result already exists):
#   1. speech   the cloned voice for all lines (Fish Audio, checked with Whisper)
#   2. timing   beat boundaries, word times, captions, cue times (Whisper)
#   3. face     avatar clips for the face and split beats (HeyGen Avatar 6 Turbo, in parallel)
#   4. visuals  every beat drawn as a 1080x1920 clip with captions
#   5. assemble background music (Lyria 3, from the storyboard's "music" brief), then
#               clips + speech + sound effects + music -> outputs/reels/<name>/<name>.mp4
# The models run on OpenRouter (OPENROUTER_API_KEY in .env).
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/setup/common.sh"
cd "$ROOT"

STORYBOARD="${1:?usage: make_reel.sh reels/<name>/storyboard.json}"
: "${REF_AUDIO:?set REF_AUDIO to the voice clip to clone}"
: "${REF_TEXT:?set REF_TEXT to the file with the words of that clip}"
NAME=$("$PY" -c 'import json,sys; print(json.load(open(sys.argv[1]))["name"])' "$STORYBOARD")
BUILD="outputs/reels/$NAME/build"
LOG="logs/reel/$NAME"
mkdir -p "$BUILD" "$LOG"

echo "== 1/5 speech"
# script.txt only changes when the words do, so a re-run keeps the speech the avatar clips were
# made from instead of generating a new take
"$PY" - "$STORYBOARD" "$BUILD/script.txt" <<'EOF'
import json, os, sys
sb = json.load(open(sys.argv[1], encoding="utf-8"))
text = "".join(line.strip() + "\n" for beat in sb["beats"] for line in beat["lines"])
if not os.path.exists(sys.argv[2]) or open(sys.argv[2], encoding="utf-8").read() != text:
    with open(sys.argv[2], "w", encoding="utf-8") as f:
        f.write(text)
EOF
if [[ ! -f "$BUILD/speech.wav" || "$BUILD/script.txt" -nt "$BUILD/speech.wav" ]]; then
  bash src/voice/ensure_ref_text.sh "$REF_AUDIO" "$REF_TEXT" "$LOG"
  "$PY" src/voice/clone_voice.py --ref-audio "$REF_AUDIO" --ref-text "$REF_TEXT" \
      --script "$BUILD/script.txt" --out "$BUILD/speech.wav" 2> "$LOG/voice.stderr.log" | tee "$LOG/voice.log"
else
  echo "reusing $BUILD/speech.wav"
fi

echo "== 2/5 timing"
"$PY" src/reel/timing.py --storyboard "$STORYBOARD" --speech "$BUILD/speech.wav" \
    --out "$BUILD/timeline.json" 2> "$LOG/timing.stderr.log" | tee "$LOG/timing.log"

echo "== 3/5 face"
FACE_ARGS=()
[[ "${FORCE_FACE:-0}" == "1" ]] && FACE_ARGS=(--force)
"$PY" src/reel/render_face.py --timeline "$BUILD/timeline.json" "${FACE_ARGS[@]}" 2>&1 | tee "$LOG/face.log"

echo "== 4/5 visuals"
"$PY" src/reel/render_visuals.py --timeline "$BUILD/timeline.json" 2>&1 | tee "$LOG/visuals.log"

echo "== 5/5 assemble"
"$PY" src/reel/make_music.py --timeline "$BUILD/timeline.json" | tee "$LOG/music.log"
"$PY" src/reel/assemble.py --timeline "$BUILD/timeline.json" | tee "$LOG/assemble.log"
