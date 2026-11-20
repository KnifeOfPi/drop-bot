#!/usr/bin/env node
// Drop Bot Daemon — Main monitor loop
// Runs continuous stock checks across all retailers and fires Discord alerts.
//
// Usage: node src/daemon.js
// For systemd/pm2: ensure working directory is /tmp/drop-bot

import './env.js';
import { loadConfig, CONFIG_PATH, webhooksFromEnv, WEBHOOK_KEYS } from './config.js';
import { sendHealthAlert } from './discord.js';
import { checkTarget } from './monitors/target.js';
import { checkBestBuy } from './monitors/best-buy.js';
import { checkPokemonCenter } from './monitors/pokemon-center.js';
import { onStockObserved, getCheckoutStatus, runCheckout, findProduct } from './checkout/index.js';
import { createServer } from 'http';
import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';

const __dirname = dirname(fileURLToPath(import.meta.url));

const config = loadConfig();
const settings = config.monitor || {};

const INTERVAL_MS = (settings.interval_seconds || 3) * 1000;
const MAX_ERRORS = settings.max_consecutive_errors || 10;
const HTTP_PORT = parseInt(process.env.DAEMON_PORT || '4200', 10);
const DAEMON_TOKEN = process.env.DAEMON_TOKEN || '';
const ENV_MARKER = '(set via env)';
const START_TIME = Date.now();

// In-memory state for API
const latestProductResults = new Map(); // "retailer:sku" -> { in_stock, price, last_checked }
const retailerLastTick = {}; // retailer -> epoch ms

// Per-retailer error tracking
const errorCounts = { target: 0, 'best-buy': 0, 'pokemon-center': 0 };
let running = true;

function resetErrors(retailer) {
  errorCounts[retailer] = 0;
}

function bumpError(retailer) {
  errorCounts[retailer] = (errorCounts[retailer] || 0) + 1;
  if (errorCounts[retailer] >= MAX_ERRORS) {
    console.error(`[daemon] ⚠️ ${retailer}: ${errorCounts[retailer]} consecutive errors — pausing retailer`);
    sendHealthAlert(`**${retailer}** monitor: ${errorCounts[retailer]} consecutive errors — check logs`, true);
  }
}

// ── Tick: one poll cycle across all retailers ──────────────────────────────

let tickCount = 0;

async function tick() {
  tickCount++;
  const start = Date.now();

  // Target + Best Buy run in parallel (API-based, fast)
  const apiPromises = [
    checkTarget().then(results => {
      const errors = results.filter(r => r.result.error);
      if (errors.length > 0) bumpError('target');
      else resetErrors('target');
      // Track results
      for (const r of results) {
        if (!r.result.error) {
          const key = `target:${r.product.tcin}`;
          latestProductResults.set(key, {
            retailer: 'target', label: r.product.label, sku: r.product.tcin,
            price: r.result.price, in_stock: r.result.in_stock, last_checked: Date.now(),
          });
          if (r.result.in_stock === true) onStockObserved(r.product, { price: r.result.price });
        }
      }
      retailerLastTick.target = Date.now();
      return results.length;
    }).catch(e => {
      console.error(`[daemon] Target crash: ${e.message}`);
      bumpError('target');
    }),

    checkBestBuy().then(results => {
      const errors = results.filter(r => !r.result || r.result.error);
      if (errors.length > 0) bumpError('best-buy');
      else resetErrors('best-buy');
      for (const r of results) {
        if (r.result && !r.result.error) {
          const key = `best-buy:${r.product.sku}`;
          latestProductResults.set(key, {
            retailer: 'best-buy', label: r.product.label, sku: r.product.sku,
            price: r.result.price, in_stock: r.result.available, last_checked: Date.now(),
          });
          if (r.result.available === true) onStockObserved(r.product, { price: r.result.price });
        }
      }
      retailerLastTick['best-buy'] = Date.now();
      return results.length;
    }).catch(e => {
      console.error(`[daemon] Best Buy crash: ${e.message}`);
      bumpError('best-buy');
    }),
  ];

  await Promise.all(apiPromises);

  // Pokemon Center runs after (uses stealth browser, can't parallel easily)
  try {
    const pcResults = await checkPokemonCenter();
    for (const r of pcResults) {
      if (!r.result.error) {
        const key = `pokemon-center:${r.product.url}`;
        latestProductResults.set(key, {
          retailer: 'pokemon-center', label: r.product.label, sku: r.product.url.split('/').pop(),
          price: r.result.price, in_stock: r.result.in_stock, last_checked: Date.now(),
        });
        if (r.result.in_stock === true) onStockObserved(r.product, { price: r.result.price });
      }
    }
    retailerLastTick['pokemon-center'] = Date.now();
    resetErrors('pokemon-center');
  } catch (e) {
    console.error(`[daemon] Pokemon Center crash: ${e.message}`);
    bumpError('pokemon-center');
  }

  const elapsed = Date.now() - start;
  if (tickCount % 20 === 0) {
    console.log(`[daemon] tick #${tickCount} (${elapsed}ms) — target:${errorCounts.target} bb:${errorCounts['best-buy']} pc:${errorCounts['pokemon-center']}`);
  }
}

