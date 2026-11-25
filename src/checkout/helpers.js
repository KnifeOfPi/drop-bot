// Shared page helpers for checkout flows. Every selector list is tried in order;
// entries are either CSS selectors (string) or { role, name } / { text } objects.
// Retail sites change markup often — when a step fails, the failure screenshot
// in data/screenshots/ shows what the page looked like.

import { join } from 'path';
import { SCREENSHOT_DIR } from './ledger.js';

export class CheckoutError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code; // not_logged_in | unavailable | step_failed | guard | captcha | queue_timeout
  }
}

function toLocator(page, c) {
  if (typeof c === 'string') return page.locator(c);
  const scope = c.within ? page.locator(c.within) : page;
  if (c.role) return scope.getByRole(c.role, { name: c.name });
  if (c.text) return page.getByText(c.text);
  throw new Error(`bad candidate ${JSON.stringify(c)}`);
}

async function firstUsable(page, candidates, { requireEnabled = true } = {}) {
  for (const c of candidates) {
    const loc = toLocator(page, c);
    const count = await loc.count().catch(() => 0);
    for (let i = 0; i < Math.min(count, 5); i++) {
      const el = loc.nth(i);
      if (!(await el.isVisible().catch(() => false))) continue;
      if (requireEnabled && !(await el.isEnabled().catch(() => false))) continue;
      return el;
    }
  }
  return null;
}

/** Poll until one candidate is visible (+enabled). Returns the locator or null on timeout. */
export async function findFirst(page, candidates, { timeout = 10000, requireEnabled = true } = {}) {
  const deadline = Date.now() + timeout;
  do {
    const el = await firstUsable(page, candidates, { requireEnabled });
    if (el) return el;
    await page.waitForTimeout(250);
  } while (Date.now() < deadline);
  return null;
}

export async function clickFirst(page, candidates, { timeout = 10000, step = 'click' } = {}) {
  const el = await findFirst(page, candidates, { timeout });
  if (!el) throw new CheckoutError('step_failed', `${step}: no matching button found`);
  await el.scrollIntoViewIfNeeded().catch(() => {});
  await el.click();
  return el;
}

/** Fill the first visible input matching candidates. Returns true if filled. */
export async function fillIfPresent(page, candidates, value, { timeout = 2000 } = {}) {
  if (!value) return false;
  const el = await findFirst(page, candidates, { timeout });
  if (!el) return false;
  await el.fill('');
  await el.type(String(value), { delay: 40 });
  return true;
}

/**
 * Wait until one of several named conditions is true. `checks` is
 * { name: async () => boolean }. Returns the first name that matched, or null.
 */
export async function waitForAny(page, checks, { timeout = 10000 } = {}) {
  const deadline = Date.now() + timeout;
  do {
    for (const [name, fn] of Object.entries(checks)) {
      if (await fn().catch(() => false)) return name;
    }
    await page.waitForTimeout(250);
  } while (Date.now() < deadline);
  return null;
}

export async function bodyText(page) {
  return page.evaluate(() => document.body?.innerText || '').catch(() => '');
}

export async function textMatches(page, re) {
  return re.test(await bodyText(page));
}

export function parseMoney(v) {
  if (typeof v === 'number') return v;
  const m = String(v ?? '').replace(/,/g, '').match(/\$?\s*(\d+(?:\.\d{1,2})?)/);
  return m ? parseFloat(m[1]) : null;
}

/** Best-effort read of the order total on a review page. */
export async function readOrderTotal(page) {
  const text = await bodyText(page);
  const patterns = [
    /(?:order|estimated|grand)\s+total[^$\d]{0,40}\$\s?([\d,]+\.\d{2})/i,
    /\btotal[^$\d]{0,25}\$\s?([\d,]+\.\d{2})/i,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m) return parseFloat(m[1].replace(/,/g, ''));
  }
  return null;
}

// Queue-it, Akamai/PerimeterX waiting rooms, Walmart / Costco / Sam's virtual queues.
export const QUEUE_URL = /queue-it\.net|\.queue-it\.|waitingroom|waiting-room|\/queue(\/|\?|$)|virtual-?queue/i;
export const QUEUE_TEXT = /you are now in line|you('|’)re (now )?in (the )?(line|queue)|you are in (the )?(line|queue)|waiting room|estimated wait( time)?|your (place|number|position) in (line|the queue)|virtual queue|thank you for waiting|we('|’)ll get you (in|through) (shortly|soon)/i;

export async function inQueue(page) {
  if (QUEUE_URL.test(page.url())) return true;
  return textMatches(page, QUEUE_TEXT);
}

/**
 * Sit in a waiting room / queue until it lets us through.
 * onEnter / onExit fire once (used for "joined queue" / "through the queue" alerts).
 */
export async function waitOutQueue(page, { minutes = 30, log = () => {}, onEnter, onExit } = {}) {
  if (!(await inQueue(page))) return false;
  log(`in queue/waiting room — waiting up to ${minutes}m`);
  await onEnter?.();
  const deadline = Date.now() + minutes * 60_000;
  while (Date.now() < deadline) {
    await page.waitForTimeout(3000);
    if (!(await inQueue(page))) {
      log('through the queue');
      await page.waitForLoadState('domcontentloaded').catch(() => {});
      await onExit?.();
      return true;
    }
  }
  throw new CheckoutError('queue_timeout', `still in queue after ${minutes} minutes`);
}

