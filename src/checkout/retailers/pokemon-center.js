// Pokémon Center checkout flow. Requires: logged-in profile with saved address
// and card. Handles the waiting room and a multi-step checkout by clicking
// "continue"-style buttons until "Place order" appears. CVV via POKEMONCENTER_CVV.
// PC runs DataDome/Imperva — a residential CHECKOUT_PROXY and headed Chrome help.

import { CheckoutError, clickFirst, findFirst, fillIfPresent, waitForAny, textMatches, bodyText, waitOutQueue, trySolveCaptcha } from '../helpers.js';

const ATC = [
  '[data-testid="add-to-cart"]',
  'button[class*="add-to-cart"]',
  { role: 'button', name: /^add to cart$/i },
];
const CHECKOUT = [
  '[data-testid="checkout-button"]',
  { role: 'button', name: /^(secure )?checkout$/i },
  { role: 'link', name: /^(secure )?checkout$/i },
];
const CONTINUE = [
  { role: 'button', name: /^(save (and|&) )?continue( to (payment|review|shipping))?$/i },
  { role: 'button', name: /^review (your )?order$/i },
  { role: 'button', name: /^next$/i },
];
const PLACE_ORDER = [
  '[data-testid="place-order"]',
  { role: 'button', name: /^(place|submit) (your )?order$/i },
];
const CVV = ['input[name*="cvv" i]', 'input[id*="cvv" i]', 'input[autocomplete="cc-csc"]', 'input[name*="securityCode" i]'];

const loggedOut = (page) => /\/login|\/sign-in|\/account\/login/i.test(page.url());

export default {
  id: 'pokemon-center',
  loginUrl: 'https://www.pokemoncenter.com/account/login',
  cvvEnv: 'POKEMONCENTER_CVV',

  productUrl: (p) => p.url,

  async addToCart(page, product, ctx) {
    await page.goto(this.productUrl(product), { waitUntil: 'domcontentloaded', timeout: ctx.timeout * 3 });
    await waitOutQueue(page, { minutes: ctx.settings.queue_wait_minutes, log: ctx.log });
    await trySolveCaptcha(page, ctx.log);

    const state = await waitForAny(page, {
      atc: async () => !!(await findFirst(page, ATC, { timeout: 1 })),
      oos: () => textMatches(page, /\b(sold out|out of stock|currently unavailable)\b/i),
    }, { timeout: ctx.timeout });
    if (state !== 'atc') throw new CheckoutError('unavailable', state === 'oos' ? 'sold out on page' : 'no add-to-cart button');

    await clickFirst(page, ATC, { timeout: 3000, step: 'add to cart' });
    const added = await waitForAny(page, {
      ok: () => textMatches(page, /added to (your )?cart|view cart/i),
      limit: () => textMatches(page, /limit (of )?\d+|maximum quantity/i),
      oos: () => textMatches(page, /out of stock|no longer available/i),
    }, { timeout: ctx.timeout });
    if (added === 'limit') throw new CheckoutError('step_failed', 'Pokémon Center quantity limit hit (item may already be in cart)');
    if (added === 'oos') throw new CheckoutError('unavailable', 'went out of stock while adding to cart');
  },

  async toReview(page, product, ctx) {
    await page.goto('https://www.pokemoncenter.com/cart', { waitUntil: 'domcontentloaded', timeout: ctx.timeout * 3 });
    await waitOutQueue(page, { minutes: ctx.settings.queue_wait_minutes, log: ctx.log });
    await trySolveCaptcha(page, ctx.log);
    if (await textMatches(page, /your (shopping )?cart is empty/i)) throw new CheckoutError('step_failed', 'cart is empty');

    await clickFirst(page, CHECKOUT, { timeout: ctx.timeout, step: 'checkout' });
    await page.waitForTimeout(2000);
    if (loggedOut(page)) throw new CheckoutError('not_logged_in', 'Pokémon Center session expired — run `npm run login -- pokemon-center`');

    // Walk the multi-step checkout until Place Order is available.
    for (let stepNo = 0; stepNo < 6; stepNo++) {
      await trySolveCaptcha(page, ctx.log);
      if (await fillIfPresent(page, CVV, ctx.cvv, { timeout: 1000 })) ctx.log('entered CVV');
      const place = await findFirst(page, PLACE_ORDER, { timeout: 2500 });
      if (place) return place;
      const next = await findFirst(page, CONTINUE, { timeout: ctx.timeout });
      if (!next) break;
      ctx.log(`checkout step ${stepNo + 1}: "${(await next.innerText().catch(() => '')).trim()}"`);
      await next.click();
      await page.waitForTimeout(1500);
    }
    if (await findFirst(page, CVV, { timeout: 500, requireEnabled: false }) && !ctx.cvv) {
      throw new CheckoutError('step_failed', 'Pokémon Center is asking for CVV — set POKEMONCENTER_CVV in .env');
    }
    throw new CheckoutError('step_failed', 'could not reach the Place order step');
  },

  async confirm(page, ctx) {
    const res = await waitForAny(page, {
      ok: async () => /confirmation|thank-you|order-complete/i.test(page.url()) || await textMatches(page, /thank you for your order|order (number|#)/i),
      declined: () => textMatches(page, /payment (was )?declined|unable to process|card was declined/i),
      oos: () => textMatches(page, /no longer available|out of stock/i),
    }, { timeout: ctx.timeout * 3 });
    if (res === 'ok') {
      const m = (await bodyText(page)).match(/order\s*(?:number|#)\s*:?\s*([A-Z0-9-]{6,})/i);
      return { order_number: m?.[1] || null };
    }
    if (res === 'declined') throw new CheckoutError('step_failed', 'payment declined');
    if (res === 'oos') throw new CheckoutError('unavailable', 'went out of stock at place-order');
    throw new CheckoutError('step_failed', 'no order confirmation after clicking Place order — CHECK YOUR POKÉMON CENTER ACCOUNT');
  },
};
