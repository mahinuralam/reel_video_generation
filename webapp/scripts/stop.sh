#!/usr/bin/env bash
# Stop the job worker, the web app and MongoDB.
# Usage: scripts/stop.sh [worker] [web] [mongo]       (no arguments = all three)
# Stopping the worker also stops a job that is rendering; that job is marked failed and can be retried.
set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/env.sh"
[[ $# -eq 0 ]] && set -- worker web mongo

stop_group() {
  local name=$1
  if ! alive "$name"; then echo "$name not running"; rm -f "$RUN/$name.pid"; return; fi
  local pid; pid=$(cat "$RUN/$name.pid")
  kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid"
  for _ in $(seq 1 40); do kill -0 "$pid" 2>/dev/null || break; sleep 0.5; done
  if kill -0 "$pid" 2>/dev/null; then kill -KILL -- "-$pid" 2>/dev/null; echo "killed $name"; else echo "stopped $name"; fi
  rm -f "$RUN/$name.pid"
}

for s in "$@"; do
  case "$s" in
    worker|web) stop_group "$s" ;;
    mongo)
      if alive mongod; then mongod --dbpath "$WEBAPP/data/mongo" --shutdown > /dev/null && echo "stopped mongod"
      else echo "mongod not running"; fi ;;
    *) echo "unknown service: $s (use worker, web, mongo)"; exit 2 ;;
  esac
done