export async function captchaPresent(page) {
  return page.evaluate(() => {
    // Only count captcha elements a person would actually see (pages often carry hidden ones).
    const visible = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el);
      return r.width > 20 && r.height > 20 && cs.visibility !== 'hidden' && cs.display !== 'none' && cs.opacity !== '0'; };
    const els = document.querySelectorAll('iframe[src*="captcha"], iframe[src*="datadome"], iframe[src*="hcaptcha"], [id*="px-captcha"], [id*="captcha"]');
    return [...els].some(visible) ||
      /verify you are (a )?human|press (&|and) hold|are you a robot|robot or human/i.test(document.body?.innerText || '');
  }).catch(() => false);
}

/** First visible price on the page. */
export async function readPrice(page, selectors = []) {
  for (const sel of selectors) {
    const t = await page.locator(sel).first().textContent({ timeout: 500 }).catch(() => null);
    const v = parseMoney(t);
    if (v != null) return `$${v.toFixed(2)}`;
  }
  const m = (await bodyText(page)).match(/\$\s?(\d{1,4}(?:,\d{3})*\.\d{2})/);
  return m ? `$${m[1].replace(/,/g, '')}` : 'N/A';
}

export async function readTitle(page) {
  const h1 = await page.locator('h1').first().textContent({ timeout: 500 }).catch(() => null);
  return (h1 || (await page.title().catch(() => '')) || '').trim().replace(/\s+/g, ' ').slice(0, 200);
}

/**
 * Click through a multi-step checkout ("Continue", "Review order", ...) entering
 * CVV where asked, until a Place order button is available. Returns that button.
 */
export async function walkCheckout(page, ctx, { placeOrder, cont, cvv = [], maxSteps = 7 }) {
  for (let stepNo = 0; stepNo < maxSteps; stepNo++) {
    await handOffIfCaptcha(page, ctx.log);
    if (cvv.length && await fillIfPresent(page, cvv, ctx.cvv, { timeout: 1000 })) ctx.log('entered CVV');
    const place = await findFirst(page, placeOrder, { timeout: 2500 });
    if (place) return place;
    const next = await findFirst(page, cont, { timeout: ctx.timeout });
    if (!next) break;
    ctx.log(`checkout step ${stepNo + 1}: "${(await next.innerText().catch(() => '')).trim()}"`);
    await next.click();
    await page.waitForTimeout(1500);
  }
  if (cvv.length && !ctx.cvv && await findFirst(page, cvv, { timeout: 500, requireEnabled: false })) {
    throw new CheckoutError('step_failed', 'checkout is asking for a CVV — add it to .env');
  }
  throw new CheckoutError('step_failed', 'could not reach the Place order step');
}

/**
 * Collect product links from a search/listing page. `linkRe` must capture the
 * product id in group 1. Returns [{ id, title, url, price }].
 */
export async function collectListings(page, linkRe) {
  return page.evaluate(({ source, flags }) => {
    const re = new RegExp(source, flags);
    const out = new Map();
    for (const a of document.querySelectorAll('a[href]')) {
      const href = a.href;
      const m = href.match(re);
      if (!m) continue;
      const id = m[1];
      let title = (a.getAttribute('aria-label') || a.title || a.innerText || '').trim().replace(/\s+/g, ' ');
      if (!title) title = a.querySelector('img[alt]')?.getAttribute('alt')?.trim() || '';
      let price = null;
      let el = a;
      for (let i = 0; i < 6 && el && !price; i++, el = el.parentElement) {
        const t = el.innerText || '';
        if (t.length > 600) break;
        const pm = t.match(/\$\s?(\d{1,4}(?:,\d{3})*\.\d{2})/);
        if (pm) price = `$${pm[1].replace(/,/g, '')}`;
      }
      const prev = out.get(id);
      if (!prev || title.length > prev.title.length) {
        out.set(id, { id, title, url: href.split('#')[0], price: price || prev?.price || null });
      }
    }
    return [...out.values()].filter(x => x.title);
  }, { source: linkRe.source, flags: linkRe.flags });
}

/**
 * A captcha / bot check is in the way: stop and hand the tab to a person (Live view).
 * The bot never tries to solve or get around a store's bot checks itself.
 */
export async function handOffIfCaptcha(page, log = () => {}) {
  if (!(await captchaPresent(page))) return false;
  log('bot check on the page — handing off to you (Live view)');
  throw new CheckoutError('captcha', 'the store showed a bot check — finish it in Live view');
}

export async function screenshot(page, name) {
  const file = join(SCREENSHOT_DIR, `${Date.now()}-${name.replace(/[^a-z0-9_-]+/gi, '_')}.png`);
  try {
    await page.screenshot({ path: file, fullPage: false });
    return file;
  } catch {
    return null;
  }
}
