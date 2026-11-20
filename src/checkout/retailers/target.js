// Target checkout flow. Requires: logged-in profile with a default shipping
// address and saved card. Target often asks for the card CVV at checkout —
// set TARGET_CVV in .env.

import { CheckoutError, clickFirst, findFirst, fillIfPresent, waitForAny, textMatches, bodyText } from '../helpers.js';

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

const loggedOut = (page) => /\/login|\/signin|login\?/i.test(page.url());

export default {
  id: 'target',
  loginUrl: 'https://www.target.com/account',
  cvvEnv: 'TARGET_CVV',

  productUrl: (p) => `https://www.target.com/p/-/A-${p.tcin}`,

  async addToCart(page, product, ctx) {
    await page.goto(this.productUrl(product), { waitUntil: 'domcontentloaded', timeout: ctx.timeout * 2 });
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
    if (loggedOut(page)) throw new CheckoutError('not_logged_in', 'Target session expired — run `npm run login -- target`');
    if (await textMatches(page, /your cart is empty/i)) throw new CheckoutError('step_failed', 'cart is empty at checkout');

    // Target sometimes asks to re-confirm the card number for a new address.
    if (await textMatches(page, /confirm (your )?card number/i)) {
      throw new CheckoutError('step_failed', 'Target wants the full card number re-entered — complete one manual checkout in this profile first');
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
      ok: async () => /order-confirmation|thankyou|thank-you/i.test(page.url()) || await textMatches(page, /thanks for your order|order (number|#)\s*:?\s*\d/i),
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
};
