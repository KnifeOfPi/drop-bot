// Config loader — reads config.yaml, validates, returns typed config

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';
import './env.js'; // load .env for every entry point (daemon, monitors, CLIs)

const __dirname = dirname(fileURLToPath(import.meta.url));
export const CONFIG_PATH = process.env.DROPBOT_CONFIG || resolve(__dirname, '..', 'config.yaml');

let cachedConfig = null;

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
    console.error(`[config] Failed to load config.yaml: ${e.message}`);
    console.error(`[config] Create config.yaml from the template at ${CONFIG_PATH}`);
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
  profile_dir: '~/.drop-bot/profiles',
};

export const MONITOR_DEFAULTS = {
  interval_seconds: 30,        // per-retailer pass over its watchlist (outside hot windows)
  max_consecutive_errors: 10,
  hot_windows: [],             // faster polling during known drop windows (see config.yaml)
};

export const DISCOVERY_DEFAULTS = {
  enabled: true,
  interval_minutes: 15,
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
