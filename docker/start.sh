#!/bin/sh
# Container entrypoint (run under tini): seed config on first start, start a
# virtual display, then run the bot so Chrome can run in normal (non-headless) mode.
set -e
mkdir -p /data/profiles
if [ ! -f /data/config.yaml ]; then
  cp /app/config.yaml.default /data/config.yaml
  echo "[start] seeded /data/config.yaml"
fi
# Chrome leaves lock files behind if the container was killed mid-run.
find /data/profiles -maxdepth 2 -name 'Singleton*' -delete 2>/dev/null || true

# Virtual screen for Chrome (Live view shows it).
export DISPLAY=:99
rm -f /tmp/.X99-lock /tmp/.X11-unix/X99
Xvfb :99 -screen 0 1440x900x24 -nolisten tcp >/tmp/xvfb.log 2>&1 &
i=0
while [ ! -e /tmp/.X11-unix/X99 ] && [ $i -lt 50 ]; do sleep 0.1; i=$((i+1)); done
[ -e /tmp/.X11-unix/X99 ] || { echo "[start] Xvfb failed to start"; cat /tmp/xvfb.log; exit 1; }

# Hosts like Railway / Render tell the app which port to use via $PORT.
export DAEMON_PORT="${PORT:-${DAEMON_PORT:-4200}}"
exec node /app/src/daemon.js
