// Checkout engine.
//
// The daemon calls onStockObserved() every time a monitor sees a product in
// stock. If checkout is enabled and the product is armed (auto_checkout: true),
// the engine runs the retailer flow:
//
//   product page → add to cart → checkout → (CVV) → review → guards → Place order
//
// Guards (all fail closed):
//   • checkout.enabled master switch + per-product auto_checkout, re-read from
//     config.yaml on every attempt AND again right before Place order
//   • product must have max_price; observed price and order total are checked
//     (total may exceed max_price by max_total_overage_pct for tax/shipping)
//   • max_orders_per_product and max_total_spend, backed by data/orders.json
//   • one attempt per retailer at a time; cooldowns between attempts
//   • dry_run stops at the Place order button
//
// An "unconfirmed" ledger entry is written BEFORE clicking Place order, so a
// timeout or crash after the click still counts as an order.

import { loadConfigFresh, getCheckoutSettings, productKey, productId } from '../config.js';
import { launchProfile } from './browser.js';
import { CheckoutError, parseMoney, readOrderTotal, screenshot } from './helpers.js';
import { recordAttempt, updateAttempt, recentAttempts, successfulOrders, totalSpend } from './ledger.js';
import { sendCheckoutAlert } from '../discord.js';
import target from './retailers/target.js';
import bestBuy from './retailers/best-buy.js';
import pokemonCenter from './retailers/pokemon-center.js';

export const FLOWS = { target, 'best-buy': bestBuy, 'pokemon-center': pokemonCenter };

const busyRetailers = new Map();   // retailer -> { key, started, dry_run }
const cooldownUntil = new Map();   // productKey -> epoch ms
const lastFailPing = new Map();    // productKey -> epoch ms
const lastSkipLog = new Map();     // productKey:reason -> epoch ms

const COOLDOWN = {
  unavailable: 20_000,
  dry_run: 60 * 60_000,
  guard: 10 * 60_000,
  not_logged_in: 10 * 60_000,
  success: 60_000,
  unconfirmed: 24 * 60 * 60_000,
};

function log(key, msg) { console.log(`[checkout] ${key}: ${msg}`); }
function logSkipOnce(key, reason, msg) {
  const k = `${key}:${reason}`;
  if (Date.now() - (lastSkipLog.get(k) || 0) < 5 * 60_000) return;
  lastSkipLog.set(k, Date.now());
  log(key, `skipped — ${msg}`);
}

function findLiveProduct(config, retailer, id) {
  return (config.products || []).find(p => p.retailer === retailer && productId(p) === id);
}

/** Called by the daemon for every in-stock observation. Never throws, never blocks the monitor loop. */
export function onStockObserved(product, observed = {}) {
  maybeCheckout(product, observed).catch(e => console.error(`[checkout] unexpected: ${e.stack || e.message}`));
}

async function maybeCheckout(product, observed) {
  const config = loadConfigFresh();
  if (!config) return;
  const settings = getCheckoutSettings(config);
  if (!settings.enabled) return;

  const key = productKey(product);
  const live = findLiveProduct(config, product.retailer, productId(product));
  if (!live?.auto_checkout) return;
  if (busyRetailers.has(live.retailer)) return;
  if ((cooldownUntil.get(key) || 0) > Date.now()) return;

  if (!(live.max_price > 0)) return logSkipOnce(key, 'no_max', 'auto_checkout requires max_price');
  const price = parseMoney(observed.price);
  if (price != null && price > live.max_price) {
    return logSkipOnce(key, 'price', `price $${price} > max $${live.max_price}`);
  }

  await runCheckout(live, { dryRun: settings.dry_run, trigger: 'in_stock', observedPrice: price });
}

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

/**
 * Run one checkout attempt. `dryRun` true stops before Place order.
 * Returns { status, ... } where status ∈ success | unconfirmed | dry_run | unavailable | failed | guard.
 */
