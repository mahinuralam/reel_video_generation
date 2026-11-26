#!/usr/bin/env bash
# Script -> finished video: Claude designs the storyboard (step 0), then make_reel.sh renders it
# (steps 1-5). The web app runs this for every video.
#
# Usage: REF_AUDIO=<voice.wav> REF_TEXT=<voice.txt> make_video.sh <name> <script.txt> <template.json>
#   name          short run name, e.g. welcome_message (lower-case letters, digits, _)
#   script.txt    exact words to speak, one paragraph per line (kept word for word)
#   template.json the avatar photo and its description: {"cond_image": "<photo>", "prompt": "<text>"}
#   REF_AUDIO / REF_TEXT  the voice to clone and its exact words (see make_reel.sh)
#
# Step 0 (design): Claude writes reels/<name>/storyboard.json (src/reel/write_storyboard.py,
# ANTHROPIC_API_KEY). An existing storyboard is kept, so a re-run does not design again.
#
# Produces: outputs/reels/<name>/<name>.mp4 (1080x1920)
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/setup/common.sh"
cd "$ROOT"

NAME="${1:?usage: make_video.sh <name> <script.txt> <template.json>}"
SCRIPT="${2:?usage: make_video.sh <name> <script.txt> <template.json>}"
TEMPLATE="${3:?usage: make_video.sh <name> <script.txt> <template.json>}"
STORYBOARD="reels/$NAME/storyboard.json"

echo "== 0/5 design"
if [[ -f "$STORYBOARD" ]]; then
  echo "reusing $STORYBOARD"
  "$PY" src/reel/write_storyboard.py --check "$STORYBOARD"
else
  "$PY" src/reel/write_storyboard.py --name "$NAME" --script "$SCRIPT" --face-template "$TEMPLATE"
fi
bash src/make_reel.sh "$STORYBOARD"
