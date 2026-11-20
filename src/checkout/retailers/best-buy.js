// Best Buy checkout flow. Requires: logged-in profile with saved address and
// card. Best Buy usually asks for CVV — set BESTBUY_CVV in .env.
// Handles the hot-drop "Please Wait..." queue on the add-to-cart button.

import { CheckoutError, clickFirst, findFirst, fillIfPresent, waitForAny, textMatches, bodyText } from '../helpers.js';

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

const loggedOut = (page) => /\/identity\/signin|\/signin/i.test(page.url());

export default {
  id: 'best-buy',
  loginUrl: 'https://www.bestbuy.com/identity/global/signin',
  cvvEnv: 'BESTBUY_CVV',

  productUrl: (p) => `https://www.bestbuy.com/site/${p.sku}.p?skuId=${p.sku}`,

  async addToCart(page, product, ctx) {
    await page.goto(this.productUrl(product), { waitUntil: 'domcontentloaded', timeout: ctx.timeout * 2 });
    const state = await waitForAny(page, {
      atc: async () => !!(await findFirst(page, ATC, { timeout: 1 })),
      oos: async () => (await page.locator(UNAVAILABLE).count()) > 0 || await textMatches(page, /\bsold out\b|coming soon/i),
    }, { timeout: ctx.timeout });
    if (state !== 'atc') throw new CheckoutError('unavailable', state === 'oos' ? 'sold out / coming soon' : 'no add-to-cart button');

    await clickFirst(page, ATC, { timeout: 3000, step: 'add to cart' });

    // Hot drops: button flips to "Please Wait..." then back to "Add to Cart" when it's your turn.
    const deadline = Date.now() + ctx.settings.queue_wait_minutes * 60_000;
    while (Date.now() < deadline) {
      const res = await waitForAny(page, {
        added: () => textMatches(page, /added to cart|go to cart|1 item in cart/i),
        wait: () => textMatches(page, /please wait/i),
        oos: async () => (await page.locator(UNAVAILABLE).count()) > 0,
      }, { timeout: ctx.timeout });
      if (res === 'added') return;
      if (res === 'oos') throw new CheckoutError('unavailable', 'sold out while adding to cart');
      if (res === 'wait') {
        ctx.log('Best Buy queue ("Please Wait") — waiting for button to unlock');
        const btn = await findFirst(page, ['button[data-button-state="ADD_TO_CART"]:not([disabled])'], { timeout: 10 * 60_000 });
        if (btn) { await btn.click(); continue; }
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
    if (loggedOut(page)) throw new CheckoutError('not_logged_in', 'Best Buy session expired — run `npm run login -- best-buy`');
    if (await textMatches(page, /verify your account|enter your password to continue/i)) {
      throw new CheckoutError('not_logged_in', 'Best Buy wants the password re-entered — run `npm run login -- best-buy`');
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
      ok: async () => /thank-you|thankyou|order-confirmation/i.test(page.url()) || await textMatches(page, /thank you for your order|order number/i),
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
};
