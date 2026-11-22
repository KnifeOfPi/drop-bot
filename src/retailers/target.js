// Target. Mostly online drops, some drawings. Requires a logged-in profile with
// a default shipping address and saved card (Target only shows Ship it / Add to
// cart reliably when logged in). Target often asks for CVV — TARGET_CVV in .env.

import { defineRetailer } from './base.js';
import { CheckoutError, clickFirst, findFirst, fillIfPresent, waitForAny, textMatches, bodyText, waitOutQueue, trySolveCaptcha } from '../checkout/helpers.js';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { DATA_DIR } from '../checkout/ledger.js';

// ── Light checks for Target ────────────────────────────────────────────────
// Target's product page HTML has no stock info: the page loads it afterwards
// with a separate data request. During a full check we look at every data
// response the page gets from Target and learn from the one that carries the
// product's stock status ("availability_status") — whatever its address or
// method. Light checks then replay that request per product (only the TCIN
// changes): a few KB of JSON instead of a 330 KB page. If it stops working,
// the next full check re-learns it.
const LEARNED = resolve(DATA_DIR, 'target-fulfillment.json');
const SKIP_HEADERS = /^(cookie|user-agent|referer|origin|host|content-length|accept-encoding|accept-language|connection|sec-|priority$)/i;
let fulfillment = (() => {
  try {
    const f = existsSync(LEARNED) ? JSON.parse(readFileSync(LEARNED, 'utf8')) : null;
    if (f && !f.url && f.template) return { method: 'GET', url: f.template, body: null, headers: {} }; // older format
    return f?.url ? f : null;
  } catch { return null; }
})();
let learnedWaiters = [];

// What the last full check saw (for `npm run check` diagnostics — no keys/values).
export const targetDebug = { seen: [] };

function learnFulfillment(req, tcin) {
  const url = req.url();
  const body = req.postData() || null;
  const inUrl = url.includes(tcin);
  const inBody = !!body && body.includes(tcin);
  if (!inUrl && !inBody) return false; // can't be reused for other products
  const headers = {};
  for (const [k, v] of Object.entries(req.headers())) if (!SKIP_HEADERS.test(k)) headers[k] = v;
  const next = {
    method: req.method(),
    url: url.split(tcin).join('{TCIN}'),
    body: body ? body.split(tcin).join('{TCIN}') : null,
    headers,
    learned_at: Date.now(),
  };
  const changed = !fulfillment || fulfillment.url !== next.url || fulfillment.body !== next.body || fulfillment.method !== next.method;
  fulfillment = next;
  try { writeFileSync(LEARNED, JSON.stringify(fulfillment)); } catch {}
  if (changed) console.log(`[target] learned the stock-data request (${next.method} ${new URL(url).host}${new URL(url).pathname}) — light checks enabled`);
  for (const w of learnedWaiters) w();
  learnedWaiters = [];
  return true;
}

function waitUntilLearned(ms) {
  if (fulfillment?.url) return Promise.resolve(true);
  return new Promise((resolveWait) => {
    const t = setTimeout(() => resolveWait(false), ms);
    learnedWaiters.push(() => { clearTimeout(t); resolveWait(true); });
  });
}

export function forgetTargetLearning() { forgetFulfillment(); }

function forgetFulfillment() {
  fulfillment = null;
  try { writeFileSync(LEARNED, 'null'); } catch {}
}

export function isTargetLearned() {
  return !!fulfillment?.url;
}

/** Read Target's fulfillment JSON. Exported for tests. */
export function parseTargetFulfillment(body) {
  const ship = body.indexOf('"shipping_options"');
  const seg = ship >= 0 ? body.slice(ship, ship + 3000) : body;
  const m = seg.match(/"availability_status"\s*:\s*"([A-Z_]+)"/);
  if (!m) return null;
  const status = /^(IN_STOCK|LIMITED_STOCK|PRE_ORDER_SELLABLE)$/.test(m[1]) ? 'in_stock' : 'oos';
  return { status, signal: `target-api:${m[1]}` };
}

