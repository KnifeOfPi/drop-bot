// Shared page helpers for checkout flows. Every selector list is tried in order;
// entries are either CSS selectors (string) or { role, name } / { text } objects.
// Retail sites change markup often — when a step fails, the failure screenshot
// in data/screenshots/ shows what the page looked like.

import { join } from 'path';
import { homedir } from 'os';
import { SCREENSHOT_DIR } from './ledger.js';

export class CheckoutError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code; // not_logged_in | unavailable | step_failed | guard | captcha | queue_timeout
  }
}

function toLocator(page, c) {
  if (typeof c === 'string') return page.locator(c);
  if (c.role) return page.getByRole(c.role, { name: c.name });
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

/** Sit in a waiting room / queue until it lets us through. */
export async function waitOutQueue(page, { minutes = 30, log = () => {} } = {}) {
  const inQueue = async () => /queue-it|waitingroom|waiting-room/i.test(page.url()) ||
    await textMatches(page, /you are now in line|waiting room|you're in line|estimated wait time/i);
  if (!(await inQueue())) return false;
  log(`in queue/waiting room — waiting up to ${minutes}m`);
  const deadline = Date.now() + minutes * 60_000;
  while (Date.now() < deadline) {
    await page.waitForTimeout(5000);
    if (!(await inQueue())) { log('through the queue'); return true; }
  }
  throw new CheckoutError('queue_timeout', `still in queue after ${minutes} minutes`);
}

/** If the Hermes stealth lib is installed and exposes a captcha solver, try it. */
export async function trySolveCaptcha(page, log = () => {}) {
  const present = await page.evaluate(() =>
    !!document.querySelector('iframe[src*="captcha"], iframe[src*="datadome"], [id*="captcha"]') ||
    /verify you are human|press & hold|are you a robot/i.test(document.body?.innerText || '')
  ).catch(() => false);
  if (!present) return false;
  log('captcha detected — attempting solve');
  try {
    const lib = await import(join(homedir(), '.hermes/skills/web-automation/stealth-browser/scripts/lib.mjs'));
    if (typeof lib.solveCaptchaIfPresent === 'function') {
      await lib.solveCaptchaIfPresent(page);
      await page.waitForTimeout(2000);
      return true;
    }
  } catch (e) {
    log(`captcha solver unavailable: ${e.message.split('\n')[0]}`);
  }
  throw new CheckoutError('captcha', 'captcha blocked checkout and no solver succeeded');
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
