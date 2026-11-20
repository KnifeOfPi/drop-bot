# Drop Bot daemon — runs the store browsers on a server so nothing runs on your computer.
#
# Real Google Chrome in a virtual display (Xvfb): visible-mode Chrome passes bot
# checks far better than headless, and Live view shows it to you from the dashboard.
# Everything that must survive redeploys lives in /data (mount a volume there):
#   /data/config.yaml   watchlist + settings (seeded from the repo on first start)
#   /data/profiles/     logged-in browser profiles
#   /data/*.json        orders ledger, accounts, saved CVVs, discoveries
ARG BASE_IMAGE=node:22-bookworm-slim
FROM ${BASE_IMAGE}

RUN apt-get update \
 && apt-get install -y --no-install-recommends wget ca-certificates gnupg xvfb xauth tini \
      fonts-liberation fonts-noto-color-emoji tzdata \
 && wget -q -O /tmp/chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb \
 && apt-get install -y --no-install-recommends /tmp/chrome.deb \
 && rm -f /tmp/chrome.deb \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY config.yaml ./config.yaml.default
COPY docker/start.sh ./docker/start.sh

ENV NODE_ENV=production \
    DAEMON_HOST=0.0.0.0 \
    DAEMON_PORT=4200 \
    DROPBOT_CONFIG=/data/config.yaml \
    DROPBOT_DATA_DIR=/data \
    CHECKOUT_PROFILE_DIR=/data/profiles \
    CHROME_NO_SANDBOX=1 \
    TZ=America/New_York

VOLUME /data
EXPOSE 4200
# tini as PID 1: forwards signals and reaps Chrome's child processes.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["sh", "/app/docker/start.sh"]
