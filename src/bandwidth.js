// Data meter + data saver for the store browsers.
//
// Meter: counts the bytes each tab actually downloads (cache hits excluded),
// per store and per activity — monitor (watching), discovery (searching) and
// flow (checkout, drawings, sign-in, Live view). Kept per day in
// data/bandwidth.json so the dashboard can show what uses your proxy data.
//
// Saver: on monitor + discovery tabs, blocks images, video, fonts and ad /
// analytics trackers using Chrome's own URL blocking. Unlike request
// interception, this keeps the HTTP cache on, so each store's script bundles
// are downloaded once and reused instead of on every check.
// Store bot-protection / captcha / queue scripts are deliberately NOT blocked.

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { DATA_DIR } from './checkout/ledger.js';

const FILE = resolve(DATA_DIR, 'bandwidth.json');
const KEEP_DAYS = 14;

export const BLOCK_PATTERNS = [
  // Images, video, fonts, icons
  '*.jpg*', '*.jpeg*', '*.png*', '*.gif*', '*.webp*', '*.avif*', '*.ico*', '*.bmp*',
  '*.mp4*', '*.webm*', '*.m3u8*', '*.mov*', '*.woff*', '*.ttf*', '*.otf*', '*.eot*',
  // Store image CDNs (URLs without file extensions)
  '*scene7.com/is/image*', '*/is/image/*', '*walmartimages.com/*', '*bbystatic.com/image*',
  '*images.costco-static.com*', '*ytimg.com*', '*youtube.com/embed*',
  // Ads, analytics, session replay, tag managers
  '*google-analytics.com*', '*googletagmanager.com*', '*doubleclick.net*', '*googlesyndication.com*',
  '*googleadservices.com*', '*connect.facebook.net*', '*facebook.com/tr*', '*analytics.tiktok.com*',
  '*ct.pinterest.com*', '*s.pinimg.com/ct*', '*bat.bing.com*', '*criteo.com*', '*criteo.net*',
  '*adobedtm.com*', '*omtrdc.net*', '*demdex.net*', '*everesttech.net*', '*quantummetric.com*',
  '*contentsquare.net*', '*hotjar.com*', '*fullstory.com*', '*nr-data.net*', '*js-agent.newrelic.com*',
  '*clarity.ms*', '*sc-static.net*', '*tr.snapchat.com*', '*ads-twitter.com*', '*amazon-adsystem.com*',
  '*adnxs.com*', '*taboola.com*', '*outbrain.com*', '*snap.licdn.com*', '*px.ads.linkedin.com*',
  '*redditstatic.com/ads*', '*go-mpulse.net*', '*cquotient.com*', '*cdn.segment.com*', '*api.segment.io*',
];

// ── Meter ───────────────────────────────────────────────────────────────────

const today = () => new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD, server-local
let store = load();
let dirty = false;

function load() {
  if (!existsSync(FILE)) return { days: {} };
  try { return JSON.parse(readFileSync(FILE, 'utf8')); } catch { return { days: {} }; }
}

function save() {
  if (!dirty) return;
  const days = Object.keys(store.days).sort();
  for (const d of days.slice(0, Math.max(0, days.length - KEEP_DAYS))) delete store.days[d];
  try { writeFileSync(FILE, JSON.stringify(store)); dirty = false; } catch {}
}
setInterval(save, 60_000).unref();
process.on('exit', save);

// Per-minute totals per store for the last hour (rate shown on the dashboard).
const minutes = new Map(); // minuteIndex -> { retailer: bytes }

/** Record bytes downloaded for a store (also used by light checks). */
export function addBytes(retailer, purpose, bytes) {
  if (!bytes) return;
  const d = (store.days[today()] ||= {});
  const r = (d[retailer] ||= { monitor: 0, discovery: 0, flow: 0 });
  r[purpose] = (r[purpose] || 0) + bytes;
  dirty = true;
  const m = Math.floor(Date.now() / 60_000);
  const bucket = minutes.get(m) || {};
  bucket[retailer] = (bucket[retailer] || 0) + bytes;
  minutes.set(m, bucket);
  for (const k of minutes.keys()) if (k < m - 60) minutes.delete(k);
}
const add = addBytes;

/** Bytes today for the given stores (e.g. the ones that use the proxy). */
export function bytesToday(stores) {
  const d = store.days[today()] || {};
  let t = 0;
  for (const [r, v] of Object.entries(d)) if (!stores || stores.has(r)) t += (v.monitor || 0) + (v.discovery || 0) + (v.flow || 0);
  return t;
}

/** Bytes in the last 60 minutes for the given stores. */
export function bytesLastHour(stores) {
  const since = Math.floor(Date.now() / 60_000) - 60;
  let t = 0;
  for (const [m, bucket] of minutes) {
    if (m <= since) continue;
    for (const [r, b] of Object.entries(bucket)) if (!stores || stores.has(r)) t += b;
  }
  return t;
}

const purposes = new WeakMap(); // page -> 'monitor' | 'discovery' | 'flow'
const cdps = new WeakMap();     // page -> Promise<CDPSession>

/** Attach the byte meter to a tab (idempotent). Returns its CDP session. */
export function meterPage(retailer, page) {
  if (!cdps.has(page)) {
    cdps.set(page, (async () => {
      const cdp = await page.context().newCDPSession(page);
      const cached = new Set();
      await cdp.send('Network.enable');
      cdp.on('Network.requestServedFromCache', (e) => cached.add(e.requestId));
      cdp.on('Network.responseReceived', (e) => {
        const r = e.response;
        if (r.fromDiskCache || r.fromPrefetchCache || r.fromServiceWorker) cached.add(e.requestId);
      });
      cdp.on('Network.loadingFinished', (e) => {
        if (cached.delete(e.requestId)) return;
        add(retailer, purposes.get(page) || 'flow', e.encodedDataLength);
      });
      cdp.on('Network.loadingFailed', (e) => cached.delete(e.requestId));
      return cdp;
    })().catch(() => null));
  }
  return cdps.get(page);
}

/** Mark a tab as monitor/discovery and turn on the data saver for it. */
export async function leanPage(retailer, page, purpose, enabled = true) {
  purposes.set(page, purpose);
  const cdp = await meterPage(retailer, page);
  if (cdp && enabled) await cdp.send('Network.setBlockedURLs', { urls: BLOCK_PATTERNS }).catch(() => {});
  return page;
}

/** Usage for the dashboard: today per store + daily totals for the last 7 days. */
export function bandwidthStatus(proxiedStores = new Set()) {
  const d = store.days[today()] || {};
  const stores = {};
  let total = 0, proxied = 0;
  for (const [r, v] of Object.entries(d)) {
    const t = (v.monitor || 0) + (v.discovery || 0) + (v.flow || 0);
    stores[r] = { ...v, total: t, via_proxy: proxiedStores.has(r) };
    total += t;
    if (proxiedStores.has(r)) proxied += t;
  }
  const days = Object.keys(store.days).sort().slice(-7).map((day) => ({
    day,
    total: Object.values(store.days[day]).reduce((s, v) => s + (v.monitor || 0) + (v.discovery || 0) + (v.flow || 0), 0),
  }));
  const proxyHour = bytesLastHour(proxiedStores);
  return { today: today(), stores, total_today: total, proxy_today: proxied, proxy_last_hour: proxyHour, days };
}
