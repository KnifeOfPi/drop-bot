// Discord webhook relay — sends formatted product-drop embeds

import { loadConfig } from './config.js';
import { readFileSync, existsSync } from 'fs';
import { basename } from 'path';

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

// ── Checkout alerts ─────────────────────────────────────────────────────────

async function sendWebhookWithFile(webhookUrl, embed, filePath) {
  if (!webhookUrl) return { ok: false, error: 'no webhook URL configured' };
  if (!filePath || !existsSync(filePath)) return sendWebhook(webhookUrl, embed);
  try {
    const name = basename(filePath);
    const form = new FormData();
    form.append('payload_json', JSON.stringify({
      username: 'Pokémon Drop Bot',
      embeds: [{ ...embed, image: { url: `attachment://${name}` } }],
    }));
    form.append('files[0]', new Blob([readFileSync(filePath)], { type: 'image/png' }), name);
    const res = await fetch(webhookUrl, { method: 'POST', body: form });
    return { ok: res.ok, status: res.status };
  } catch {
    return sendWebhook(webhookUrl, embed);
  }
}

/**
 * Checkout result → Discord. success / dry_run go to checkout_success;
 * failed / guard / unconfirmed go to checkout_fail. Both fall back to drop_alerts.
 */
export async function sendCheckoutAlert(r) {
  const meta = {
    success:     { title: '✅ CHECKOUT SUCCESS', color: 0x2ECC71, hook: 'checkout_success' },
    dry_run:     { title: '🧪 Dry run reached Place order', color: 0x3498DB, hook: 'checkout_success' },
    unconfirmed: { title: '❓ Order clicked — NOT confirmed, check your account', color: 0xF39C12, hook: 'checkout_fail' },
    failed:      { title: '❌ Checkout failed', color: 0xE74C3C, hook: 'checkout_fail' },
    guard:       { title: '🛑 Checkout blocked by safety guard', color: 0x95A5A6, hook: 'checkout_fail' },
  }[r.status];
  if (!meta) return;

  const fields = [
    { name: 'Retailer', value: r.retailer || 'N/A', inline: true },
    { name: 'Total', value: r.total != null ? `$${Number(r.total).toFixed(2)}` : 'N/A', inline: true },
    { name: 'Max', value: r.max_price != null ? `$${r.max_price}` : 'N/A', inline: true },
  ];
  if (r.order_number) fields.push({ name: 'Order #', value: String(r.order_number), inline: true });
  if (r.duration_ms) fields.push({ name: 'Time', value: `${(r.duration_ms / 1000).toFixed(1)}s`, inline: true });

  const embed = {
    title: `${meta.title} — ${r.label}`,
    description: r.error || r.message || '',
    url: r.url,
    color: meta.color,
    fields,
    timestamp: new Date().toISOString(),
  };
  const url = webhooks[meta.hook] || webhooks.drop_alerts;
  if (!url) return { ok: false, error: 'no webhook URL configured' };
  const res = await sendWebhookWithFile(url, embed, r.screenshot);
  if (!res.ok) console.error(`[discord] checkout alert failed: ${JSON.stringify(res)}`);
  return res;
}