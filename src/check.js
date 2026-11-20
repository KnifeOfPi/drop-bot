#!/usr/bin/env node
// One-off product check with the logged-in session — handy to confirm the bot
// "sees" a product page correctly before a drop.
//
//   npm run check -- walmart 5089452567
//   npm run check -- target 1010892076
//   npm run check -- costco 100123456
//
// Prints the detected status (in_stock / oos / queue / drawing_open / ...).

import './env.js';
import { loadConfigFresh, getCheckoutSettings, idFromUrl } from './config.js';
import { getAdapter } from './retailers/index.js';
import { findProduct } from './checkout/index.js';
import { monitorPage, closeAll } from './session.js';

const [retailer, idOrUrl] = process.argv.slice(2);
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
const page = await monitorPage(retailer);
const res = await adapter.check(page, product, { settings, timeout: settings.step_timeout_seconds * 1000, log: console.log });
console.log(JSON.stringify(res, null, 2));
await closeAll();
process.exit(0);
