// Drop engine — what happens when the monitor sees a watched product go live.
//
// Per-product `action` (config.yaml / Settings):
//   notify   — Discord alert only (the monitor sends it)
//   assist   — join the queue → add to cart → go to checkout → HAND OFF to you
//   checkout — same, then click Place order (unless global dry_run is on, in
//              which case it hands off instead of clicking)
//
// Hand-off: the bot keeps the logged-in tab open, pings you on Discord, and you
// finish in the dashboard's Live view (or at the PC). If it sees an order
// confirmation on that tab it marks the order done by itself.
//
// Drawings: when a watched product shows an "enter drawing" button and
// auto_enter_drawings is on, the bot enters it and records the entry.
//
// Guards (fail closed): master switch, per-product action, max_price + order
// total cap, lifetime per-product order limit + spend cap (data/orders.json),
// one flow per retailer at a time, cooldowns, last-moment config re-check, and
// an "unconfirmed" record written BEFORE Place order so a crash can't double-buy.

import { loadConfigFresh, getCheckoutSettings, productKey, productId, productAction } from '../config.js';
import { newPage } from '../session.js';
import { RETAILER_ADAPTERS, getAdapter } from '../retailers/index.js';
import { CheckoutError, parseMoney, readOrderTotal, screenshot, bodyText } from './helpers.js';
import { recordAttempt, updateAttempt, recentAttempts, successfulOrders, totalSpend, recentDrawingEntry } from './ledger.js';
import { sendCheckoutAlert } from '../discord.js';

export const FLOWS = RETAILER_ADAPTERS;

const busy = new Map();            // retailer -> { key, label, kind, mode, started, in_queue }
const cooldownUntil = new Map();   // key -> epoch ms
const lastFailPing = new Map();    // key -> epoch ms
const lastSkipLog = new Map();     // key:reason -> epoch ms
const handoffs = new Map();        // id -> handoff

const COOLDOWN = {
  unavailable: 20_000,
  dry_run: 60 * 60_000,
  guard: 10 * 60_000,
  not_logged_in: 10 * 60_000,
  success: 60_000,
  unconfirmed: 24 * 60 * 60_000,
  abandoned: 30 * 60_000,
  handoff_expired: 30 * 60_000,
  handoff_closed: 30 * 60_000,
};

function log(key, msg) { console.log(`[engine] ${key}: ${msg}`); }
function logSkipOnce(key, reason, msg) {
  const k = `${key}:${reason}`;
  if (Date.now() - (lastSkipLog.get(k) || 0) < 5 * 60_000) return;
  lastSkipLog.set(k, Date.now());
  log(key, `skipped — ${msg}`);
}

function findLiveProduct(config, retailer, id) {
  return (config.products || []).find(p => p.retailer === retailer && productId(p) === String(id));
}
export function findProduct(retailer, id) {
  return findLiveProduct(loadConfigFresh() || {}, retailer, id);
}
const activeHandoffFor = (key) => [...handoffs.values()].some(h => h.key === key);
const dashboardLink = (id) => process.env.DASHBOARD_URL ? `${process.env.DASHBOARD_URL.replace(/\/$/, '')}/live?id=${id}` : null;

// ── Entry point from the monitor ───────────────────────────────────────────

/** Called for every in_stock / queue / drawing_open observation. Never throws or blocks. */
export function onObserved(product, obs = {}) {
  handleObservation(product, obs).catch(e => console.error(`[engine] unexpected: ${e.stack || e.message}`));
}
// Backwards-compatible name.
export const onStockObserved = (product, observed = {}) => onObserved(product, { status: 'in_stock', ...observed });

