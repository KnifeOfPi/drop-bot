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
// Optional proxy via CHECKOUT_PROXY=http://user:pass@host:port

import { chromium } from 'playwright-core';
import { mkdirSync } from 'fs';
import { homedir } from 'os';
import { join, resolve } from 'path';

// Test hook: lets the offline test suite route retailer URLs to mock pages.
export const hooks = { onContext: null };

export function profileDirFor(retailer, settings) {
  const base = String(settings.profile_dir || '~/.drop-bot/profiles').replace(/^~(?=$|\/)/, homedir());
  const dir = resolve(base, retailer);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function proxyFromEnv() {
  const raw = process.env.CHECKOUT_PROXY;
  if (!raw) return undefined;
  try {
    const u = new URL(raw);
    return {
      server: `${u.protocol}//${u.host}`,
      username: decodeURIComponent(u.username) || undefined,
      password: decodeURIComponent(u.password) || undefined,
    };
  } catch {
    return { server: raw };
  }
}

export async function launchProfile(retailer, settings, { headless } = {}) {
  const userDataDir = profileDirFor(retailer, settings);
  const base = {
    headless: headless ?? !!settings.headless,
    viewport: null,
    proxy: proxyFromEnv(),
    args: ['--disable-blink-features=AutomationControlled', '--start-maximized'],
    ignoreDefaultArgs: ['--enable-automation'],
  };

  const attempts = [];
  if (process.env.CHECKOUT_BROWSER_PATH) attempts.push({ ...base, executablePath: process.env.CHECKOUT_BROWSER_PATH });
  attempts.push({ ...base, channel: 'chrome' });
  attempts.push(base);

  let lastErr;
  for (const opts of attempts) {
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

