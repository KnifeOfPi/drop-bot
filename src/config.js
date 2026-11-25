// Config loader — reads config.yaml, validates, returns typed config

import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';
import './env.js'; // load .env for every entry point (daemon, monitors, CLIs)

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
// config.yaml in the repo is only a TEMPLATE. Your live settings (everything the
// dashboard edits) live in data/config.yaml, which git ignores — so `git pull`
// never conflicts with or overwrites them.
export const TEMPLATE_PATH = resolve(REPO_ROOT, 'config.yaml');
export const CONFIG_PATH = process.env.DROPBOT_CONFIG
  || resolve(process.env.DROPBOT_DATA_DIR || resolve(REPO_ROOT, 'data'), 'config.yaml');

if (!existsSync(CONFIG_PATH) && existsSync(TEMPLATE_PATH) && CONFIG_PATH !== TEMPLATE_PATH) {
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  copyFileSync(TEMPLATE_PATH, CONFIG_PATH);
  console.log(`[config] created ${CONFIG_PATH} from the template`);
}

let cachedConfig = null;
export function clearConfigCache() { cachedConfig = null; }

// Discord webhook URLs are secrets: keep them in .env, not in config.yaml.
// DISCORD_<KEY> (e.g. DISCORD_DROP_ALERTS) overrides discord.<key> from config.yaml.
export const WEBHOOK_KEYS = ['drop_alerts', 'queue_live', 'checkout_success', 'checkout_fail', 'action_needed', 'drawings', 'discovery', 'cancellations', 'health'];
export const webhookEnvName = (key) => `DISCORD_${key.toUpperCase()}`;

/** Webhook keys whose URL currently comes from the environment. */
export function webhooksFromEnv(discord = {}) {
  return [...new Set([...WEBHOOK_KEYS, ...Object.keys(discord || {})])]
    .filter(k => process.env[webhookEnvName(k)]);
}

function applyEnvOverrides(config) {
  config = config || {};
  config.discord = { ...(config.discord || {}) };
  for (const k of WEBHOOK_KEYS) if (!(k in config.discord)) config.discord[k] = '';
  for (const k of webhooksFromEnv(config.discord)) config.discord[k] = process.env[webhookEnvName(k)];
  return config;
}

export function loadConfig() {
  if (cachedConfig) return cachedConfig;
  try {
    const raw = readFileSync(CONFIG_PATH, 'utf8');
    const config = applyEnvOverrides(yaml.load(raw));
    cachedConfig = config;
    return config;
  } catch (e) {
    console.error(`[config] Failed to load ${CONFIG_PATH}: ${e.message}`);
    console.error(`[config] Delete it to start again from the template (${TEMPLATE_PATH})`);
    process.exit(1);
  }
}

export function getProductsByRetailer(retailer) {
  const config = loadConfig();
  return (config.products || []).filter(p => p.retailer === retailer);
}

export function getDiscordWebhooks() {
  const config = loadConfig();
  return config.discord || {};
}

export function getMonitorSettings(config) {
  return { ...MONITOR_DEFAULTS, ...((config || loadConfig()).monitor || {}) };
}

// Read config.yaml fresh from disk (no cache, never exits). Used by the
// checkout engine so the kill switch / dry-run / per-product toggles saved
// from the dashboard take effect immediately without a daemon restart.
export function loadConfigFresh() {
  try {
    return applyEnvOverrides(yaml.load(readFileSync(CONFIG_PATH, 'utf8')));
  } catch (e) {
    console.error(`[config] Fresh read failed: ${e.message}`);
    return null;
  }
}

export const RETAILERS = ['target', 'best-buy', 'walmart', 'costco', 'sams-club', 'pokemon-center'];

/**
 * Stores switched on in Settings (`stores:` in config). A store that's off is never
 * checked, searched or opened, and the dashboard hides it. No `stores:` list = all on.
 */
export function enabledStores(cfg) {
  const s = cfg?.stores;
  if (!Array.isArray(s)) return new Set(RETAILERS);
  return new Set(s.filter(r => RETAILERS.includes(r)));
}
export const storeEnabled = (cfg, retailer) => enabledStores(cfg).has(retailer);

