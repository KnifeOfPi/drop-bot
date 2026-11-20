# Drop Bot — Pokémon Product Monitor (M1)

Phase 1: Product stock monitors + Discord alerts for Pokémon Center, Target, and Best Buy.

## Quick start

```bash
cd /tmp/drop-bot
npm install

# Edit config.yaml — add your Discord webhook URLs and product watchlist
# Then start:
node src/daemon.js
```

## Retailer monitors

| Retailer | Method | Proxy needed? | Captcha needed? |
|---|---|---|---|
| **Target** | RedSky API (`redsky.target.com`) | No | No |
| **Best Buy** | BB API (`bestbuy.com/api/3.0/priceBlocks`) | No | No |
| **Pokémon Center** | Stealth browser (Playwright + DataImpulse proxy + 2Captcha) | Yes | Yes |

## Config

Edit `config.yaml`:

```yaml
discord:
  drop_alerts: "https://discord.com/api/webhooks/..."  # REQUIRED
  health: "https://discord.com/api/webhooks/..."        # optional

products:
  - retailer: target
    tcin: "1010892076"
    label: "30th Celebration ETB"
    max_price: 69.99
```

## Test individual monitors

```bash
node src/monitors/target.js
node src/monitors/best-buy.js
node src/monitors/pokemon-center.js
```

## Auto-checkout

When a monitor sees an **armed** product in stock, the bot opens a real Chrome
window with your saved retailer login and runs:
product page → add to cart → checkout → CVV → review → safety checks → **Place order**.

### One-time setup (on the machine that runs the daemon)

```bash
cp .env.example .env              # add TARGET_CVV / BESTBUY_CVV / POKEMONCENTER_CVV, DAEMON_TOKEN
npm run login -- target           # log in by hand, confirm saved address + card, close the window
npm run login -- best-buy
npm run login -- pokemon-center
```

Profiles live in `~/.drop-bot/profiles/<retailer>`; the bot never sees your passwords.
Install Google Chrome (or set `CHECKOUT_BROWSER_PATH`). Optional `CHECKOUT_PROXY` for Pokémon Center.

### Arm and test

1. Settings → Products: tick **Auto-checkout** on a product (it must have a Max $).
2. Settings → Checkout: turn on **Enable auto-checkout** (leave **Dry run** on).
3. Dashboard → **🧪 Test** on that product, or `npm run checkout-test -- target 1010892076`.
   A good run ends in `DRY RUN OK` with a screenshot of the Place order page in Discord.
   Dry runs leave the item in your cart — empty it afterwards.
4. When every retailer you care about passes, turn **Dry run** off.

`enabled`, `dry_run` and per-product `auto_checkout` are re-read on every attempt
(and again right before Place order), so flipping them in the dashboard is an instant kill switch.

### Safety guards

| Guard | Default |
|---|---|
| Master switch / dry run | off / on |
| Product must have `max_price`; observed price ≤ max | required |
| Order total ≤ max_price + `max_total_overage_pct` (catches extra items in cart) | 20% |
| `max_orders_per_product` (lifetime, `data/orders.json`) | 1 |
| `max_total_spend` (lifetime) | $300 |
| One checkout per retailer at a time + retry cooldown | 60s |

If Place order is clicked but no confirmation appears, the attempt is logged as
**UNCONFIRMED**, counts as an order, and is never retried — check your account.

Results go to the `checkout_success` / `checkout_fail` Discord webhooks (with a screenshot)
and to the dashboard's Checkout panel. Screenshots are kept in `data/screenshots/`.

### Offline test

```bash
npm run test-checkout   # runs every flow + guard against mock retailer pages; buys nothing
```

### Dashboard ↔ daemon auth

Set the same `DAEMON_TOKEN` in the daemon's `.env` and the frontend env (Vercel).
The dashboard's `/api` routes now require the login cookie.

## Keep alive

### pm2
```bash
pm2 start src/daemon.js --name drop-bot
pm2 save
```

### systemd
```bash
sudo cp drop-bot.service /etc/systemd/system/
sudo systemctl enable --now drop-bot
```

## Architecture

```
src/
├── daemon.js          # Main loop — polls all retailers every ~3s
├── config.js          # YAML config loader
├── discord.js         # Webhook relay with throttle/dedup + checkout alerts
├── env.js             # .env loader
├── checkout/
│   ├── index.js       # Checkout engine: triggers, guards, ledger, alerts
│   ├── browser.js     # Persistent per-retailer Chrome profiles
│   ├── helpers.js     # Selector/wait helpers, order-total parsing, queue + captcha
│   ├── ledger.js      # data/orders.json
│   ├── login.js       # npm run login -- <retailer>
│   ├── cli.js         # npm run checkout-test -- <retailer> <id>
│   └── retailers/     # target.js, best-buy.js, pokemon-center.js
└── monitors/
    ├── target.js      # RedSky API — checks TCIN stock/price
    ├── best-buy.js    # BB API — checks SKU stock/price
    └── pokemon-center.js # Stealth browser — checks product pages + queue
```

## Requirements

- Node.js 18+
- Stealth browser infra at `~/.hermes/skills/web-automation/stealth-browser/`
- 2Captcha API key (`$TWOCAPTCHA_API_KEY`)
- DataImpulse proxy (configured in `lib.mjs`)

## Phase 2 (planned)

- Order tracker (confirmation/cancellation emails)
- Multi-user license system
- Walmart, GameStop, Amazon support