export async function runCheckout(product, { dryRun = true, trigger = 'manual', observedPrice = null } = {}) {
  const flow = FLOWS[product.retailer];
  const key = productKey(product);
  if (!flow) return { status: 'failed', error: `no checkout flow for ${product.retailer}` };
  if (busyRetailers.has(product.retailer)) return { status: 'failed', error: `${product.retailer} checkout already running` };

  let settings = getCheckoutSettings(loadConfigFresh() || {});
  busyRetailers.set(product.retailer, { key, started: Date.now(), dry_run: dryRun });
  const started = Date.now();
  const cvv = process.env[flow.cvvEnv] || '';
  const ctx = { settings, timeout: settings.step_timeout_seconds * 1000, cvv, log: (m) => log(key, m) };
  const base = { key, retailer: product.retailer, label: product.label, trigger, dry_run: dryRun, max_price: product.max_price ?? null };

  let browser = null, page = null, attemptId = null, clicked = false;
  let result;

  try {
    if (!dryRun) checkLimits(product, settings, observedPrice ?? product.max_price ?? null);
    log(key, `${dryRun ? 'DRY RUN' : 'LIVE'} checkout starting (${trigger})`);

    ({ context: browser, page } = await launchProfile(product.retailer, settings));

    await flow.addToCart(page, product, ctx);
    log(key, 'added to cart');

    const placeBtn = await flow.toReview(page, product, ctx);
    log(key, 'reached Place order');

    const total = await readOrderTotal(page);
    const cap = product.max_price ? product.max_price * (1 + settings.max_total_overage_pct / 100) : null;
    if (total != null && cap != null && total > cap) {
      throw new CheckoutError('guard', `order total $${total} > cap $${cap.toFixed(2)} (max $${product.max_price} + ${settings.max_total_overage_pct}%) — extra items in cart?`);
    }
    if (total == null) log(key, 'could not read order total — relying on price check');

    if (dryRun) {
      const shot = await screenshot(page, `${key}-dryrun`);
      result = { ...base, status: 'dry_run', total, screenshot: shot, message: 'Stopped at Place order (dry run). Item is still in your cart.' };
    } else {
      // Last-moment re-check: kill switch / dry-run flipped while we were working, limits, spend.
      const fresh = loadConfigFresh();
      settings = getCheckoutSettings(fresh || {});
      const live = fresh && findLiveProduct(fresh, product.retailer, productId(product));
      if (!settings.enabled || settings.dry_run || !live?.auto_checkout) {
        throw new CheckoutError('guard', 'checkout disabled / switched to dry run before Place order — aborted');
      }
      checkLimits(product, settings, total ?? observedPrice ?? product.max_price);

      attemptId = recordAttempt({ ...base, status: 'unconfirmed', total, note: 'Place order clicked; awaiting confirmation' });
      await placeBtn.click();
      clicked = true;
      log(key, 'Place order clicked');

      const { order_number } = await flow.confirm(page, ctx);
      const shot = await screenshot(page, `${key}-success`);
      result = { ...base, status: 'success', total, order_number, screenshot: shot };
    }
  } catch (e) {
    const code = e instanceof CheckoutError ? e.code : 'step_failed';
    const shot = page ? await screenshot(page, `${key}-${code}`) : null;
    let status;
    if (clicked) {
      // After the click only a clear decline / OOS means "no order". Anything else may be a real order.
      status = (code === 'unavailable' || /declined/i.test(e.message)) ? 'failed' : 'unconfirmed';
    } else {
      status = code === 'unavailable' ? 'unavailable' : code === 'guard' ? 'guard' : 'failed';
    }
    result = { ...base, status, code, error: e.message.split('\n')[0], screenshot: shot };
  } finally {
    if (browser) await browser.close().catch(() => {});
    busyRetailers.delete(product.retailer);
  }

  result.duration_ms = Date.now() - started;
  finish(product, result, attemptId, settings);
  return result;
}

function finish(product, result, attemptId, settings) {
  const key = result.key;
  const cd = COOLDOWN[result.code] ?? COOLDOWN[result.status] ?? settings.retry_cooldown_seconds * 1000;
  // Only automatic runs set a cooldown — a manual test right before a drop must
  // not stop the bot from buying when stock actually lands.
  if (result.trigger === 'in_stock') cooldownUntil.set(key, Date.now() + cd);

  if (result.status === 'unavailable') {
    log(key, `not available (${result.error})${result.trigger === 'in_stock' ? ` — retry in ${Math.round(cd / 1000)}s` : ''}`);
    return; // not worth a ledger entry or a Discord ping
  }

  try {
    if (attemptId) updateAttempt(attemptId, result);
    else recordAttempt(result);
  } catch (e) {
    console.error(`[checkout] could not write ledger: ${e.message}`);
  }

  const icon = { success: '✅', dry_run: '🧪', unconfirmed: '❓', failed: '❌', guard: '🛑' }[result.status] || '•';
  log(key, `${icon} ${result.status.toUpperCase()}${result.error ? ` — ${result.error}` : ''}${result.order_number ? ` — order ${result.order_number}` : ''} (${result.duration_ms}ms)`);

  const isFail = result.status === 'failed' || result.status === 'guard';
  if (isFail) {
    if (Date.now() - (lastFailPing.get(key) || 0) < 5 * 60_000) return;
    lastFailPing.set(key, Date.now());
  }
  sendCheckoutAlert({ ...result, url: FLOWS[product.retailer]?.productUrl(product) }).catch(() => {});
}

export function getCheckoutStatus() {
  const config = loadConfigFresh() || {};
  const s = getCheckoutSettings(config);
  let spend = 0;
  try { spend = totalSpend(); } catch {}
  return {
    enabled: !!s.enabled,
    dry_run: !!s.dry_run,
    max_orders_per_product: s.max_orders_per_product,
    max_total_spend: s.max_total_spend,
    spend_total: Math.round(spend * 100) / 100,
    armed: (config.products || []).filter(p => p.auto_checkout).map(productKey),
    busy: Object.fromEntries(busyRetailers),
    recent: recentAttempts(15),
  };
}

export function findProduct(retailer, id) {
  const config = loadConfigFresh() || {};
  return findLiveProduct(config, retailer, String(id));
}
