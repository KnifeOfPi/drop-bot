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
export const WEBHOOK_KEYS = ['drop_alerts', 'queue_live', 'checkout_success', 'checkout_fail', 'cancellations', 'health'];
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

export function getMonitorSettings() {
  const config = loadConfig();
  return config.monitor || { interval_seconds: 3, max_consecutive_errors: 10 };
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

// Stable identifier for a product within its retailer.
export function productId(product) {
  if (!product) return '';
  if (product.retailer === 'target') return String(product.tcin || '');
  if (product.retailer === 'best-buy') return String(product.sku || '');
  if (product.retailer === 'pokemon-center') return String(product.url || '').split('/').filter(Boolean).pop() || '';
  return String(product.sku || product.tcin || product.url || '');
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
  queue_wait_minutes: 30,      // how long to sit in a waiting room / queue
  profile_dir: '~/.drop-bot/profiles',
};

export function getCheckoutSettings(config) {
  return { ...CHECKOUT_DEFAULTS, ...((config || loadConfig()).checkout || {}) };
}
