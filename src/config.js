// Config loader — reads config.yaml, validates, returns typed config

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = resolve(__dirname, '..', 'config.yaml');

let cachedConfig = null;

export function loadConfig() {
  if (cachedConfig) return cachedConfig;
  try {
    const raw = readFileSync(CONFIG_PATH, 'utf8');
    const config = yaml.load(raw);
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