async function handleObservation(product, obs) {
  const config = loadConfigFresh();
  if (!config) return;
  const settings = getCheckoutSettings(config);
  if (!settings.enabled) return;

  const live = findLiveProduct(config, product.retailer, productId(product));
  if (!live) return;
  const key = productKey(live);

  if (obs.status === 'drawing_open') {
    if (settings.auto_enter_drawings && live.drawings !== false) await maybeDrawing(live, settings);
    return;
  }
  if (obs.status !== 'in_stock' && obs.status !== 'queue') return;

  const action = productAction(live);
  if (action === 'notify') return;
  if (busy.has(live.retailer) || activeHandoffFor(key)) return;
  if ((cooldownUntil.get(key) || 0) > Date.now()) return;

  if (action === 'checkout' && !(live.max_price > 0)) return logSkipOnce(key, 'no_max', 'full checkout requires max_price');
  const price = parseMoney(obs.price);
  if (live.max_price > 0 && price != null && price > live.max_price) {
    return logSkipOnce(key, 'price', `price $${price} > max $${live.max_price}`);
  }

  // Global dry_run never clicks Place order: a "checkout" product is handed off instead.
  const mode = action === 'checkout' && !settings.dry_run ? 'checkout' : 'assist';
  await runFlow(live, { mode, trigger: obs.status === 'queue' ? 'queue_open' : 'in_stock', observedPrice: price });
}

// ── Limits ─────────────────────────────────────────────────────────────────

function checkLimits(product, settings, amount) {
  const key = productKey(product);
  let orders, spend;
  try {
    orders = successfulOrders(key).length;
    spend = totalSpend();
  } catch {
    throw new CheckoutError('guard', 'order ledger (data/orders.json) is unreadable — fix or remove it');
  }
  if (orders >= settings.max_orders_per_product) {
    throw new CheckoutError('guard', `already ordered ${orders}/${settings.max_orders_per_product} of this product`);
  }
  if (amount != null && spend + amount > settings.max_total_spend) {
    throw new CheckoutError('guard', `spend cap: $${spend.toFixed(2)} spent + $${amount.toFixed(2)} > $${settings.max_total_spend}`);
  }
}

// ── Buy flow (queue → cart → checkout → place / hand off) ──────────────────

/**
 * mode: 'checkout' (place the order) | 'assist' (hand off at Place order) | 'dry_run' (stop and close)
 * Returns { status } ∈ success | unconfirmed | handoff | dry_run | unavailable | failed | guard
 */
