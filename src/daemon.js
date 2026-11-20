#!/usr/bin/env node
// Drop Bot Daemon — Main monitor loop
// Runs continuous stock checks across all retailers and fires Discord alerts.
//
// Usage: node src/daemon.js
// For systemd/pm2: ensure working directory is /tmp/drop-bot

import { loadConfig } from './config.js';
import { sendHealthAlert } from './discord.js';
import { checkTarget } from './monitors/target.js';
import { checkBestBuy } from './monitors/best-buy.js';
import { checkPokemonCenter } from './monitors/pokemon-center.js';

const config = loadConfig();
const settings = config.monitor || {};

const INTERVAL_MS = (settings.interval_seconds || 3) * 1000;
const MAX_ERRORS = settings.max_consecutive_errors || 10;

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
      return results.length;
    }).catch(e => {
      console.error(`[daemon] Target crash: ${e.message}`);
      bumpError('target');
    }),

    checkBestBuy().then(results => {
      const errors = results.filter(r => !r.result || r.result.error);
      if (errors.length > 0) bumpError('best-buy');
      else resetErrors('best-buy');
      return results.length;
    }).catch(e => {
      console.error(`[daemon] Best Buy crash: ${e.message}`);
      bumpError('best-buy');
    }),
  ];

  await Promise.all(apiPromises);

  // Pokemon Center runs after (uses stealth browser, can't parallel easily)
  try {
    await checkPokemonCenter();
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
    console.warn('[daemon] Edit config.yaml and add webhook URLs to the discord: section');
  }

  await sendHealthAlert('Drop Bot started — monitoring active ✅');

  // Graceful shutdown
  process.on('SIGINT', () => {
    console.log('\n[daemon] Shutting down...');
    running = false;
    sendHealthAlert('Drop Bot stopped (SIGINT)');
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    console.log('\n[daemon] Shutting down...');
    running = false;
    sendHealthAlert('Drop Bot stopped (SIGTERM)');
    process.exit(0);
  });

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