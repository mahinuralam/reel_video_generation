#!/usr/bin/env bash
# Show whether MongoDB, the web app and the worker are running, and what the app reports.
set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/env.sh"
for s in mongod web worker; do
  if alive "$s"; then printf '%-7s running (pid %s)\n' "$s" "$(cat "$RUN/$s.pid")"; else printf '%-7s stopped\n' "$s"; fi
done
echo "mode:   $([[ "${MOCK:-0}" == "1" ]] && echo 'MOCK (no API calls)' || echo 'real')"
if out=$(curl -s --max-time 5 http://127.0.0.1:3100/api/status); then echo "app:    $out"; else echo "app:    not answering on 127.0.0.1:3100"; fi
