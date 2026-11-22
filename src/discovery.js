// Discovery — searches every retailer for new Pokémon listings so drops show up
// even before you've added them to the watchlist. New listings are posted to
// Discord and listed in the dashboard with a one-tap "Watch" button.
//
// The first search on each retailer just learns what's already listed (no alert
// flood); after that only genuinely new product ids are announced.

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { loadConfigFresh, getDiscoverySettings, getCheckoutSettings } from './config.js';
import { getAdapter } from './retailers/index.js';
import { newPage, leanPage } from './session.js';
import { isBusy } from './checkout/index.js';
import { DATA_DIR } from './checkout/ledger.js';
import { sendDiscoveryAlert } from './discord.js';

const FILE = resolve(DATA_DIR, 'discovered.json');
let running = false;
export const discoveryState = { last_run: null, running: false, errors: {} };

function load() {
  if (!existsSync(FILE)) return { seen: {}, seeded: {}, recent: [] };
  try { return JSON.parse(readFileSync(FILE, 'utf8')); } catch { return { seen: {}, seeded: {}, recent: [] }; }
}
function save(d) {
  d.recent = d.recent.slice(0, 150);
  writeFileSync(FILE, JSON.stringify(d, null, 2));
}

export function recentDiscoveries(n = 30) {
  return load().recent.slice(0, n);
}

export function markWatched(retailer, id) {
  const d = load();
  for (const l of d.recent) if (l.retailer === retailer && l.id === id) l.watched = true;
  save(d);
}

export function findDiscovery(retailer, id) {
  return load().recent.find(l => l.retailer === retailer && l.id === id) || null;
}

/** One discovery pass over every enabled retailer. Exported for tests / manual runs. */
export async function discoverOnce() {
  const config = loadConfigFresh() || {};
  const s = getDiscoverySettings(config);
  const cs = getCheckoutSettings(config);
  const ctx = { settings: cs, timeout: cs.step_timeout_seconds * 1000, log: () => {} };
  const match = new RegExp(s.must_match || '.', 'i');
  const data = load();
  discoveryState.running = true;
  const fresh = [];

  for (const retailer of s.retailers || []) {
    const adapter = getAdapter(retailer);
    if (!adapter?.search || isBusy(retailer)) continue;
    let page;
    try {
      page = await leanPage(retailer, await newPage(retailer), 'discovery');
      const seeding = !data.seeded[retailer];
      let ok = false;
      for (const query of s.queries || []) {
        const listings = await adapter.search(page, query, ctx);
        if (listings == null) { discoveryState.errors[retailer] = 'queue/captcha on search page'; break; }
        delete discoveryState.errors[retailer];
        ok = true;
        for (const l of listings) {
          const plain = l.title.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
          if (!match.test(l.title) && !match.test(plain)) continue;
          const key = `${retailer}:${l.id}`;
          if (data.seen[key]) continue;
          data.seen[key] = Date.now();
          if (seeding) continue;
          const item = { ...l, retailer, query, found: Date.now(), watched: false };
          data.recent.unshift(item);
          fresh.push(item);
        }
      }
      if (ok) data.seeded[retailer] = true;
    } catch (e) {
      discoveryState.errors[retailer] = e.message.split('\n')[0];
    } finally {
      if (page) await page.close().catch(() => {});
    }
  }

  save(data);
  discoveryState.running = false;
  discoveryState.last_run = Date.now();
  for (const item of fresh) {
    console.log(`[discovery] 🆕 ${item.retailer}: ${item.title} ${item.price || ''}`);
    await sendDiscoveryAlert(item).catch(() => {});
  }
  return fresh;
}

export function startDiscovery() {
  if (running) return;
  running = true;
  (async () => {
    await new Promise(r => setTimeout(r, 20_000)); // let monitors open their sessions first
    while (running) {
      const s = getDiscoverySettings(loadConfigFresh() || {});
      if (s.enabled && !loadConfigFresh()?.paused) {
        try { await discoverOnce(); } catch (e) { console.error(`[discovery] ${e.message}`); }
      }
      await new Promise(r => setTimeout(r, Math.max(2, s.interval_minutes) * 60_000));
    }
  })();
}

export function stopDiscovery() {
  running = false;
}
