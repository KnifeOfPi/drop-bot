# Drop Bot — Pokémon drops at Target, Best Buy, Walmart, Costco, Sam's Club & Pokémon Center

What it does:

| | |
|---|---|
| **Monitors** | Your watchlist at all six stores, each in its own logged-in Chrome window. Faster checks during "hot windows" (e.g. Walmart Wednesdays). |
| **Discovers** | Searches every store for new Pokémon listings and posts them to Discord / the dashboard with a one-tap **Watch**. |
| **Queues** | When a drop goes live it joins the queue / waiting room and tells you when it's in line and when it's through. |
| **Checks out — or hands off** | Adds to cart, gets to **Place order**, then either places the order or pings you to finish it from your phone in **Live view**. |
| **Drawings** | Enters "enter to win" drawings (Walmart, Best Buy, Target) on watched products and records each entry. |

Per product you choose what happens when it drops:

| Mode | What the bot does |
|---|---|
| 🔔 **Notify** | Discord alert only |
| 🙋 **Queue + cart, I finish** | Joins the queue, adds to cart, goes to checkout, then **hands off to you** (the minimum) |
| 🛒 **Queue + buy it for me** | Same, and clicks Place order itself (needs a max price; never while "Never click Place order" is on) |

If the bot gets stuck anywhere after joining a queue or adding to cart — captcha, logged out, a
step it doesn't recognise, total over your cap — it **hands off** instead of giving up: the tab
stays open, you get an @mention on Discord with a Live view link, and you finish from your phone.
When the bot sees the order confirmation page it marks the order done by itself.

## Setup (on the machine that runs the bot)

Needs Node 18+ and Google Chrome.

```bash
npm install
cp .env.example .env      # Discord webhooks, CVVs, DAEMON_TOKEN, DISCORD_MENTION_USER_ID, DASHBOARD_URL
```

Log in once per store — a Chrome window opens, you sign in, make sure a **default shipping
address and saved card** are on the account (Costco / Sam's need an active membership), then close it:

```bash
npm run login -- walmart
npm run login -- target
npm run login -- best-buy
npm run login -- costco
npm run login -- sams-club
npm run login -- pokemon-center
```

Start the bot:

```bash
npm start
```

Then in the dashboard:

1. **Settings → Products**: add products (store + TCIN / SKU / product URL, max $, mode) — or tap **Watch** on a new listing.
2. Dashboard → **🧪 Test** on one product per store → should show **DRY RUN OK** (empty your cart afterwards).
3. **Settings → Automation**: turn on **Enable automation**. Leave **Never click Place order** on until you trust it — everything is handed to you to finish.

## Live view (finish purchases from your phone)

When it's your turn the dashboard shows a yellow **YOUR TURN** card and Discord @mentions you.
Open **Live view**: it shows the bot's browser tab (refreshes ~1×/s). Tap anywhere to click there,
use the box to type (CVV, captcha answer…), zoom 2×/3× for small buttons. Tap **I bought it** /
**Didn't buy** when done (or just place the order — the bot notices the confirmation page).
Sessions are held for `handoff_hold_minutes` (default 20).

Set `DISCORD_MENTION_USER_ID` (Discord → Settings → Advanced → Developer Mode → right-click
yourself → Copy User ID) and `DASHBOARD_URL` (your dashboard address) in `.env` so alerts ping
you and link straight to Live view.

## Safety guards

| Guard | Default |
|---|---|
| Master switch / never click Place order | off / on |
| Auto-buy needs `max_price`; observed price ≤ max | required |
| Order total ≤ max_price + `max_total_overage_pct` (else hand off) | 20% |
| `max_orders_per_product` (lifetime, `data/orders.json`; hand-offs count until resolved) | 1 |
| `max_total_spend` (lifetime) | $300 |
| One flow per store at a time + cooldowns | |
| Config re-read right before Place order (kill switch works mid-checkout) | |
| "Unconfirmed" record written before clicking Place order — never double-buys | |

## Schedule

`monitor.interval_seconds` (default 30) is the normal per-store check speed. `monitor.hot_windows`
poll faster at known drop times — a Walmart Wednesday window ships enabled; add more in
**Settings → Schedule** (stores, days, start/end, timezone, interval). Very fast polling on a
logged-in account all day risks flags.

## Commands

```bash
npm start                                      # the bot + dashboard API (port 4200)
npm run login -- <store>                       # one-time login per store
npm run check -- walmart <product URL>         # what does the bot see on this page right now?
npm run checkout-test -- target 1010892076     # dry-run checkout from the terminal
npm run test-checkout                          # offline test suite (mock stores, fake Discord; buys nothing)
```

Stores: `target` (TCIN), `best-buy` (SKU), `walmart`, `costco`, `sams-club`, `pokemon-center` (product URL).

## Discord webhooks (`.env`)

`DISCORD_DROP_ALERTS` (required; fallback for all), `DISCORD_QUEUE_LIVE`, `DISCORD_ACTION_NEEDED`
(your turn), `DISCORD_CHECKOUT_SUCCESS`, `DISCORD_CHECKOUT_FAIL`, `DISCORD_DRAWINGS`,
`DISCORD_DISCOVERY`, `DISCORD_HEALTH`. Values in `.env` override `config.yaml`.

## Dashboard (frontend/)

Next.js app. Env: `DASHBOARD_PASSWORD` (required — the dashboard refuses all requests without it),
`DAEMON_URL` (where the bot's API is reachable), `DAEMON_TOKEN` (same value as the bot's `.env`).

## Things to know

- **Store pages change.** Button/selector lists live in `src/retailers/*.js`. When a step fails,
  a screenshot lands in `data/screenshots/` and in Discord; the bot hands the session to you
  rather than dropping it. Run `npm run check` / 🧪 Test before big drops.
- **Bot protection.** Walmart & Sam's (PerimeterX "Press & Hold"), Costco (Akamai) and Pokémon
  Center (DataDome / Imperva) actively block automation. Visible Chrome + your real logged-in
  profile helps a lot; when a captcha appears you get a hand-off to solve it in Live view.
  `CHECKOUT_PROXY` can route a session through a residential proxy.
- **Drawings** are entered on the product page when an "Enter drawing / Enter for a chance"
  button shows. Drawings that only exist in a store's phone app can't be entered by the bot —
  you get a "enter it yourself" alert instead. Winners are notified by the store (email/app).
- Store terms of service prohibit bots and stores can cancel orders or limit accounts.

## Architecture

```
src/
├── daemon.js          # starts monitor + discovery, serves the dashboard API
├── monitor.js         # one loop per store, hot windows, drop alerts
├── discovery.js       # new-listing search
├── session.js         # one persistent logged-in Chrome profile per store
├── live.js            # Live view frames + input
├── checkout/
│   ├── index.js       # engine: modes, queue alerts, hand-off, drawings, guards
│   ├── helpers.js     # selector/wait helpers, queue/captcha detection, checkout walker
│   ├── ledger.js      # data/orders.json
│   ├── browser.js     # Chrome launcher (profiles in ~/.drop-bot/profiles)
│   ├── login.js / cli.js
├── retailers/         # base.js + target, best-buy, walmart, costco, sams-club, pokemon-center
├── discord.js         # alerts (+ screenshots, @mentions)
├── config.js / env.js
frontend/              # dashboard, Settings, Live view
test/checkout-mock.test.js
```