export async function runFlow(product, { mode = 'assist', trigger = 'manual', observedPrice = null } = {}) {
  const adapter = getAdapter(product.retailer);
  const key = productKey(product);
  if (!adapter) return { status: 'failed', error: `unknown retailer ${product.retailer}` };
  if (busy.has(product.retailer)) return { status: 'failed', error: `${adapter.name} flow already running` };

  let settings = getCheckoutSettings(loadConfigFresh() || {});
  const state = { key, label: product.label, kind: 'buy', mode, started: Date.now(), in_queue: false };
  busy.set(product.retailer, state);
  const started = Date.now();
  const base = { key, retailer: product.retailer, label: product.label, trigger, mode, dry_run: mode === 'dry_run', max_price: product.max_price ?? null, url: adapter.productUrl(product) };

  let queueAlerted = false;
  const ctx = {
    settings,
    timeout: settings.step_timeout_seconds * 1000,
    cvv: process.env[adapter.cvvEnv] || '',
    log: (m) => log(key, m),
    onQueueEnter: async () => {
      state.in_queue = true;
      if (!queueAlerted) {
        queueAlerted = true;
        sendCheckoutAlert({ ...base, status: 'queue_joined' }).catch(() => {});
      }
    },
    onQueueExit: async () => {
      state.in_queue = false;
      sendCheckoutAlert({ ...base, status: 'queue_passed' }).catch(() => {});
    },
  };

  let page = null, attemptId = null, clicked = false, inCart = false, handedOff = false;
  let result;

  try {
    if (mode !== 'dry_run') checkLimits(product, settings, mode === 'checkout' ? (observedPrice ?? product.max_price ?? null) : null);
    log(key, `${mode.toUpperCase()} flow starting (${trigger})`);

    page = await newPage(product.retailer);

    await adapter.addToCart(page, product, ctx);
    inCart = true;
    log(key, 'added to cart');

    const placeBtn = await adapter.toReview(page, product, ctx);
    log(key, 'reached Place order');

    const total = await readOrderTotal(page);
    const cap = product.max_price ? product.max_price * (1 + settings.max_total_overage_pct / 100) : null;
    if (total != null && cap != null && total > cap) {
      const err = new CheckoutError('guard', `order total $${total} > cap $${cap.toFixed(2)} (max $${product.max_price} + ${settings.max_total_overage_pct}%) — extra items in cart?`);
      err.handoffOk = true;
      throw err;
    }

    if (mode === 'dry_run') {
      const shot = await screenshot(page, `${key}-dryrun`);
      result = { ...base, status: 'dry_run', total, screenshot: shot, message: 'Stopped at Place order (dry run). Item is still in your cart.' };
    } else if (mode === 'assist') {
      result = await startHandoff(product, page, base, { total, reason: 'In your cart at the Place order step — tap to finish the purchase.' });
      handedOff = true;
    } else {
      // Last-moment re-check: kill switch / dry-run / action changed while we were working.
      const fresh = loadConfigFresh();
      settings = getCheckoutSettings(fresh || {});
      const live = fresh && findLiveProduct(fresh, product.retailer, productId(product));
      if (!settings.enabled || !live || productAction(live) === 'notify') {
        throw new CheckoutError('guard', 'automation disabled for this product before Place order — aborted');
      }
      if (settings.dry_run || productAction(live) !== 'checkout') {
        const err = new CheckoutError('guard', 'switched to dry run / assist before Place order — finish it yourself');
        err.handoffOk = true;
        throw err;
      }
      checkLimits(product, settings, total ?? observedPrice ?? product.max_price);

      attemptId = recordAttempt({ ...base, status: 'unconfirmed', total, note: 'Place order clicked; awaiting confirmation' });
      await placeBtn.click();
      clicked = true;
      log(key, 'Place order clicked');

      const { order_number } = await adapter.confirm(page, ctx);
      const shot = await screenshot(page, `${key}-success`);
      result = { ...base, status: 'success', total, order_number, screenshot: shot };
    }
  } catch (e) {
    const code = e instanceof CheckoutError ? e.code : 'step_failed';
    const msg = e.message.split('\n')[0];
    if (clicked) {
      // After the click only a clear decline / OOS means "no order". Anything else may be a real order.
      const status = (code === 'unavailable' || /declined/i.test(msg)) ? 'failed' : 'unconfirmed';
      result = { ...base, status, code, error: msg, screenshot: page ? await screenshot(page, `${key}-${code}`) : null };
    } else if (
      page && !page.isClosed() && mode !== 'dry_run' &&
      (code === 'guard' ? e.handoffOk : (inCart || ['captcha', 'queue_timeout', 'not_logged_in'].includes(code)))
    ) {
      // The bot got stuck but the session is worth saving — hand it to you.
      result = await startHandoff(product, page, base, { reason: `Bot stopped: ${msg}. ${inCart ? 'Item is in your cart' : 'Session is open'} — finish it in Live view.`, code });
      handedOff = true;
    } else {
      const status = code === 'unavailable' ? 'unavailable' : code === 'guard' ? 'guard' : 'failed';
      result = { ...base, status, code, error: msg, screenshot: page ? await screenshot(page, `${key}-${code}`) : null };
    }
  } finally {
    busy.delete(product.retailer);
    if (page && !handedOff) await page.close().catch(() => {});
  }

  result.duration_ms = Date.now() - started;
  if (result.status !== 'handoff') finish(product, result, attemptId, settings);
  return result;
}

