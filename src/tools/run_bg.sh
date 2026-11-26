#!/usr/bin/env bash
# Run a command detached from the terminal, so it keeps going after you log out.
# Usage: run_bg.sh <log_dir> <name> <command> [args...]
# Writes <log_dir>/<name>.log and <name>.pid, and <name>.status (the exit code) when the command ends.
set -euo pipefail
LOG_DIR="$1"; NAME="$2"; shift 2
mkdir -p "$LOG_DIR"
rm -f "$LOG_DIR/$NAME.status"
nohup setsid bash -c '"$@"; echo $? > "$0"' "$LOG_DIR/$NAME.status" "$@" \
    > "$LOG_DIR/$NAME.log" 2>&1 < /dev/null &
echo $! > "$LOG_DIR/$NAME.pid"
echo "started $NAME (pid $(cat "$LOG_DIR/$NAME.pid")) -> $LOG_DIR/$NAME.log"
