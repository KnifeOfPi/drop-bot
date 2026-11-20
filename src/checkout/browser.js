// Persistent browser profiles for checkout.
//
// Each retailer gets its own Chrome user-data dir (default ~/.drop-bot/profiles/<retailer>).
// You log in ONCE by hand with `npm run login -- <retailer>`; cookies, saved
// address and saved card stay in that profile, so the bot never handles your
// password or 2FA.
//
// Browser resolution order:
//   1. CHECKOUT_BROWSER_PATH env (absolute path to a Chrome/Chromium binary)
//   2. Installed Google Chrome (playwright channel "chrome")  ← recommended
//   3. Playwright's bundled Chromium, if installed
//
// Proxy: set on the dashboard's Accounts page (or CHECKOUT_PROXY in .env), used for
// every store or only the ones listed in checkout.proxy_stores.

import { chromium } from 'playwright-core';
import { mkdirSync } from 'fs';
import { homedir } from 'os';
import { join, resolve } from 'path';
import { getProxyUrl } from '../accounts.js';

// Test hook: lets the offline test suite route retailer URLs to mock pages.
export const hooks = { onContext: null };

export function profileDirFor(retailer, settings) {
  // CHECKOUT_PROFILE_DIR (set in Docker) keeps logins on the persistent volume.
  const base = String(process.env.CHECKOUT_PROFILE_DIR || settings.profile_dir || '~/.drop-bot/profiles').replace(/^~(?=$|\/)/, homedir());
  const dir = resolve(base, retailer);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function parseProxy(raw) {
  if (!raw) return undefined;
  try {
    const u = new URL(raw.includes('://') ? raw : `http://${raw}`);
    return {
      server: `${u.protocol}//${u.host}`,
      username: decodeURIComponent(u.username) || undefined,
      password: decodeURIComponent(u.password) || undefined,
    };
  } catch {
    return { server: raw };
  }
}

/** Playwright proxy option for a store, or undefined (direct). */
export function proxyFor(retailer, settings) {
  const url = getProxyUrl();
  if (!url) return undefined;
  const stores = settings.proxy_stores;
  if (Array.isArray(stores) && !stores.includes(retailer)) return undefined;
  return parseProxy(url);
}

function chromeArgs() {
  return [
    '--disable-blink-features=AutomationControlled',
    '--start-maximized',
    // Containers / root on a VPS: Chrome's sandbox needs user namespaces it may not have.
    ...(process.env.CHROME_NO_SANDBOX || process.getuid?.() === 0 ? ['--no-sandbox'] : []),
    // Hosted containers often have a tiny /dev/shm; use /tmp instead so Chrome doesn't crash.
    ...(process.env.CHROME_NO_SANDBOX ? ['--disable-dev-shm-usage'] : []),
  ];
}

function launchAttempts(base) {
  const attempts = [];
  if (process.env.CHECKOUT_BROWSER_PATH) attempts.push({ ...base, executablePath: process.env.CHECKOUT_BROWSER_PATH });
  attempts.push({ ...base, channel: 'chrome' });
  attempts.push(base);
  return attempts;
}

/**
 * Public IP seen by a website — through the proxy (if given) — using the same
 * Chrome the bot uses. Used by the dashboard's "Test proxy" button.
 */
export async function publicIp(proxyUrl) {
  const base = { headless: true, proxy: parseProxy(proxyUrl), args: chromeArgs() };
  let lastErr;
  for (const opts of launchAttempts(base)) {
    let browser;
    try {
      browser = await chromium.launch(opts);
    } catch (e) { lastErr = e; continue; }
    try {
      const page = await browser.newPage();
      await page.goto('https://api.ipify.org?format=json', { timeout: 25000 });
      return JSON.parse(await page.locator('body').innerText()).ip;
    } finally {
      await browser.close().catch(() => {});
    }
  }
  throw lastErr || new Error('no browser');
}

export async function launchProfile(retailer, settings, { headless } = {}) {
  const userDataDir = profileDirFor(retailer, settings);
  const base = {
    headless: headless ?? !!settings.headless,
    viewport: null,
    proxy: proxyFor(retailer, settings),
    args: chromeArgs(),
    ignoreDefaultArgs: ['--enable-automation'],
  };

  let lastErr;
  for (const opts of launchAttempts(base)) {
    try {
      const context = await chromium.launchPersistentContext(userDataDir, opts);
      if (hooks.onContext) await hooks.onContext(context);
      const page = context.pages()[0] || await context.newPage();
      return { context, page, userDataDir };
    } catch (e) {
      lastErr = e;
      // Profile already open in another window is not a resolution problem — stop.
      if (/ProcessSingleton|profile.*in use|SingletonLock/i.test(e.message)) break;
    }
  }
  throw new Error(`Could not launch browser for ${retailer} profile (${userDataDir}): ${lastErr?.message?.split('\n')[0]}. ` +
    `Install Google Chrome or set CHECKOUT_BROWSER_PATH, and close any window already using this profile.`);
}

