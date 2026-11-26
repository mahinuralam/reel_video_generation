#!/usr/bin/env bash
# Shared settings for the web app scripts. Source it; do not run it.
WEBAPP="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT="$(cd "$WEBAPP/.." && pwd)"
export PROJECT_ROOT="$ROOT"
# Node 24 and MongoDB 8.0 live in the project's env/ folder (installed without sudo).
export PATH="$ROOT/env/node/bin:$ROOT/env/mongodb/bin:$PATH"
# .env.local holds MOCK, MONGODB_URI and friends; Next.js reads it too.
if [[ -f "$WEBAPP/.env.local" ]]; then set -a; source "$WEBAPP/.env.local"; set +a; fi
RUN="$WEBAPP/data/run"
LOGS="$ROOT/logs/webapp"
mkdir -p "$RUN" "$LOGS" "$WEBAPP/data/mongo"

alive() { [[ -f "$RUN/$1.pid" ]] && kill -0 "$(cat "$RUN/$1.pid")" 2>/dev/null; }
