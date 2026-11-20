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
├── discord.js         # Webhook relay with throttle/dedup
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

- Checkout automation (cart + payment)
- Order tracker (confirmation/cancellation emails)
- Multi-user license system
- Walmart, GameStop, Amazon support