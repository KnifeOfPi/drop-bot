// Discord webhook relay — sends formatted product-drop embeds

import { loadConfig } from './config.js';

const config = loadConfig();
const webhooks = config.discord || {};

// Track sent alerts to throttle duplicates
const sentCache = new Map(); // key: "retailer:sku" -> timestamp

function throttleKey(retailer, sku) {
  return `${retailer}:${sku}`;
}

function shouldThrottle(retailer, sku) {
  const key = throttleKey(retailer, sku);
  const lastSent = sentCache.get(key);
  const now = Date.now();
  const window = (config.notifications?.throttle_same_product_seconds ?? 300) * 1000;
  if (lastSent && (now - lastSent) < window) return true;
  sentCache.set(key, now);
  return false;
}

// Rate-limit per-retailer spam (prevent burst of 20 alerts in 5 seconds)
const retailerLastSent = new Map();
function retailerThrottled(retailer) {
  const last = retailerLastSent.get(retailer);
  const now = Date.now();
  const window = (config.notifications?.throttle_same_retailer_seconds ?? 10) * 1000;
  if (last && (now - last) < window) return true;
  retailerLastSent.set(retailer, now);
  return false;
}

async function sendWebhook(webhookUrl, embed) {
  if (!webhookUrl) return { ok: false, error: 'no webhook URL configured' };
  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'Pokémon Drop Bot',
        avatar_url: 'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/items/poke-ball.png',
        embeds: [embed],
      }),
    });
    const text = await res.text();
    return { ok: res.ok, status: res.status, body: text.substring(0, 200) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * Send a drop alert to the configured Discord channel.
 * @param {Object} alert
 * @param {string} alert.retailer - "target" | "best-buy" | "pokemon-center"
 * @param {string} alert.label - product name
 * @param {string} alert.url - product URL
 * @param {string} alert.sku - SKU/TCIN/product ID
 * @param {string} alert.price - formatted price or "N/A"
 * @param {string} alert.status - "in_stock" | "out_of_stock" | "queue_open" | "queue_admitted"
 * @param {number} alert.timestamp - epoch ms
 */
export async function sendDropAlert(alert) {
  if (shouldThrottle(alert.retailer, alert.sku)) {
    console.log(`[discord] throttled: ${alert.retailer}/${alert.sku} — sent recently`);
    return { throttled: true };
  }

  const colors = {
    'target': 0xCC0000,
    'best-buy': 0x0046BE,
    'pokemon-center': 0xFFCB05,
  };

  const statusEmoji = alert.status === 'in_stock' ? '🟢' :
    alert.status === 'queue_open' ? '🔵' :
    alert.status === 'out_of_stock' ? '🔴' : '⚪';

  const embed = {
    title: `${statusEmoji} ${alert.label}`,
    description: `**${alert.status.toUpperCase()}** at ${alert.retailer}`,
    url: alert.url,
    color: colors[alert.retailer] || 0x9B59B6,
    fields: [
      { name: 'Retailer', value: alert.retailer, inline: true },
      { name: 'Price', value: alert.price || 'N/A', inline: true },
      { name: 'SKU', value: alert.sku || 'N/A', inline: true },
    ],
    footer: { text: `Drop Bot • ${new Date(alert.timestamp).toISOString()}` },
    timestamp: new Date(alert.timestamp).toISOString(),
  };

  if (retailerThrottled(alert.retailer)) {
    console.log(`[discord] retailer throttled: ${alert.retailer}`);
  }

  const result = await sendWebhook(webhooks.drop_alerts, embed);
  if (result.ok) {
    console.log(`[discord] sent: ${alert.retailer} ${alert.label} (${alert.status})`);
  } else {
    console.error(`[discord] failed: ${JSON.stringify(result)}`);
  }
  return result;
}

export async function sendHealthAlert(message, isError = false) {
  const embed = {
    title: isError ? '⚠️ Bot Error' : '✅ Bot Status',
    description: message,
    color: isError ? 0xFF0000 : 0x00FF00,
    timestamp: new Date().toISOString(),
  };
  if (webhooks.health) await sendWebhook(webhooks.health, embed);
}

export { sendWebhook };