/** Backwards-compatible manual entry: dryRun true → dry_run, false → checkout. */
export function runCheckout(product, { dryRun = true, trigger = 'manual', observedPrice = null } = {}) {
  return runFlow(product, { mode: dryRun ? 'dry_run' : 'checkout', trigger, observedPrice });
}

function finish(product, result, attemptId, settings) {
  const key = result.key;
  const cd = COOLDOWN[result.code] ?? COOLDOWN[result.status] ?? settings.retry_cooldown_seconds * 1000;
  // Only automatic runs set a cooldown — a manual test right before a drop must not block the real one.
  if (result.trigger !== 'manual' && result.trigger !== 'dashboard_test' && result.trigger !== 'cli') {
    cooldownUntil.set(key, Date.now() + cd);
  }

  if (result.status === 'unavailable') {
    log(key, `not available (${result.error})`);
    return;
  }

  try {
    if (attemptId) updateAttempt(attemptId, result);
    else recordAttempt(result);
  } catch (e) {
    console.error(`[engine] could not write ledger: ${e.message}`);
  }

  const icon = { success: '✅', dry_run: '🧪', unconfirmed: '❓', failed: '❌', guard: '🛑' }[result.status] || '•';
  log(key, `${icon} ${result.status.toUpperCase()}${result.error ? ` — ${result.error}` : ''}${result.order_number ? ` — order ${result.order_number}` : ''} (${result.duration_ms}ms)`);

  if (result.status === 'failed' || result.status === 'guard') {
    if (Date.now() - (lastFailPing.get(key) || 0) < 5 * 60_000) return;
    lastFailPing.set(key, Date.now());
  }
  sendCheckoutAlert(result).catch(() => {});
}

// ── Hand-off ───────────────────────────────────────────────────────────────

async function startHandoff(product, page, base, { total = null, reason, code } = {}) {
  const settings = getCheckoutSettings(loadConfigFresh() || {});
  const adapter = getAdapter(product.retailer);
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const shot = await screenshot(page, `${base.key}-handoff`);
  const h = {
    id, key: base.key, retailer: product.retailer, label: product.label, page, reason, code: code || null, total,
    started: Date.now(), expires: Date.now() + settings.handoff_hold_minutes * 60_000,
    attemptId: recordAttempt({ ...base, status: 'handoff', total, message: reason, handoff_id: id }),
  };
  handoffs.set(id, h);
  log(base.key, `🙋 HANDOFF ${id} — ${reason}`);

  page.on('close', () => { if (handoffs.has(id)) resolveHandoff(id, 'handoff_closed'); });
  h.timer = setInterval(async () => {
    if (!handoffs.has(id)) return clearInterval(h.timer);
    if (Date.now() > h.expires) return resolveHandoff(id, 'handoff_expired');
    try {
      if (!page.isClosed() && await adapter.isConfirmed(page)) {
        const m = (await bodyText(page)).match(adapter.sel.orderNumber);
        await resolveHandoff(id, 'success', { order_number: m?.[1] || null, screenshot: await screenshot(page, `${base.key}-success`) });
      }
    } catch { /* page navigating */ }
  }, 4000);

  const result = { ...base, status: 'handoff', handoff_id: id, total, message: reason, screenshot: shot, live_url: dashboardLink(id), expires: h.expires };
  sendCheckoutAlert(result).catch(() => {});
  return result;
}

/** outcome: success | abandoned | handoff_expired | handoff_closed */
export async function resolveHandoff(id, outcome, extra = {}) {
  const h = handoffs.get(id);
  if (!h) return false;
  handoffs.delete(id);
  clearInterval(h.timer);
  const status = outcome === 'success' ? 'success' : outcome;
  try { updateAttempt(h.attemptId, { status, ...extra, resolved_ts: Date.now() }); } catch (e) { console.error(`[engine] ledger: ${e.message}`); }
  cooldownUntil.set(h.key, Date.now() + (COOLDOWN[status] ?? 60_000));
  if (!h.page.isClosed()) await h.page.close().catch(() => {});
  log(h.key, `handoff ${id} → ${status}`);
  sendCheckoutAlert({ key: h.key, retailer: h.retailer, label: h.label, status, total: h.total, ...extra }).catch(() => {});
  return true;
}

