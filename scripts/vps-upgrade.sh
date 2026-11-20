#!/usr/bin/env bash
# One-time upgrade of the drop-bot daemon already running on your VPS to the
# six-store version (queues, hand-off + Live view, drawings, discovery,
# dashboard sign-in). Safe to run again.
#
# From the drop-bot folder on the VPS:
#   git fetch origin claude/determined-franklin-rb267i
#   git checkout FETCH_HEAD -- scripts/vps-upgrade.sh
#   bash scripts/vps-upgrade.sh
#
# What it does:
#   1. Saves your current settings (watchlist, webhooks) to data/config.yaml —
#      from now on that file holds your settings and git never touches it
#   2. Switches the code to the new version
#   3. Installs Google Chrome + Xvfb (virtual screen) if missing
#   4. Makes sure .env has a DAEMON_TOKEN (prints it for Vercel)
#   5. Restarts the daemon the way it runs today (pm2 or systemd)
set -euo pipefail

say() { printf '\n\033[1m▶ %s\033[0m\n' "$*"; }
warn() { printf '\033[33m⚠ %s\033[0m\n' "$*"; }

# Everything runs inside main() so bash has read the whole script before the
# git checkout below replaces this file.
main() {
BRANCH="${1:-claude/determined-franklin-rb267i}"
cd "$(dirname "$0")/.."
REPO="$(pwd)"
SUDO=""; [ "$(id -u)" -ne 0 ] && command -v sudo >/dev/null && SUDO="sudo"

# Data location — /tmp is wiped on reboot, which would lose the order ledger
# (purchase limits) and your settings.
DATA_DIR="$REPO/data"
if [ -f .env ] && grep -q '^DROPBOT_DATA_DIR=' .env; then
  DATA_DIR="$(grep '^DROPBOT_DATA_DIR=' .env | tail -1 | cut -d= -f2-)"
elif [[ "$REPO" == /tmp/* ]]; then
  DATA_DIR="$HOME/.drop-bot/data"
  warn "The bot lives in $REPO (/tmp is cleared on reboot) — keeping its data in $DATA_DIR instead"
  touch .env; echo "DROPBOT_DATA_DIR=$DATA_DIR" >> .env
fi
mkdir -p "$DATA_DIR"

say "1/5 Saving your current settings"
if [ -f "$DATA_DIR/config.yaml" ]; then
  echo "  $DATA_DIR/config.yaml already exists — keeping it"
elif [ -f config.yaml ]; then
  cp config.yaml "$DATA_DIR/config.yaml"
  cp config.yaml "$DATA_DIR/config.pre-upgrade.yaml"
  echo "  copied config.yaml → $DATA_DIR/config.yaml (it's upgraded automatically on first start, with a backup)"
fi

say "2/5 Updating the code ($BRANCH)"
git checkout -- config.yaml 2>/dev/null || true          # saved above; now just a template
if [ -n "$(git status --porcelain --untracked-files=no | grep -v ' scripts/vps-upgrade.sh$' || true)" ]; then
  git stash push -m "drop-bot pre-upgrade $(date +%F)" >/dev/null
  warn "Your other local code changes were stashed (git stash list)"
fi
git reset -q -- scripts/vps-upgrade.sh 2>/dev/null || true
git fetch -q origin "$BRANCH"
git checkout -q -f -B "$BRANCH" FETCH_HEAD   # -f: replace the copy of this script you fetched to run it
echo "  now on $(git log -1 --format='%h %s')"
npm ci --omit=dev --no-audit --no-fund >/dev/null
echo "  dependencies installed"

say "3/5 Chrome + virtual screen"
if command -v apt-get >/dev/null; then
  NEED=""
  command -v Xvfb >/dev/null || NEED="$NEED xvfb"
  dpkg -s fonts-liberation >/dev/null 2>&1 || NEED="$NEED fonts-liberation"
  dpkg -s fonts-noto-color-emoji >/dev/null 2>&1 || NEED="$NEED fonts-noto-color-emoji"
  if [ -n "$NEED" ]; then $SUDO apt-get update -qq && $SUDO apt-get install -y -qq $NEED >/dev/null; echo "  installed:$NEED"; fi
  if ! command -v google-chrome >/dev/null && ! command -v google-chrome-stable >/dev/null; then
    if [ "$(dpkg --print-architecture)" = "amd64" ]; then
      wget -q -O /tmp/chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
      $SUDO apt-get install -y -qq /tmp/chrome.deb >/dev/null && rm -f /tmp/chrome.deb
      echo "  installed Google Chrome"
    else
      PW="$(node -p "require('playwright-core/package.json').version")"
      $SUDO npx -y "playwright@$PW" install --with-deps chromium >/dev/null
      echo "  installed Chromium (Google Chrome isn't available for $(dpkg --print-architecture))"
    fi
  fi
else
  warn "Not a Debian/Ubuntu server — install Google Chrome and Xvfb yourself"
fi
echo "  Chrome: $(google-chrome --version 2>/dev/null || google-chrome-stable --version 2>/dev/null || echo 'bundled Chromium')"

say "4/5 Settings in .env"
touch .env
TOKEN="$(grep '^DAEMON_TOKEN=' .env | tail -1 | cut -d= -f2- || true)"
if [ "${#TOKEN}" -lt 16 ]; then
  TOKEN="$(node -e "console.log(require('crypto').randomBytes(24).toString('hex'))")"
  sed -i '/^DAEMON_TOKEN=/d' .env
  echo "DAEMON_TOKEN=$TOKEN" >> .env
  NEW_TOKEN=1
  echo "  generated a DAEMON_TOKEN"
else
  echo "  DAEMON_TOKEN already set"
fi
chmod 600 .env
PORT="$(grep '^DAEMON_PORT=' .env | tail -1 | cut -d= -f2- || true)"; PORT="${PORT:-4200}"
if [ -f "$HOME/.hermes/skills/web-automation/stealth-browser/scripts/lib.mjs" ] && ! grep -q '^CHECKOUT_PROXY=' .env; then
  echo "  (your Pokémon Center proxy lived in the Hermes stealth lib — paste it on the dashboard's Accounts page to use it for every store)"
fi

say "5/5 Restarting the daemon"
RESTARTED=""
if command -v pm2 >/dev/null && pm2 describe drop-bot >/dev/null 2>&1; then
  pm2 delete drop-bot >/dev/null
  pm2 start "$REPO/scripts/run-daemon.sh" --name drop-bot --cwd "$REPO" >/dev/null
  pm2 save >/dev/null
  RESTARTED="pm2 (logs: pm2 logs drop-bot)"
elif command -v systemctl >/dev/null && systemctl list-unit-files 2>/dev/null | grep -q '^drop-bot\.service'; then
  $SUDO mkdir -p /etc/systemd/system/drop-bot.service.d
  printf '[Service]\nWorkingDirectory=%s\nExecStart=\nExecStart=/bin/sh %s/scripts/run-daemon.sh\nKillMode=control-group\n' "$REPO" "$REPO" \
    | $SUDO tee /etc/systemd/system/drop-bot.service.d/upgrade.conf >/dev/null
  $SUDO systemctl daemon-reload
  $SUDO systemctl restart drop-bot
  RESTARTED="systemd (logs: journalctl -u drop-bot -f)"
elif command -v pm2 >/dev/null; then
  pm2 start "$REPO/scripts/run-daemon.sh" --name drop-bot --cwd "$REPO" >/dev/null
  pm2 save >/dev/null
  RESTARTED="pm2 — new process (logs: pm2 logs drop-bot)"
else
  warn "Couldn't find how the daemon is run. Start it with:  sh $REPO/scripts/run-daemon.sh"
fi

if [ -n "$RESTARTED" ]; then
  echo "  restarted via $RESTARTED"
  OK=""
  for _ in $(seq 1 20); do
    sleep 1
    if node -e "fetch('http://127.0.0.1:$PORT/status',{headers:{authorization:'Bearer $TOKEN'}}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"; then OK=1; break; fi
  done
  [ -n "$OK" ] && echo "  ✅ daemon is answering on port $PORT" || warn "daemon didn't answer yet — check the logs above"
fi

say "Done. Last step — on Vercel (dashboard project → Settings → Environment Variables):"
echo "  DAEMON_URL    = (unchanged — the address the dashboard already uses for this VPS)"
echo "  DAEMON_TOKEN  = $TOKEN"
[ -n "${NEW_TOKEN:-}" ] && echo "                  ↑ new — the dashboard can't reach the bot until you add it and redeploy"
echo
echo "Then in the dashboard: 🔐 Accounts → paste your proxy, Test, then Sign in to each store."
echo "Your old settings were upgraded automatically (see the daemon log for what changed)."
}

main "$@"
exit 0