// ── Startup ─────────────────────────────────────────────────────────────────

async function main() {
  console.log('[daemon] 🚀 Drop Bot starting...');
  console.log(`[daemon] Monitor interval: ${INTERVAL_MS}ms`);
  console.log(`[daemon] Max consecutive errors: ${MAX_ERRORS}`);
  console.log(`[daemon] Products: ${config.products?.length || 0} total`);

  const byRetailer = {};
  for (const p of (config.products || [])) {
    byRetailer[p.retailer] = (byRetailer[p.retailer] || 0) + 1;
  }
  for (const [r, count] of Object.entries(byRetailer)) {
    console.log(`[daemon]   ${r}: ${count} products`);
  }

  const webhooks = config.discord || {};
  const configuredHooks = Object.entries(webhooks).filter(([, v]) => v).length;
  console.log(`[daemon] Discord webhooks configured: ${configuredHooks}/${Object.keys(webhooks).length}`);

  if (configuredHooks === 0) {
    console.warn('[daemon] ⚠️ No Discord webhooks configured — alerts will not be sent');
    console.warn('[daemon] Add webhook URLs to .env as DISCORD_DROP_ALERTS, DISCORD_HEALTH, ... (see .env.example)');
  }

  await sendHealthAlert('Drop Bot started — monitoring active ✅');

  // ── HTTP health endpoint for frontend dashboard ─────────────────────────
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${HTTP_PORT}`);
    const path = url.pathname;
    const method = req.method;

    // No CORS headers: the dashboard talks to the daemon server-to-server via its
    // /api routes, so browsers never need cross-origin access. Allowing "*" would
    // let any website you visit reach this API (and arm checkout) on localhost.
    if (method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // Shared-secret auth (set DAEMON_TOKEN in .env and in the frontend env).
    if (DAEMON_TOKEN && req.headers.authorization !== `Bearer ${DAEMON_TOKEN}`) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }

    // ── GET /status ──────────────────────────────────────────────────────
    if (path === '/status' && method === 'GET') {
      const products = Array.from(latestProductResults.values());
      const retailers = ['target', 'best-buy', 'pokemon-center'].map(r => ({
        retailer: r,
        errors: errorCounts[r] || 0,
        max_errors: MAX_ERRORS,
        last_tick: retailerLastTick[r] || null,
      }));
      const body = JSON.stringify({
        running,
        uptime_seconds: Math.floor((Date.now() - START_TIME) / 1000),
        tick_count: tickCount,
        pid: process.pid,
        products,
        retailers,
        checkout: getCheckoutStatus(),
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(body);
      return;
    }

    // ── GET /config ──────────────────────────────────────────────────────
    if (path === '/config' && method === 'GET') {
      try {
        const raw = readFileSync(CONFIG_PATH, 'utf8');
        const current = yaml.load(raw);
        // Sanitize: mask webhook URLs; hooks supplied by .env are shown as ENV_MARKER
        current.discord = { ...(current.discord || {}) };
        for (const k of WEBHOOK_KEYS) if (!(k in current.discord)) current.discord[k] = '';
        for (const k of Object.keys(current.discord)) {
          if (current.discord[k] && typeof current.discord[k] === 'string') {
            current.discord[k] = current.discord[k].substring(0, 8) + '...';
          }
        }
        for (const k of webhooksFromEnv(current.discord)) current.discord[k] = ENV_MARKER;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(current));
      } catch (e) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }

    // ── PUT /config ──────────────────────────────────────────────────────
    if (path === '/config' && method === 'PUT') {
      try {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const body = Buffer.concat(chunks).toString();
        const updates = JSON.parse(body);
        const raw = readFileSync(CONFIG_PATH, 'utf8');
        const current = yaml.load(raw);

        // GET /config masks webhook URLs ("https://..."). When the dashboard saves the
        // whole config back, keep the real URL instead of overwriting it with the mask.
        if (updates.discord) {
          for (const [k, v] of Object.entries(updates.discord)) {
            // Env-supplied hooks are never written into config.yaml.
            if (v === ENV_MARKER) { delete updates.discord[k]; continue; }
            const real = current.discord?.[k];
            if (typeof v === 'string' && typeof real === 'string' && real && v === real.substring(0, 8) + '...') {
              updates.discord[k] = real;
            }
          }
        }

        // Deep merge updates into current config
        function deepMerge(target, source) {
          for (const key of Object.keys(source)) {
            if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
              if (!target[key] || typeof target[key] !== 'object') target[key] = {};
              deepMerge(target[key], source[key]);
            } else {
              target[key] = source[key];
            }
          }
        }
        deepMerge(current, updates);

        // Write back
        const output = yaml.dump(current, { lineWidth: 120, noRefs: true });
        writeFileSync(CONFIG_PATH, output, 'utf8');
        console.log('[daemon] Config updated — reload daemon to apply changes');

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, message: 'Config updated. Restart daemon to apply.' }));
      } catch (e) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }

    // ── POST /checkout/test  { retailer, id } ─────────────────────────────
    // Runs a DRY RUN checkout (stops at Place order) to verify login + selectors.
    if (path === '/checkout/test' && method === 'POST') {
      try {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const { retailer, id } = JSON.parse(Buffer.concat(chunks).toString() || '{}');
        const product = findProduct(retailer, id);
        if (!product) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `no ${retailer} product ${id} in config` }));
          return;
        }
        if (getCheckoutStatus().busy[retailer]) {
          res.writeHead(409, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `${retailer} checkout already running` }));
          return;
        }
        runCheckout(product, { dryRun: true, trigger: 'dashboard_test' })
          .catch(e => console.error(`[daemon] checkout test crashed: ${e.message}`));
        res.writeHead(202, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, message: `Dry run started for ${product.label} — result appears under Checkout and in Discord` }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }

    // ── GET /logs ────────────────────────────────────────────────────────
    if (path === '/logs' && method === 'GET') {
      const lines = parseInt(url.searchParams.get('lines') || '100');
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      // Stream stdout is the daemon's own console — return recent log buffer
      res.end(`[drop-bot daemon] PID ${process.pid} — uptime ${Math.floor((Date.now() - START_TIME) / 1000)}s — ticks ${tickCount}\n`);
      return;
    }

    res.writeHead(404);
    res.end(JSON.stringify({ error: 'not found' }));
  });
  server.listen(HTTP_PORT, () => {
    console.log(`[daemon] HTTP status server on port ${HTTP_PORT}`);
  });

  // Cleanup server on shutdown
  const shutdown = () => {
    server.close();
    running = false;
    sendHealthAlert('Drop Bot stopped');
    process.exit(0);
  };
  process.on('SIGINT', () => { console.log('\n[daemon] Shutting down...'); shutdown(); });
  process.on('SIGTERM', () => { console.log('\n[daemon] Shutting down...'); shutdown(); });

  // Main loop
  while (running) {
    try {
      await tick();
    } catch (e) {
      console.error(`[daemon] Unhandled tick error: ${e.message}`);
    }
    await sleep(INTERVAL_MS);
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

main().catch(e => {
  console.error(`[daemon] Fatal: ${e.message}`);
  console.error(e.stack);
  process.exit(1);
});