const ATC = [
  'button[data-test="shippingButton"]',
  'button[data-test="shipItButton"]',
  { role: 'button', name: /^ship it$/i },
  { role: 'button', name: /^add to cart$/i },
];
const PLACE_ORDER = [
  'button[data-test="placeOrderButton"]',
  { role: 'button', name: /^place (your )?order$/i },
];
const CVV = [
  'input#creditCardInput-cvv',
  '[data-test="credit-card-cvv-input"] input',
  'input[name="cvv"]',
  'input[autocomplete="cc-csc"]',
];

export default defineRetailer({
  id: 'target',
  name: 'Target',
  loginUrl: 'https://www.target.com/account',
  accountUrl: 'https://www.target.com/account',
  cvvEnv: 'TARGET_CVV',
  cartUrl: 'https://www.target.com/cart',
  loggedOutUrl: /\/login|\/signin|login\?/i,
  confirmUrl: /order-confirmation|thankyou|thank-you/i,
  confirmText: /thanks for your order|order (number|#)\s*:?\s*\d/i,

  productUrl: (p) => `https://www.target.com/p/-/A-${p.tcin}`,

  // Full checks: find the data response that carries this product's stock status
  // and remember the request behind it, so light checks can reuse it.
  watchCheck(page, product) {
    const tcin = String(product.tcin);
    targetDebug.seen = [];
    const onResponse = async (res) => {
      const req = res.request();
      const type = req.resourceType();
      if (type !== 'fetch' && type !== 'xhr') return;
      let host;
      try { host = new URL(req.url()).host; } catch { return; }
      if (!/(^|\.)target\.com$/.test(host)) return;
      const entry = {
        method: req.method(), where: `${host}${new URL(req.url()).pathname}`, status: res.status(),
        tcin: req.url().includes(tcin) ? 'url' : (req.postData() || '').includes(tcin) ? 'body' : '-', stock: false,
      };
      targetDebug.seen.push(entry);
      if (res.status() !== 200) return;
      const ct = res.headers()['content-type'] || '';
      if (!/json/i.test(ct)) return;
      let text;
      try { text = await res.text(); } catch { return; }
      if (!/"availability_status"\s*:/.test(text)) return;
      entry.stock = true;
      learnFulfillment(req, tcin);
    };
    page.on('response', onResponse);
    return () => page.off('response', onResponse);
  },

  // Full check = the shared page check, plus (until learned) a few extra seconds
  // for the stock-data request to arrive.
  async check(page, product, ctx) {
    const stop = this.watchCheck(page, product);
    try {
      const res = await this.checkPage(page, product, ctx);
      if (!isTargetLearned()) await waitUntilLearned(10_000);
      return res;
    } finally {
      stop();
    }
  },

  async liteCheck(fetchLite, product) {
    if (!fulfillment?.url) {
      // Not learned yet — skip the 330 KB page (it has no stock info); the next full check learns it.
      return { status: 'unknown', signal: 'target-api-not-learned-yet', learning: true };
    }
    const tcin = String(product.tcin);
    const fill = (t) => (t == null ? undefined : t.split('{TCIN}').join(tcin));
    const r = await fetchLite(fill(fulfillment.url), {
      method: fulfillment.method, body: fill(fulfillment.body), headers: fulfillment.headers,
      accept: fulfillment.headers?.accept || 'application/json', referer: this.productUrl(product),
    });
    if (r.status === 401 || r.status === 403 || r.status === 410) {
      forgetFulfillment(); // key/params expired — re-learn on the next full check
      return { status: 'unknown', signal: `target-api-http-${r.status}`, learning: true };
    }
    if (r.status !== 200) return { status: 'unknown', signal: `target-api-http-${r.status}` };
    return parseTargetFulfillment(r.body || '') || { status: 'unknown', signal: 'target-api-no-status' };
  },
  searchUrl: (q) => `https://www.target.com/s?searchTerm=${encodeURIComponent(q)}`,
  listingRe: /target\.com\/p\/[^?#]*?\/-\/A-(\d+)/,
  toProduct: (l) => ({ retailer: 'target', tcin: l.id }),

  sel: {
    atc: ATC,
    oos: /\b(sold out|out of stock|notify me when it's back)\b/i,
    price: ['[data-test="product-price"]'],
    placeOrder: PLACE_ORDER,
    cvv: CVV,
  },

  async addToCart(page, product, ctx) {
    await page.goto(this.productUrl(product), { waitUntil: 'domcontentloaded', timeout: ctx.timeout * 2 });
    await waitOutQueue(page, { minutes: ctx.settings.queue_wait_minutes, log: ctx.log, onEnter: ctx.onQueueEnter, onExit: ctx.onQueueExit });
    await trySolveCaptcha(page, ctx.log);
    const state = await waitForAny(page, {
      atc: async () => !!(await findFirst(page, ATC, { timeout: 1 })),
      oos: () => textMatches(page, /\b(sold out|out of stock|notify me when it's back)\b/i),
    }, { timeout: ctx.timeout });
    if (state !== 'atc') throw new CheckoutError('unavailable', state === 'oos' ? 'sold out on page' : 'no add-to-cart button');

    await clickFirst(page, ATC, { timeout: 3000, step: 'add to cart' });
    const added = await waitForAny(page, {
      ok: () => textMatches(page, /added to cart|view cart & check out|view cart and check out/i),
      limit: () => textMatches(page, /(purchase limit|limit \d+ per|quantity limit)/i),
      oos: () => textMatches(page, /out of stock|no longer available/i),
    }, { timeout: ctx.timeout });
    if (added === 'limit') throw new CheckoutError('step_failed', 'Target purchase limit reached (item may already be in cart)');
    if (added === 'oos') throw new CheckoutError('unavailable', 'went out of stock while adding to cart');
    if (!added) ctx.log('no add-to-cart confirmation seen — continuing to checkout anyway');
  },

  async toReview(page, product, ctx) {
    await page.goto('https://www.target.com/checkout', { waitUntil: 'domcontentloaded', timeout: ctx.timeout * 2 });
    await page.waitForTimeout(1500);
    if (this.loggedOutUrl.test(page.url())) throw new CheckoutError('not_logged_in', 'Target session expired — run `npm run login -- target`');
    if (await textMatches(page, /your cart is empty/i)) throw new CheckoutError('step_failed', 'cart is empty at checkout');

    // Target sometimes asks to re-confirm the card number for a new address.
    if (await textMatches(page, /confirm (your )?card number/i)) {
      throw new CheckoutError('step_failed', 'Target wants the full card number re-entered — finish this one by hand');
    }

    if (await fillIfPresent(page, CVV, ctx.cvv, { timeout: 3000 })) {
      ctx.log('entered CVV');
      await clickFirst(page, [{ role: 'button', name: /^(save and continue|continue|confirm)$/i }], { timeout: 2000, step: 'confirm CVV' }).catch(() => {});
    } else if (await findFirst(page, CVV, { timeout: 500, requireEnabled: false })) {
      throw new CheckoutError('step_failed', 'Target is asking for CVV — set TARGET_CVV in .env');
    }

    const btn = await findFirst(page, PLACE_ORDER, { timeout: ctx.timeout });
    if (!btn) throw new CheckoutError('step_failed', 'Place order button not found / not enabled on checkout page');
    return btn;
  },

  async confirm(page, ctx) {
    const res = await waitForAny(page, {
      ok: () => this.isConfirmed(page),
      declined: () => textMatches(page, /payment (was )?declined|couldn't process your payment|problem with your payment/i),
      oos: () => textMatches(page, /no longer available|out of stock/i),
    }, { timeout: ctx.timeout * 3 });
    if (res === 'ok') {
      const m = (await bodyText(page)).match(/order\s*(?:number|#)\s*:?\s*([\d-]{6,})/i);
      return { order_number: m?.[1] || null };
    }
    if (res === 'declined') throw new CheckoutError('step_failed', 'payment declined');
    if (res === 'oos') throw new CheckoutError('unavailable', 'item went out of stock at place-order');
    throw new CheckoutError('step_failed', 'no order confirmation after clicking Place order — CHECK YOUR TARGET ACCOUNT');
  },
});
