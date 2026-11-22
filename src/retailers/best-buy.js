// Best Buy. Drops (with the "Please Wait..." add-to-cart queue) and occasional
// drawings. Requires a logged-in profile with saved address + card. Best Buy
// usually asks for CVV — BESTBUY_CVV in .env.

import { defineRetailer } from './base.js';
import { CheckoutError, clickFirst, findFirst, fillIfPresent, waitForAny, textMatches, bodyText, trySolveCaptcha } from '../checkout/helpers.js';

const ATC = [
  'button.add-to-cart-button[data-button-state="ADD_TO_CART"]',
  'button[data-button-state="ADD_TO_CART"]',
  'button.add-to-cart-button',
  { role: 'button', name: /^add to cart$/i },
];
const UNAVAILABLE = '[data-button-state="SOLD_OUT"], [data-button-state="COMING_SOON"], [data-button-state="CHECK_STORES"]';
const PLACE_ORDER = [
  'button.button__fast-track',
  'button[data-track="Place your Order - Contact Card"]',
  { role: 'button', name: /^place (your )?order$/i },
];
const CVV = ['input#cvv', 'input#credit-card-cvv', 'input[name="cvv"]', 'input[autocomplete="cc-csc"]'];

export default defineRetailer({
  id: 'best-buy',
  name: 'Best Buy',
  loginUrl: 'https://www.bestbuy.com/identity/global/signin',
  accountUrl: 'https://www.bestbuy.com/site/customer/myaccount',
  cvvEnv: 'BESTBUY_CVV',
  cartUrl: 'https://www.bestbuy.com/cart',
  loggedOutUrl: /\/identity\/signin|\/signin/i,
  confirmUrl: /thank-you|thankyou|order-confirmation/i,
  confirmText: /thank you for your order|order number/i,

  productUrl: (p) => `https://www.bestbuy.com/site/${p.sku}.p?skuId=${p.sku}`,
  searchUrl: (q) => `https://www.bestbuy.com/site/searchpage.jsp?st=${encodeURIComponent(q)}`,
  listingRe: /bestbuy\.com\/site\/[^?#]*?\/(\d{6,8})\.p/,
  toProduct: (l) => ({ retailer: 'best-buy', sku: l.id }),

  sel: {
    atc: ATC,
    unavailable: UNAVAILABLE,
    oos: /\bsold out\b|coming soon/i,
    price: ['[data-testid="customer-price"] span', '.priceView-customer-price span'],
    // Best Buy drawings: "Enter for a chance to buy" style buttons (often in the app too).
    drawing: [
      { role: 'button', name: /enter (the )?drawing|enter for a chance|join (the )?drawing|request (an )?invite/i },
      'button[data-button-state="ENTER_DRAWING"]',
    ],
    placeOrder: PLACE_ORDER,
    cvv: CVV,
  },

  // Light check: Best Buy's own price/availability data — a few KB instead of a full page.
  async liteCheck(fetchLite, product) {
    const r = await fetchLite(`https://www.bestbuy.com/api/3.0/priceBlocks?skus=${encodeURIComponent(product.sku)}`, {
      accept: 'application/json', referer: 'https://www.bestbuy.com/',
    });
    if (r.status !== 200) return null; // fall back to the HTML light check
    let data;
    try { data = JSON.parse(r.body); } catch { return null; }
    const s = (Array.isArray(data) ? data[0] : data)?.sku;
    const state = s?.buttonState?.buttonState || s?.buttonState;
    if (typeof state !== 'string') return null;
    const price = s.currentPrice ?? s.regularPrice;
    const status = /^(ADD_TO_CART|PRE_ORDER)$/.test(state) ? 'in_stock' : /DRAW|INVITE/.test(state) ? 'maybe' : 'oos';
    return { status, signal: `bestbuy-api:${state}`, price: price != null ? `$${Number(price).toFixed(2)}` : null };
  },

  async addToCart(page, product, ctx) {
    await page.goto(this.productUrl(product), { waitUntil: 'domcontentloaded', timeout: ctx.timeout * 2 });
    await trySolveCaptcha(page, ctx.log);
    const state = await waitForAny(page, {
      atc: async () => !!(await findFirst(page, ATC, { timeout: 1 })),
      oos: async () => (await page.locator(UNAVAILABLE).count()) > 0 || await textMatches(page, /\bsold out\b|coming soon/i),
    }, { timeout: ctx.timeout });
    if (state !== 'atc') throw new CheckoutError('unavailable', state === 'oos' ? 'sold out / coming soon' : 'no add-to-cart button');

    await clickFirst(page, ATC, { timeout: 3000, step: 'add to cart' });

    // Hot drops: button flips to "Please Wait..." then back to "Add to Cart" when it's your turn.
    let announced = false;
    const deadline = Date.now() + ctx.settings.queue_wait_minutes * 60_000;
    while (Date.now() < deadline) {
      const res = await waitForAny(page, {
        added: () => textMatches(page, /added to cart|go to cart|1 item in cart/i),
        wait: () => textMatches(page, /please wait/i),
        oos: async () => (await page.locator(UNAVAILABLE).count()) > 0,
      }, { timeout: ctx.timeout });
      if (res === 'added') {
        if (announced) await ctx.onQueueExit?.();
        return;
      }
      if (res === 'oos') throw new CheckoutError('unavailable', 'sold out while adding to cart');
      if (res === 'wait') {
        ctx.log('Best Buy queue ("Please Wait") — waiting for button to unlock');
        if (!announced) { announced = true; await ctx.onQueueEnter?.(); }
        const btn = await findFirst(page, ['button[data-button-state="ADD_TO_CART"]:not([disabled])'], { timeout: 10 * 60_000 });
        if (btn) await btn.click();
        continue;
      }
      ctx.log('no add-to-cart confirmation seen — continuing to checkout anyway');
      return;
    }
    throw new CheckoutError('queue_timeout', 'Best Buy queue did not release in time');
  },

  async toReview(page, product, ctx) {
    await page.goto('https://www.bestbuy.com/checkout/r/fast-track', { waitUntil: 'domcontentloaded', timeout: ctx.timeout * 2 });
    await page.waitForTimeout(1500);
    if (this.loggedOutUrl.test(page.url())) throw new CheckoutError('not_logged_in', 'Best Buy session expired — run `npm run login -- best-buy`');
    if (await textMatches(page, /verify your account|enter your password to continue/i)) {
      throw new CheckoutError('not_logged_in', 'Best Buy wants the password re-entered');
    }
    if (await textMatches(page, /your cart is empty/i)) throw new CheckoutError('step_failed', 'cart is empty at checkout');

    if (await fillIfPresent(page, CVV, ctx.cvv, { timeout: 3000 })) ctx.log('entered CVV');
    else if (await findFirst(page, CVV, { timeout: 500, requireEnabled: false })) {
      throw new CheckoutError('step_failed', 'Best Buy is asking for CVV — set BESTBUY_CVV in .env');
    }

    const btn = await findFirst(page, PLACE_ORDER, { timeout: ctx.timeout });
    if (!btn) throw new CheckoutError('step_failed', 'Place order button not found / not enabled');
    return btn;
  },

  async confirm(page, ctx) {
    const res = await waitForAny(page, {
      ok: () => this.isConfirmed(page),
      declined: () => textMatches(page, /payment (was )?declined|unable to process your payment|card was declined/i),
      oos: () => textMatches(page, /no longer available|sold out/i),
    }, { timeout: ctx.timeout * 3 });
    if (res === 'ok') {
      const m = (await bodyText(page)).match(/order\s*(?:number|#)\s*:?\s*(BBY[\w-]+|[\d-]{6,})/i);
      return { order_number: m?.[1] || null };
    }
    if (res === 'declined') throw new CheckoutError('step_failed', 'payment declined');
    if (res === 'oos') throw new CheckoutError('unavailable', 'sold out at place-order');
    throw new CheckoutError('step_failed', 'no order confirmation after clicking Place order — CHECK YOUR BEST BUY ACCOUNT');
  },
});
