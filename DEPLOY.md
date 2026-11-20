# Running Drop Bot on a server (nothing on your computer)

The bot is two pieces:

| Piece | What it is | Where it runs |
|---|---|---|
| **Dashboard** (`frontend/`) | The website you use on your phone | Vercel (you already have this) |
| **Bot** (everything else) | The always-on part with the store browsers | A server — this guide |

Once the bot is on a server you do **everything** from the dashboard: sign in to stores
(🔐 Accounts), save CVVs, add products, watch queues, and finish purchases in Live view.

---

## You already run the bot on a VPS → upgrade it in place

SSH into the VPS once, go to the drop-bot folder, and run:

```bash
git fetch origin claude/determined-franklin-rb267i
git checkout FETCH_HEAD -- scripts/vps-upgrade.sh
bash scripts/vps-upgrade.sh
```

It:

1. **Saves your current settings** (watchlist, label edits, webhooks) to `data/config.yaml` —
   from now on that's where the dashboard writes, and git never touches it.
2. Switches the code to the new version and installs dependencies.
3. Installs **Google Chrome + Xvfb** (virtual screen) if they're missing.
4. Adds a **`DAEMON_TOKEN`** to `.env` if there isn't one, and prints it.
5. Restarts the daemon the way it already runs — **pm2** (`drop-bot`) or **systemd** (`drop-bot.service`).

On first start the bot upgrades your old settings automatically (backup at `data/config.yaml.v1.bak`):
check interval 3s → 30s (every check is now a real logged-in page load), Walmart Wednesday hot window
added, discovery turned on, and your products set to **Queue + cart, I finish** — none of which does
anything until you turn on automation.

Then:

- **Vercel** → dashboard project → Environment Variables: add **`DAEMON_TOKEN`** (the value the script
  printed) and redeploy. `DAEMON_URL` stays as it is.
- **Dashboard → 🔐 Accounts**: paste your proxy (the one you use for Pokémon Center — the
  `host:port:user:pass` format is fine), tap **Test**, then **Sign in** to each store and save CVVs.

If the bot folder is under `/tmp` (which is wiped on reboot), the script keeps the bot's data in
`~/.drop-bot/data` instead. Store logins live in `~/.drop-bot/profiles`.

---

## Starting fresh on a new server

### Option A — Railway (all in the browser, no command line)

1. Go to **railway.com** → sign in with GitHub → **New Project → Deploy from GitHub repo** →
   pick `drop-bot` (and the branch you want). Railway finds the `Dockerfile` and builds it.
2. In the service: **Settings → Resources** — give it **at least 4 GB RAM** (six store
   browsers run at once). **Volumes → Add volume**, mount path **`/data`** — this keeps your
   store logins, watchlist and order history across redeploys.
3. **Variables** — add:

   | Variable | Value |
   |---|---|
   | `DAEMON_TOKEN` | a long random string (32+ characters) — **required** |
   | `DISCORD_DROP_ALERTS` | your Discord webhook URL (and any other `DISCORD_*` from `.env.example`) |
   | `DISCORD_MENTION_USER_ID` | your Discord user id, so "your turn" alerts ping you |
   | `DASHBOARD_URL` | your dashboard address, e.g. `https://drop-bot.vercel.app` |
   | `CHECKOUT_PROXY` | residential proxy, e.g. `http://user:pass@host:port` — **strongly recommended**, see below |

4. **Settings → Networking → Generate Domain.** Copy the address (e.g. `https://drop-bot-production.up.railway.app`).
5. In **Vercel → your dashboard project → Settings → Environment Variables** set:

   | Variable | Value |
   |---|---|
   | `DAEMON_URL` | the Railway address from step 4 |
   | `DAEMON_TOKEN` | the same value as on Railway |
   | `DASHBOARD_PASSWORD` | your dashboard password |

   Then redeploy the dashboard.
6. Open the dashboard → **🔐 Accounts** → **Sign in** to each store, save each card CVV.
   Then **🧪 Test** one product per store.

### Option B — Any VPS with Docker (Hetzner, DigitalOcean, …)

Needs one-time SSH access to the server; after that everything is from the dashboard.

```bash
git clone https://github.com/KnifeOfPi/drop-bot.git && cd drop-bot
cp .env.example .env    # set DOMAIN, DAEMON_TOKEN, DISCORD_*, CHECKOUT_PROXY
docker compose up -d --build
```

Point a DNS record (e.g. `bot.yourdomain.com`) at the server first; Caddy gets an HTTPS
certificate for `DOMAIN` automatically. Use `https://bot.yourdomain.com` as `DAEMON_URL` in Vercel.
Pick a server with 4 GB+ RAM.

---

## Proxy

Servers have **datacenter IP addresses**. Walmart and Sam's Club (PerimeterX), Costco (Akamai) and
Pokémon Center (DataDome / Imperva) block or captcha datacenter traffic far more than a home
connection — expect "Press & Hold" captchas or outright blocks without a proxy.

Set the proxy on the dashboard's **🔐 Accounts** page (or `CHECKOUT_PROXY` in `.env`). Pick which
stores use it there — all of them by default. Use a **residential** proxy with a **sticky session**
(the same IP for 30+ minutes) so store logins aren't challenged every time the IP changes, and sign
in to stores *after* setting it. **Test** shows the IP the stores see.

Residential proxies usually bill per GB. The bot skips images, fonts and video on the tabs that
only watch and search (Settings → Schedule → *Save proxy data*); checkout, sign-in and Live view
load normally.

When a captcha does appear during a drop, the bot hands the session to you in Live view to solve.

## How it's built

- `Dockerfile` — Node 22 + **Google Chrome** + **Xvfb** (a virtual screen). Chrome runs in normal,
  non-headless mode, which passes bot checks better; Live view shows you that screen.
- Everything persistent lives in **`/data`**: `config.yaml` (seeded from the repo on first start,
  then edited from the dashboard), `profiles/` (store logins), `orders.json`, `accounts.json`,
  `secrets.json` (CVVs, mode 600), discoveries and screenshots.
- The bot's API refuses to start on a public address without a `DAEMON_TOKEN` (16+ characters).
  The dashboard sends that token on every request; browsers never talk to the bot directly.

## Updating

Railway redeploys automatically when the branch changes. On a VPS: `git pull && docker compose up -d --build`.
Your logins and settings in `/data` are kept.
