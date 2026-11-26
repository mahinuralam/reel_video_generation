#!/usr/bin/env bash
# Voice cloning needs the exact words of the voice clip it copies. If <clip.txt> is missing or empty,
# write it by transcribing <clip.wav> with Whisper (once; later runs reuse the file).
#
# Usage: ensure_ref_text.sh <clip.wav> <clip.txt> <log_dir>
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/../setup/common.sh"
cd "$ROOT"

AUDIO="$1"; TEXT="$2"; LOG_DIR="$3"
[[ -s "$TEXT" ]] && exit 0
mkdir -p "$LOG_DIR"
echo "transcribing the voice clip $AUDIO"
WORDS_JSON="${TEXT%.txt}.words.json"
"$PY" src/voice/transcribe.py --audio "$AUDIO" --out "$WORDS_JSON" 2>> "$LOG_DIR/transcribe.stderr.log" | tee "$LOG_DIR/transcribe.log"
"$PY" -c 'import json,sys; open(sys.argv[2],"w",encoding="utf-8").write(json.load(open(sys.argv[1],encoding="utf-8"))["text"].strip()+"\n")' "$WORDS_JSON" "$TEXT"