// URL-identified retailers: how to pull a stable id out of the product URL.
const URL_ID = {
  walmart: /\/ip\/(?:[^/?#]+\/)?(\d+)/,
  costco: /\.product\.(\d+)\.html/,
  'sams-club': /\/ip\/(?:[^/?#]+\/)?([\w-]+)/,
  'pokemon-center': /\/product\/([\w-]+)/,
};

export function idFromUrl(retailer, url) {
  const u = String(url || '');
  const m = URL_ID[retailer] && u.match(URL_ID[retailer]);
  if (m) return m[1];
  return u.split(/[?#]/)[0].split('/').filter(Boolean).pop() || '';
}

// Stable identifier for a product within its retailer.
export function productId(product) {
  if (!product) return '';
  if (product.retailer === 'target') return String(product.tcin || '');
  if (product.retailer === 'best-buy') return String(product.sku || '');
  return idFromUrl(product.retailer, product.url);
}

/**
 * What to do when a product drops:
 *   notify   — alert only
 *   assist   — join the queue, add to cart, get to checkout, then hand off to you (the minimum)
 *   checkout — do all of the above and place the order
 * Older configs used auto_checkout: true/false.
 */
export function parseListingPrice(price) {
  const m = String(price ?? '').replace(/,/g, '').match(/(\d+(?:\.\d{1,2})?)/);
  return m ? parseFloat(m[1]) : null;
}

export const ACTIONS = ['notify', 'assist', 'checkout'];
export function productAction(product) {
  if (ACTIONS.includes(product?.action)) return product.action;
  return product?.auto_checkout ? 'checkout' : 'notify';
}

export function productKey(product) {
  return `${product.retailer}:${productId(product)}`;
}

export const CHECKOUT_DEFAULTS = {
  enabled: false,              // master kill switch
  dry_run: true,               // stop at the final "Place order" button
  headless: false,             // headed Chrome passes bot checks far more often
  max_orders_per_product: 1,   // lifetime successful orders per product (ledger-backed)
  max_total_spend: 300,        // lifetime spend cap across all products
  max_total_overage_pct: 20,   // abort if order total > max_price * (1 + pct) (tax/shipping headroom)
  retry_cooldown_seconds: 60,  // wait after a failed attempt before retrying that product
  step_timeout_seconds: 20,    // per-step wait (find button, page load, ...)
  queue_wait_minutes: 45,      // how long to sit in a waiting room / queue
  handoff_hold_minutes: 20,    // keep a handed-off session open this long for you to finish
  auto_enter_drawings: true,   // enter "enter to win" drawings on watched products
  proxy_stores: null,          // stores that use the proxy (null = all of them)
  profile_dir: '~/.drop-bot/profiles',
};

export const MONITOR_DEFAULTS = {
  interval_seconds: 60,        // per-retailer pass over its watchlist (outside hot windows)
  watch_mode: 'lite',          // 'lite' = light checks + occasional full checks; 'full' = full page every pass
  full_check_minutes: 15,      // lite mode: full Chrome check at most this often when a light check can't tell
  hot_full_check_minutes: 3,   // …and during hot windows
  daily_proxy_limit_mb: 500,   // pause automatically when today's proxy data reaches this (0 = no limit)
  max_consecutive_errors: 10,
  hot_windows: [],             // faster polling during known drop windows (see config.yaml)
  save_bandwidth: true,        // don't load images/fonts/video while watching & searching (proxy GBs)
};

export const DISCOVERY_DEFAULTS = {
  enabled: true,
  interval_minutes: 60,
  queries: ['pokemon trading card game', 'pokemon tcg'],
  must_match: 'pok[eé]mon',
  retailers: ['target', 'best-buy', 'walmart', 'costco', 'sams-club', 'pokemon-center'],
};

export function getDiscoverySettings(config) {
  return { ...DISCOVERY_DEFAULTS, ...((config || loadConfig()).discovery || {}) };
}

export function getCheckoutSettings(config) {
  return { ...CHECKOUT_DEFAULTS, ...((config || loadConfig()).checkout || {}) };
}

// ── One-time upgrade of settings written by the original (3-store) bot ────
export const CONFIG_VERSION = 4;
const WALMART_WEDNESDAY = {
  name: 'Walmart Wednesday drops', retailers: ['walmart'], days: ['wed'],
  start: '06:00', end: '18:00', timezone: 'America/New_York', interval_seconds: 10,
};

/**
 * Upgrade an old-format config in place (backup at <file>.v1.bak). Keeps your
 * products, webhooks and checkout values; returns a list of what changed, or
 * null if the file is already current.
 */
export function migrateConfigFile(path = CONFIG_PATH) {
  let raw;
  try { raw = readFileSync(path, 'utf8'); } catch { return null; }
  const cfg = yaml.load(raw) || {};
  const version = cfg.config_version || 1;
  if (version >= CONFIG_VERSION) return null;
  writeFileSync(`${path}.v${version}.bak`, raw);
  const changes = [];
  if (version < 2) migrateV1(cfg, changes);
  if (version < 3) migrateV2(cfg, changes);
  if (version < 4) migrateV3(cfg, changes);
  cfg.config_version = CONFIG_VERSION;
  writeFileSync(path, yaml.dump(cfg, { lineWidth: 120, noRefs: true }));
  cachedConfig = null;
  return changes;
}

/** v3 → v4: per-store on/off switches. Start with Target, Walmart and Pokémon Center on. */
function migrateV3(cfg, changes) {
  if (Array.isArray(cfg.stores)) return;
  cfg.stores = ['target', 'walmart', 'pokemon-center'];
  changes.push('stores on: Target, Walmart, Pokémon Center — Best Buy, Costco and Sam\'s Club are off (turn them on in Settings → Stores)');
}

/** v2 → v3: data-saving defaults (light checks, slower discovery, daily proxy limit). */
function migrateV2(cfg, changes) {
  cfg.monitor = { ...(cfg.monitor || {}) };
  if (!(cfg.monitor.interval_seconds >= 60)) {
    changes.push(`normal check interval ${cfg.monitor.interval_seconds ?? '?'}s → 60s (busy windows unchanged)`);
    cfg.monitor.interval_seconds = 60;
  }
  for (const k of ['watch_mode', 'full_check_minutes', 'hot_full_check_minutes', 'daily_proxy_limit_mb']) {
    if (cfg.monitor[k] === undefined) cfg.monitor[k] = MONITOR_DEFAULTS[k];
  }
  changes.push(`light checks on (full Chrome check at most every ${cfg.monitor.full_check_minutes} min when unclear)`);
  changes.push(`daily proxy data limit ${cfg.monitor.daily_proxy_limit_mb} MB (auto-pause, resumes at midnight)`);
  cfg.discovery = { ...DISCOVERY_DEFAULTS, ...(cfg.discovery || {}) };
  if (!(cfg.discovery.interval_minutes >= 60)) {
    changes.push(`new-listing search every ${cfg.discovery.interval_minutes} min → 60 min`);
    cfg.discovery.interval_minutes = 60;
  }
}

function migrateV1(cfg, changes) {

  cfg.monitor = { ...(cfg.monitor || {}) };
  if (!(cfg.monitor.interval_seconds >= 15)) {
    changes.push(`check interval ${cfg.monitor.interval_seconds ?? '?'}s → 30s (each check is now a real logged-in page load)`);
    cfg.monitor.interval_seconds = 30;
  }
  delete cfg.monitor.pc_queue_check_seconds;
  delete cfg.monitor.backoff_on_429;
  if (!Array.isArray(cfg.monitor.hot_windows)) {
    cfg.monitor.hot_windows = [WALMART_WEDNESDAY];
    changes.push('added the Walmart Wednesday hot window (every 10s, 6am–6pm ET)');
  }
  if (cfg.stealth) { delete cfg.stealth; changes.push('removed the old stealth-browser section'); }

  const before = cfg.checkout || {};
  cfg.checkout = { ...CHECKOUT_DEFAULTS, ...before };
  if (Object.keys(before).length === 0) changes.push('added automation settings (off, never clicks Place order)');

  if (!cfg.discovery) { cfg.discovery = { ...DISCOVERY_DEFAULTS }; changes.push('turned on new-listing discovery'); }

  let n = 0;
  for (const p of cfg.products || []) {
    if (!ACTIONS.includes(p.action)) {
      p.action = p.auto_checkout ? 'checkout' : 'assist';
      delete p.auto_checkout;
      n++;
    }
  }
  if (n) changes.push(`${n} products set to "Queue + cart, I finish" (only acts once automation is enabled)`);
}
