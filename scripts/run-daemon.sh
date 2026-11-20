#!/bin/sh
# Start the drop-bot daemon on a VPS with a virtual screen for Chrome.
# Used by pm2 / systemd (see scripts/vps-upgrade.sh). Chrome runs in normal,
# non-headless mode on the virtual screen — it passes bot checks better, and
# the dashboard's Live view shows that screen.
cd "$(dirname "$0")/.." || exit 1

if [ -z "$DISPLAY" ]; then
  export DISPLAY=:99
  if ! pgrep -f "Xvfb :99" >/dev/null 2>&1; then
    if ! command -v Xvfb >/dev/null 2>&1; then
      echo "[run-daemon] Xvfb is not installed — run scripts/vps-upgrade.sh (or: apt-get install -y xvfb)" >&2
      exit 1
    fi
    rm -f /tmp/.X99-lock
    nohup Xvfb :99 -screen 0 1440x900x24 -nolisten tcp >/tmp/xvfb-dropbot.log 2>&1 &
    i=0
    while [ ! -e /tmp/.X11-unix/X99 ] && [ $i -lt 50 ]; do sleep 0.1; i=$((i+1)); done
  fi
fi

exec node src/daemon.js
