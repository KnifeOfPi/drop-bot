// Watchlist monitor — one loop per retailer, each in that retailer's logged-in
// browser session. The product list is re-read from config.yaml every pass, so
// products added in the dashboard are picked up without a restart.
//
// Poll speed: monitor.interval_seconds normally, faster inside monitor.hot_windows
// (e.g. Walmart Wednesdays) so accounts aren't hammered all week.

import { loadConfigFresh, getMonitorSettings, getCheckoutSettings, productKey, productId, RETAILERS } from './config.js';
import { getAdapter } from './retailers/index.js';
import { monitorPage, closeSession } from './session.js';
import { onObserved, isBusy } from './checkout/index.js';
import { sendDropAlert, sendHealthAlert } from './discord.js';

export const productState = new Map(); // key -> latest observation for the dashboard
export const retailerHealth = Object.fromEntries(RETAILERS.map(r => [r, { errors: 0, last_tick: null, interval: null, hot: null, active: false }]));
let running = false;

const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/** Current hot window for a retailer, if any. Exported for tests. */
export function activeHotWindow(retailer, windows = [], now = new Date()) {
  for (const w of windows || []) {
    if (w.retailers?.length && !w.retailers.includes(retailer)) continue;
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
      timeZone: w.timezone || 'America/New_York', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(now).map(p => [p.type, p.value]));
    const day = parts.weekday.slice(0, 3).toLowerCase();
    if (w.days?.length && !w.days.map(d => String(d).slice(0, 3).toLowerCase()).includes(day)) continue;
    const hm = `${parts.hour}:${parts.minute}`;
    if (hm >= (w.start || '00:00') && hm < (w.end || '24:00')) return w;
  }
  return null;
}

export function intervalFor(retailer, settings, now = new Date()) {
  const hot = activeHotWindow(retailer, settings.hot_windows, now);
  return { seconds: hot?.interval_seconds ?? settings.interval_seconds, hot };
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const jitter = (ms) => ms * (0.85 + Math.random() * 0.3);

async function retailerLoop(retailer) {
  const adapter = getAdapter(retailer);
  const health = retailerHealth[retailer];
  while (running) {
    const config = loadConfigFresh() || {};
    if (config.paused) {
      // Paused from the dashboard: don't open a browser or load anything.
      health.active = false;
      health.errors = 0;
      await sleep(3000);
      continue;
    }
    const settings = getMonitorSettings(config);
    const csettings = getCheckoutSettings(config);
    const products = (config.products || []).filter(p => p.retailer === retailer && productId(p));
    const { seconds, hot } = intervalFor(retailer, settings);
    health.interval = seconds;
    health.hot = hot ? (hot.name || `${(hot.days || []).join('/')} ${hot.start}-${hot.end}`) : null;
    health.active = products.length > 0;

    if (products.length && !isBusy(retailer)) {
      let errored = false;
      try {
        const page = await monitorPage(retailer);
        const ctx = { settings: csettings, timeout: csettings.step_timeout_seconds * 1000, log: (m) => console.log(`[monitor] ${retailer}: ${m}`) };
        for (const product of products) {
          if (!running || isBusy(retailer) || loadConfigFresh()?.paused) break;
          let obs;
          try {
            obs = await adapter.check(page, product, ctx);
          } catch (e) {
            obs = { status: 'error', error: e.message.split('\n')[0] };
          }
          if (obs.status === 'error' || obs.status === 'blocked') errored = true;
          record(product, obs);
          await sleep(jitter(1200));
        }
      } catch (e) {
        errored = true;
        console.error(`[monitor] ${retailer}: session error — ${e.message.split('\n')[0]}`);
        await closeSession(retailer); // relaunch next pass
      }
      health.errors = errored ? health.errors + 1 : 0;
      health.last_tick = Date.now();
      if (health.errors === settings.max_consecutive_errors) {
        sendHealthAlert(`**${adapter.name}** monitor: ${health.errors} errors in a row — logged out, blocked by a captcha, or the site changed. Check the dashboard.`, true);
      }
    }
    await sleep(jitter(seconds * 1000));
  }
}

const ALERT_ON = { in_stock: 'in_stock', queue: 'queue_open', drawing_open: 'drawing_open' };

function record(product, obs) {
  const key = productKey(product);
  const prev = productState.get(key);
  const id = productId(product);
  productState.set(key, {
    key, retailer: product.retailer, label: product.label, sku: id,
    status: obs.status, in_stock: obs.status === 'in_stock' ? true : obs.status === 'oos' ? false : null,
    price: obs.price || prev?.price || 'N/A', title: obs.title, error: obs.error,
    last_checked: Date.now(), since: prev?.status === obs.status ? prev.since : Date.now(),
  });

  const icon = { in_stock: '🟢', oos: '🔴', queue: '🔵', drawing_open: '🎟️', drawing_entered: '✅', blocked: '🧱', error: '⚠️' }[obs.status] || '⚪';
  if (prev?.status !== obs.status) {
    console.log(`[monitor] ${key} ${product.label}: ${icon} ${obs.status}${obs.price && obs.price !== 'N/A' ? ` ${obs.price}` : ''}${obs.error ? ` — ${obs.error}` : ''}`);
    if (ALERT_ON[obs.status]) {
      sendDropAlert({
        retailer: product.retailer, label: product.label, url: getAdapter(product.retailer).productUrl(product),
        sku: `${id}:${obs.status}`, price: obs.price, status: ALERT_ON[obs.status], timestamp: Date.now(),
      }).catch(() => {});
    }
  }
  if (ALERT_ON[obs.status]) onObserved(product, obs);
}

export function startMonitors() {
  if (running) return;
  running = true;
  for (const r of RETAILERS) retailerLoop(r).catch(e => console.error(`[monitor] ${r} loop crashed: ${e.stack}`));
}

export function stopMonitors() {
  running = false;
}
