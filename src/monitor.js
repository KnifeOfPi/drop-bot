// Watchlist monitor — one loop per retailer, each in that retailer's logged-in
// browser session. The product list is re-read from config.yaml every pass, so
// products added in the dashboard are picked up without a restart.
//
// Poll speed: monitor.interval_seconds normally, faster inside monitor.hot_windows
// (e.g. Walmart Wednesdays) so accounts aren't hammered all week.
//
// Data use (watch_mode 'lite', the default): each pass does a LIGHT check per
// product (src/lite.js — one small response). A full Chrome page check only
// runs to confirm something live (in stock / queue / possible drawing), or when
// light checks can't tell — and then at most every full_check_minutes
// (hot_full_check_minutes in hot windows). Stores whose light checks never give
// an answer stop light-checking for 6 h. A daily proxy data limit pauses the
// bot automatically (resumes the next day).

import { loadConfigFresh, getMonitorSettings, getCheckoutSettings, productKey, productId, RETAILERS, storeEnabled } from './config.js';
import { getAdapter } from './retailers/index.js';
import { monitorPage, closeSession, openSessions } from './session.js';
import { onObserved, isBusy } from './checkout/index.js';
import { sendDropAlert, sendHealthAlert } from './discord.js';
import { liteCheck } from './lite.js';
import { bytesToday } from './bandwidth.js';
import { proxiedStoreSet } from './accounts.js';
import { setPaused, today } from './pause.js';

export const productState = new Map(); // key -> latest observation for the dashboard
export const retailerHealth = Object.fromEntries(RETAILERS.map(r => [r, { errors: 0, last_tick: null, interval: null, hot: null, active: false, watch: null }]));
let running = false;
let guardTimer = null;

const lastFull = new Map(); // product key -> time of last full Chrome check
const LITE_GIVE_UP = 6;     // unclear light checks in a row (with no clear answer yet) before giving up for a while
export const liteStats = Object.fromEntries(RETAILERS.map(r => [r, { unclear: 0, definite: 0, off_until: 0 }]));

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

/**
 * Check one product the data-cheap way. Returns an observation, or null when
 * nothing needed checking this pass (light checks off and no full check due).
 */
async function checkProduct(retailer, adapter, product, settings, hot, ctx) {
  const key = productKey(product);
  const st = liteStats[retailer];
  const lite = settings.watch_mode !== 'full';
  const fullEvery = (hot ? settings.hot_full_check_minutes : settings.full_check_minutes) * 60_000;
  const fullDue = Date.now() - (lastFull.get(key) || 0) >= fullEvery;

  if (lite && Date.now() >= st.off_until) {
    const l = await liteCheck(adapter, product);
    if (l.status === 'oos') {
      st.unclear = 0; st.definite++;
      return { status: 'oos', price: l.price || undefined, via: `light (${l.signal})` };
    }
    if (['in_stock', 'queue', 'maybe'].includes(l.status)) {
      st.unclear = 0; st.definite++;
      ctx.log(`${product.label}: light check says ${l.status} (${l.signal}) — confirming with a full check`);
    } else {
      if (!l.learning) st.unclear++; // "still learning" (e.g. Target) doesn't count toward giving up
      if (st.unclear >= LITE_GIVE_UP && st.definite === 0) {
        st.off_until = Date.now() + 6 * 3600_000;
        st.unclear = 0;
        ctx.log(`light checks give no stock info here (${l.signal}) — using full checks every ${settings.full_check_minutes} min for the next 6 h`);
      }
      if (!fullDue) return null;
    }
  } else if (lite && !fullDue) {
    return null;
  }

  const page = await monitorPage(retailer);
  lastFull.set(key, Date.now());
  let obs;
  try {
    obs = await adapter.check(page, product, ctx);
  } catch (e) {
    obs = { status: 'error', error: e.message.split('\n')[0] };
  }
  return { ...obs, via: 'full' };
}

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
    if (!storeEnabled(config, retailer)) {
      // Store switched off in Settings: no checks, and close its browser if one is open.
      if (health.active || openSessions().includes(retailer)) {
        if (!isBusy(retailer)) await closeSession(retailer).catch(() => {});
        console.log(`[monitor] ${retailer}: store is off — not checking`);
      }
      health.active = false;
      health.errors = 0;
      await sleep(5000);
      continue;
    }
    const settings = getMonitorSettings(config);
    const csettings = getCheckoutSettings(config);
    const products = (config.products || []).filter(p => p.retailer === retailer && productId(p));
    const { seconds, hot } = intervalFor(retailer, settings);
    health.interval = seconds;
    health.hot = hot ? (hot.name || `${(hot.days || []).join('/')} ${hot.start}-${hot.end}`) : null;
    health.active = products.length > 0;
    health.watch = settings.watch_mode === 'full' ? 'full page every pass'
      : Date.now() < liteStats[retailer].off_until ? `full check every ${hot ? settings.hot_full_check_minutes : settings.full_check_minutes} min`
      : 'light checks';

    if (products.length && !isBusy(retailer)) {
      let errored = false;
      try {
        const ctx = { settings: csettings, timeout: csettings.step_timeout_seconds * 1000, log: (m) => console.log(`[monitor] ${retailer}: ${m}`) };
        for (const product of products) {
          if (!running || isBusy(retailer) || loadConfigFresh()?.paused) break;
          const obs = await checkProduct(retailer, adapter, product, settings, hot, ctx);
          if (!obs) continue;
          if (obs.status === 'error' || obs.status === 'blocked') errored = true;
          record(product, obs);
          await sleep(jitter(obs.via === 'full' ? 1200 : 400));
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
    price: obs.price || prev?.price || 'N/A', title: obs.title, error: obs.error, via: obs.via,
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

/**
 * Daily proxy data limit: pause when today's proxy data reaches the limit;
 * resume automatically the next day. If you resume by hand after hitting it,
 * it won't pause again that day.
 */
export async function dataGuard() {
  const cfg = loadConfigFresh() || {};
  const d = today();
  if (cfg.paused) {
    if (cfg.paused_reason === 'data_limit' && cfg.data_limit_hit_day !== d) {
      await setPaused(false, 'data_limit', 'data limit (new day)');
      sendHealthAlert("New day — resumed after yesterday's proxy data limit.").catch(() => {});
    }
    return;
  }
  const limitMb = Number(getMonitorSettings(cfg).daily_proxy_limit_mb) || 0;
  if (!limitMb || cfg.data_limit_hit_day === d) return;
  const used = bytesToday(proxiedStoreSet(cfg));
  if (used >= limitMb * 1024 * 1024) {
    await setPaused(true, 'data_limit', 'data limit');
    sendHealthAlert(`⏸ Paused: today's proxy data reached ${(used / 1048576).toFixed(0)} MB (limit ${limitMb} MB). It resumes automatically at midnight — or raise the limit / tap Resume on the dashboard.`, true).catch(() => {});
  }
}

export function startMonitors() {
  if (running) return;
  running = true;
  for (const r of RETAILERS) retailerLoop(r).catch(e => console.error(`[monitor] ${r} loop crashed: ${e.stack}`));
  dataGuard().catch(() => {});
  guardTimer = setInterval(() => dataGuard().catch(() => {}), 15_000);
}

export function stopMonitors() {
  running = false;
  clearInterval(guardTimer);
}