export function getHandoff(id) {
  return handoffs.get(id) || null;
}

// ── Drawings ───────────────────────────────────────────────────────────────

async function maybeDrawing(product) {
  const key = productKey(product);
  const dkey = `drawing:${key}`;
  if (busy.has(product.retailer)) return;
  if ((cooldownUntil.get(dkey) || 0) > Date.now()) return;
  if (recentDrawingEntry(key, 12)) return;
  await runDrawing(product, { trigger: 'drawing_open' });
}

export async function runDrawing(product, { trigger = 'manual' } = {}) {
  const adapter = getAdapter(product.retailer);
  const key = productKey(product);
  if (!adapter) return { status: 'failed', error: 'unknown retailer' };
  if (busy.has(product.retailer)) return { status: 'failed', error: `${adapter.name} is busy` };
  const settings = getCheckoutSettings(loadConfigFresh() || {});
  busy.set(product.retailer, { key, label: product.label, kind: 'drawing', mode: 'drawing', started: Date.now(), in_queue: false });
  const base = { key, retailer: product.retailer, label: product.label, trigger, url: adapter.productUrl(product) };
  const ctx = { settings, timeout: settings.step_timeout_seconds * 1000, cvv: '', log: (m) => log(key, m) };
  let page = null, result;
  try {
    page = await newPage(product.retailer);
    const res = await adapter.enterDrawing(page, product, ctx);
    result = { ...base, status: 'drawing_entered', already: !!res.already, screenshot: await screenshot(page, `${key}-drawing`), message: res.already ? 'Already entered' : 'Entered the drawing' };
  } catch (e) {
    const code = e instanceof CheckoutError ? e.code : 'step_failed';
    if (code === 'unavailable') result = { ...base, status: 'drawing_closed', error: e.message };
    else result = { ...base, status: 'drawing_manual', code, error: e.message.split('\n')[0], screenshot: page ? await screenshot(page, `${key}-drawing-fail`) : null };
  } finally {
    busy.delete(product.retailer);
    if (page) await page.close().catch(() => {});
  }

  cooldownUntil.set(`drawing:${key}`, Date.now() + (result.status === 'drawing_entered' ? 12 * 3600_000 : result.status === 'drawing_closed' ? 60_000 : 3 * 3600_000));
  log(key, `drawing → ${result.status}${result.error ? ` (${result.error})` : ''}`);
  if (result.status === 'drawing_closed') return result;
  try { recordAttempt(result); } catch {}
  if (!(result.status === 'drawing_entered' && result.already)) sendCheckoutAlert(result).catch(() => {});
  return result;
}

// ── Status for the dashboard ───────────────────────────────────────────────

export function isBusy(retailer) {
  return busy.has(retailer);
}

export function getCheckoutStatus() {
  const config = loadConfigFresh() || {};
  const s = getCheckoutSettings(config);
  let spend = 0;
  try { spend = totalSpend(); } catch {}
  const products = config.products || [];
  return {
    enabled: !!s.enabled,
    dry_run: !!s.dry_run,
    auto_enter_drawings: !!s.auto_enter_drawings,
    max_orders_per_product: s.max_orders_per_product,
    max_total_spend: s.max_total_spend,
    spend_total: Math.round(spend * 100) / 100,
    armed: products.filter(p => productAction(p) !== 'notify').map(productKey),
    actions: Object.fromEntries(products.map(p => [productKey(p), productAction(p)])),
    busy: Object.fromEntries(busy),
    handoffs: [...handoffs.values()].map(({ page, timer, attemptId, ...h }) => ({ ...h, url: page.isClosed() ? null : page.url() })),
    recent: recentAttempts(20),
  };
}
