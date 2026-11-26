#!/usr/bin/env bash
# Start MongoDB, the web app and the job worker, detached (they keep running after you log out).
# Usage: scripts/start.sh [mongo] [web] [worker]      (no arguments = all three, in that order)
# The web app listens on 127.0.0.1:3100 only; open it from your laptop through an SSH tunnel.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/env.sh"
[[ $# -eq 0 ]] && set -- mongo web worker

start_bg() {
  local name=$1; shift
  if alive "$name"; then echo "$name already running (pid $(cat "$RUN/$name.pid"))"; return; fi
  nohup setsid "$@" >> "$LOGS/$name.log" 2>&1 < /dev/null &
  echo $! > "$RUN/$name.pid"
  echo "started $name (pid $!), log: logs/webapp/$name.log"
}

for s in "$@"; do
  case "$s" in
    mongo)
      if alive mongod; then echo "mongod already running (pid $(cat "$RUN/mongod.pid"))"
      else
        mongod --dbpath "$WEBAPP/data/mongo" --bind_ip 127.0.0.1 --port 27017 \
          --logpath "$LOGS/mongod.log" --logappend --fork --pidfilepath "$RUN/mongod.pid" > /dev/null
        echo "started mongod (pid $(cat "$RUN/mongod.pid")), data: webapp/data/mongo"
      fi ;;
    web)
      [[ -f "$WEBAPP/.next/BUILD_ID" ]] || { echo "no production build yet: cd webapp && npm run build"; exit 1; }
      cd "$WEBAPP" && start_bg web npm run start ;;
    worker)
      cd "$WEBAPP" && start_bg worker npm run worker ;;
    *) echo "unknown service: $s (use mongo, web, worker)"; exit 2 ;;
  esac
done
echo "mode: $([[ "${MOCK:-0}" == "1" ]] && echo 'MOCK (no API calls)' || echo 'real')"
