#!/usr/bin/env node
// One-off product check with the logged-in session — handy to confirm the bot
// "sees" a product page correctly before a drop.
//
//   npm run check -- walmart 5089452567
//   npm run check -- target 1010892076
//   npm run check -- costco 100123456
//
// Prints the detected status (in_stock / oos / queue / drawing_open / ...).
// Add --lite to run only the light check (one small download, shows which stock
// signal was found and how many KB it used) — no full page load:
//   npm run check -- target 1010892076 --lite
//   npm run check -- --all --lite        (every product in your watchlist)

import './env.js';
import { loadConfigFresh, getCheckoutSettings, idFromUrl } from './config.js';
import { getAdapter } from './retailers/index.js';
import { findProduct } from './checkout/index.js';
import { monitorPage, closeAll } from './session.js';
import { liteCheck } from './lite.js';
import { bytesToday } from './bandwidth.js';

const args = process.argv.slice(2);
const liteOnly = args.includes('--lite');
const positional = args.filter((a) => !a.startsWith('--'));

if (args.includes('--all')) {
  const cfg = loadConfigFresh() || {};
  for (const p of cfg.products || []) {
    const a = getAdapter(p.retailer);
    if (!a) continue;
    const before = bytesToday();
    const r = await liteCheck(a, p);
    const kb = ((bytesToday() - before) / 1024).toFixed(0);
    console.log(`${p.retailer.padEnd(15)} ${String(p.label).slice(0, 40).padEnd(41)} light → ${String(r.status).padEnd(9)} ${String(r.signal).padEnd(28)} ${kb} KB${r.error ? `  (${r.error})` : ''}`);
  }
  await closeAll();
  process.exit(0);
}

const [retailer, idOrUrl] = positional;
const adapter = getAdapter(retailer);
if (!adapter || !idOrUrl) {
  console.error('Usage: npm run check -- <target|best-buy|walmart|costco|sams-club|pokemon-center> <id or product URL>');
  process.exit(1);
}
const id = /^https?:/.test(idOrUrl) ? idFromUrl(retailer, idOrUrl) : idOrUrl;
const product = findProduct(retailer, id) || (
  retailer === 'target' ? { retailer, tcin: id, label: id }
  : retailer === 'best-buy' ? { retailer, sku: id, label: id }
  : /^https?:/.test(idOrUrl) ? { retailer, url: idOrUrl, label: id } : null
);
if (!product) {
  console.error(`Not in config.yaml — pass the full product URL for ${retailer}`);
  process.exit(1);
}

const settings = getCheckoutSettings(loadConfigFresh() || {});
if (liteOnly) {
  const before = bytesToday();
  const r = await liteCheck(adapter, product);
  console.log(JSON.stringify({ ...r, kb: Math.round((bytesToday() - before) / 1024) }, null, 2));
  await closeAll();
  process.exit(0);
}
const page = await monitorPage(retailer);
const res = await adapter.check(page, product, { settings, timeout: settings.step_timeout_seconds * 1000, log: console.log });
console.log(JSON.stringify(res, null, 2));
if (retailer === 'target') {
  const { targetDebug, isTargetLearned } = await import('./retailers/target.js');
  console.log(`\nTarget stock-data request learned: ${isTargetLearned() ? 'YES' : 'no'}`);
  console.log('Data requests the page made (method · where · HTTP status · product id in · has stock status):');
  for (const e of targetDebug.seen.slice(0, 30)) console.log(`  ${e.method.padEnd(5)} ${e.where.slice(0, 90).padEnd(90)} ${e.status}  id:${e.tcin}  stock:${e.stock ? 'YES' : '-'}`);
  if (!targetDebug.seen.length) console.log('  (none seen)');
}
await closeAll();
process.exit(0);
