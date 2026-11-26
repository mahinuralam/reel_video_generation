#!/usr/bin/env bash
# One-time setup of the pipeline environment at env/reel: Python 3.12, ffmpeg (conda-forge), the
# packages in requirements.txt, and a Chromium for drawing the graphics when Google Chrome is not
# installed. Needs conda (CONDA=/path/to/conda if it is not on PATH). Safe to run again.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

CONDA="${CONDA:-$(command -v conda || echo "$HOME/miniconda3/bin/conda")}"
if [[ ! -x "$PY" ]]; then
  "$CONDA" create -y -p "$ENV_DIR" --override-channels -c conda-forge python=3.12
fi
"$CONDA" install -y -p "$ENV_DIR" --override-channels -c conda-forge ffmpeg
"$ENV_DIR/bin/pip" install --upgrade pip
"$ENV_DIR/bin/pip" install -r "$ROOT/requirements.txt"

if ! command -v google-chrome >/dev/null 2>&1; then
  "$ENV_DIR/bin/playwright" install chromium
fi

"$PY" -c "import anthropic, numpy, playwright, soundfile; print('python packages ok')"
"$FFMPEG" -hide_banner -version | head -1
echo "[OK] environment ready: $ENV_DIR"
