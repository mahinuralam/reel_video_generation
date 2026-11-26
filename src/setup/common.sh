#!/usr/bin/env bash
# Shared settings for every pipeline script. Source it; do not run it.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
export ROOT

# API keys for the cloud models (ANTHROPIC_API_KEY, OPENROUTER_API_KEY); see .env.example.
if [[ -f "$ROOT/.env" ]]; then set -a; source "$ROOT/.env"; set +a; fi

# The one Python environment (src/setup/setup.sh builds it); it also provides ffmpeg and ffprobe.
export ENV_DIR="$ROOT/env/reel"
export PY="$ENV_DIR/bin/python"
export FFMPEG="$ENV_DIR/bin/ffmpeg"
export FFPROBE="$ENV_DIR/bin/ffprobe"

# Caches (pip, Playwright's Chromium) inside the project instead of the home directory.
export XDG_CACHE_HOME="$ROOT/.cache"
export PIP_CACHE_DIR="$ROOT/.cache/pip"
