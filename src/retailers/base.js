// Retailer adapter base. Each retailer file supplies selectors / URLs (and may
// override any step); this file provides the generic implementations:
//
//   check(page, product, ctx)        → { status, price, title }
//        status: in_stock | oos | queue | drawing_open | drawing_entered | blocked | unknown
//   enterDrawing(page, product, ctx) → { entered: true } | { already: true }
//   addToCart / toReview / confirm   → checkout steps (see checkout/index.js)
//   isConfirmed(page)                → true when on an order-confirmation page
//   search(page, query, ctx)         → [{ id, title, url, price }]
//
// Selectors are best-effort and WILL drift as sites change. Failures save a
// screenshot to data/screenshots/ so the broken step is easy to spot.

import {
  CheckoutError, clickFirst, findFirst, waitForAny, textMatches, bodyText,
  inQueue, captchaPresent, waitOutQueue, handOffIfCaptcha, walkCheckout,
  readPrice, readTitle, collectListings,
} from '../checkout/helpers.js';

// Generic patterns shared by most retailers.
export const COMMON = {
  drawing: [
    { role: 'button', name: /enter (the |this )?(drawing|raffle|sweepstakes)|enter for (a|the) chance|enter to win|join (the )?(drawing|raffle)|request (an )?invite/i },
    { role: 'link', name: /enter (the |this )?(drawing|raffle)|enter for (a|the) chance|enter to win/i },
  ],
  // Confirm step after clicking the drawing button: prefer buttons inside the
  // dialog; the page-wide fallback excludes "Enter drawing" so we never just
  // re-click the original button.
  drawingConfirm: [
    { within: '[role="dialog"], [aria-modal="true"]', role: 'button', name: /^(enter( (the )?drawing| now)?|submit( entry)?|confirm( entry)?|continue|i agree|agree (and|&) (enter|continue))$/i },
    { role: 'button', name: /^(enter|enter now|submit( entry)?|confirm( entry)?|i agree|agree (and|&) (enter|continue))$/i },
  ],
  drawingEntered: /you('|’)re entered|you are entered|you('|’)ve (been )?entered|entry (received|confirmed|submitted)|thanks for entering|you('|’)re in the drawing|already entered/i,
  cont: [
    { role: 'button', name: /^(save (and|&) )?continue( to (payment|review|shipping|checkout|delivery))?$/i },
    { role: 'button', name: /^review (your )?order$/i },
    { role: 'button', name: /^next$/i },
  ],
  placeOrder: [{ role: 'button', name: /^(place|submit|complete) (your |my )?order$/i }],
  cvv: ['input[name*="cvv" i]', 'input[id*="cvv" i]', 'input[autocomplete="cc-csc"]', 'input[name*="securityCode" i]', 'input[id*="securityCode" i]'],
  added: /added to (your )?cart|item(s)? added|view cart|go to cart|in your cart/i,
  limit: /purchase limit|limit (of )?\d+ per|quantity limit|maximum quantity|limit \d+/i,
  declined: /payment (was )?declined|card was declined|couldn('|’)t process your payment|unable to process (your )?payment|problem with your payment/i,
  orderNumber: /order\s*(?:number|#|no\.?)\s*:?\s*([A-Z0-9-]{6,})/i,
};

async function gotoProduct(r, page, product, ctx) {
  await page.goto(r.productUrl(product), { waitUntil: 'domcontentloaded', timeout: ctx.timeout * 3 });
  await page.waitForTimeout(1200);
}

export function defineRetailer(spec) {
  const s = { ...COMMON, ...spec.sel };
  const r = {
    loggedOutUrl: /\/login|\/signin|\/sign-in|logonform/i,
    confirmUrl: /order-confirmation|thank-?you|confirmation|order-complete/i,
    confirmText: /thank you for your order|thanks for your order|order (has been )?placed|order (number|#)\s*:?\s*[A-Z0-9]/i,
    ...spec,
    sel: s,
  };

  r.check ??= async function (page, product, ctx) {
    // Optional per-store hook: watch the requests the page makes during a full check.
    const stop = this.watchCheck?.(page, product);
    try {
      return await this.checkPage(page, product, ctx);
    } finally {
      stop?.();
    }
  };

  r.checkPage ??= async function (page, product, ctx) {
    await gotoProduct(this, page, product, ctx);
    if (await inQueue(page)) return { status: 'queue', price: 'N/A', title: product.label };
    if (await captchaPresent(page)) return { status: 'blocked', price: 'N/A', title: product.label, error: 'captcha on product page' };
    const status = await waitForAny(page, {
      drawing_entered: () => textMatches(page, s.drawingEntered),
      drawing_open: async () => !!(await findFirst(page, s.drawing, { timeout: 1 })),
      in_stock: async () => !!(await findFirst(page, s.atc, { timeout: 1 })),
      oos: async () => (s.unavailable && (await page.locator(s.unavailable).count()) > 0) || await textMatches(page, s.oos),
    }, { timeout: Math.min(ctx.timeout, 8000) }) || 'unknown';
    return { status, price: await readPrice(page, s.price || []), title: await readTitle(page) || product.label };
  };

  r.enterDrawing ??= async function (page, product, ctx) {
    await gotoProduct(this, page, product, ctx);
    await waitOutQueue(page, { minutes: ctx.settings.queue_wait_minutes, log: ctx.log });
    await handOffIfCaptcha(page, ctx.log);
    if (await textMatches(page, s.drawingEntered)) return { already: true };
    if (this.loggedOutUrl.test(page.url())) throw new CheckoutError('not_logged_in', `${this.name} session expired — run \`npm run login -- ${this.id}\``);
    const btn = await findFirst(page, s.drawing, { timeout: ctx.timeout });
    if (!btn) throw new CheckoutError('unavailable', 'no drawing entry button on the page');
    await btn.click();
    for (let i = 0; i < 4; i++) {
      await page.waitForTimeout(1500);
      if (await textMatches(page, s.drawingEntered)) return { entered: true };
      if (this.loggedOutUrl.test(page.url())) throw new CheckoutError('not_logged_in', `${this.name} wants you to sign in to enter`);
      const confirm = await findFirst(page, s.drawingConfirm, { timeout: 2000 });
      if (confirm) await confirm.click();
    }
    if (await textMatches(page, s.drawingEntered)) return { entered: true };
    throw new CheckoutError('step_failed', 'clicked the drawing button but never saw an entry confirmation');
  };

  r.addToCart ??= async function (page, product, ctx) {
    await gotoProduct(this, page, product, ctx);
    await waitOutQueue(page, { minutes: ctx.settings.queue_wait_minutes, log: ctx.log, onEnter: ctx.onQueueEnter, onExit: ctx.onQueueExit });
    await handOffIfCaptcha(page, ctx.log);
    const state = await waitForAny(page, {
      atc: async () => !!(await findFirst(page, s.atc, { timeout: 1 })),
      oos: async () => (s.unavailable && (await page.locator(s.unavailable).count()) > 0) || await textMatches(page, s.oos),
    }, { timeout: ctx.timeout });
    if (state !== 'atc') throw new CheckoutError('unavailable', state === 'oos' ? 'sold out on page' : 'no add-to-cart button');
    await clickFirst(page, s.atc, { timeout: 3000, step: 'add to cart' });
    // Some sites drop you into a queue right at add-to-cart.
    await page.waitForTimeout(800);
    await waitOutQueue(page, { minutes: ctx.settings.queue_wait_minutes, log: ctx.log, onEnter: ctx.onQueueEnter, onExit: ctx.onQueueExit });
    const added = await waitForAny(page, {
      ok: () => textMatches(page, s.added),
      limit: () => textMatches(page, s.limit),
      oos: () => textMatches(page, /out of stock|no longer available|sold out/i),
    }, { timeout: ctx.timeout });
    if (added === 'limit') throw new CheckoutError('step_failed', `${this.name} quantity limit hit (item may already be in cart)`);
    if (added === 'oos') throw new CheckoutError('unavailable', 'went out of stock while adding to cart');
    if (!added) ctx.log('no add-to-cart confirmation seen — continuing to checkout anyway');
  };

  r.toReview ??= async function (page, product, ctx) {
    await page.goto(this.cartUrl, { waitUntil: 'domcontentloaded', timeout: ctx.timeout * 3 });
    await page.waitForTimeout(1200);
    await waitOutQueue(page, { minutes: ctx.settings.queue_wait_minutes, log: ctx.log, onEnter: ctx.onQueueEnter, onExit: ctx.onQueueExit });
    await handOffIfCaptcha(page, ctx.log);
    if (this.loggedOutUrl.test(page.url())) throw new CheckoutError('not_logged_in', `${this.name} session expired — run \`npm run login -- ${this.id}\``);
    if (await textMatches(page, /your (shopping )?cart is empty|cart is empty/i)) throw new CheckoutError('step_failed', 'cart is empty');
    await clickFirst(page, s.checkout, { timeout: ctx.timeout, step: 'checkout' });
    await page.waitForTimeout(2000);
    if (this.loggedOutUrl.test(page.url())) throw new CheckoutError('not_logged_in', `${this.name} session expired — run \`npm run login -- ${this.id}\``);
    return walkCheckout(page, ctx, { placeOrder: s.placeOrder, cont: s.cont, cvv: s.cvv });
  };

  r.isConfirmed ??= async function (page) {
    return this.confirmUrl.test(page.url()) || await textMatches(page, this.confirmText);
  };

  r.confirm ??= async function (page, ctx) {
    const res = await waitForAny(page, {
      ok: () => this.isConfirmed(page),
      declined: () => textMatches(page, s.declined),
      oos: () => textMatches(page, /no longer available|out of stock|sold out/i),
    }, { timeout: ctx.timeout * 3 });
    if (res === 'ok') {
      const m = (await bodyText(page)).match(s.orderNumber);
      return { order_number: m?.[1] || null };
    }
    if (res === 'declined') throw new CheckoutError('step_failed', 'payment declined');
    if (res === 'oos') throw new CheckoutError('unavailable', 'went out of stock at place-order');
    throw new CheckoutError('step_failed', `no order confirmation after clicking Place order — CHECK YOUR ${this.name.toUpperCase()} ACCOUNT`);
  };

  /**
   * Best-effort sign-in check: open the account page; signed out if it bounces to
   * a login URL or shows a password field. Returns true | false | null (unknown).
   */
  r.checkLogin ??= async function (page, ctx) {
    await page.goto(this.accountUrl || this.loginUrl, { waitUntil: 'domcontentloaded', timeout: ctx.timeout * 3 });
    await page.waitForTimeout(2500);
    if (await inQueue(page) || await captchaPresent(page)) return null;
    if (this.loggedOutUrl.test(page.url())) return false;
    const pw = await page.locator('input[type="password"]').first().isVisible().catch(() => false);
    if (pw) return false;
    if (await textMatches(page, /\b(sign out|log out|logout)\b|\bhi,\s*\w+|my account|account overview|purchase history|order history/i)) return true;
    return null;
  };

  r.search ??= async function (page, query, ctx) {
    await page.goto(this.searchUrl(query), { waitUntil: 'domcontentloaded', timeout: ctx.timeout * 3 });
    await page.waitForTimeout(2500);
    if (await inQueue(page) || await captchaPresent(page)) return null; // can't search right now
    await page.mouse.wheel(0, 2500).catch(() => {});
    await page.waitForTimeout(1200);
    return collectListings(page, this.listingRe);
  };

  return r;
}
