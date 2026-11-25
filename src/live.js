// Live view — drive a bot browser tab from the dashboard (phone friendly):
// the dashboard polls a JPEG of the tab and forwards your taps / typing.
//
// Two kinds of live sessions:
//   handoff — the bot reached checkout (or got stuck) and handed it to you
//   login   — you're signing in to a store from the dashboard (Accounts page)

import { getHandoff } from './checkout/index.js';
import { newPage, closeSession, openSessions } from './session.js';
import { getAdapter } from './retailers/index.js';
import { markLogin } from './accounts.js';
import { loadConfigFresh, getCheckoutSettings } from './config.js';

const loginSessions = new Map(); // id -> { id, retailer, page, started, expires, timer }
const heldMouse = new Map();      // page -> auto-release timer while the mouse is held down
const heldSince = new Map();      // page -> when the current hold started (for the log)
const LOGIN_MINUTES = 15;

function sessionFor(id) {
  const h = getHandoff(id);
  if (h && !h.page.isClosed()) return { kind: 'handoff', retailer: h.retailer, page: h.page };
  const l = loginSessions.get(id);
  if (l && !l.page.isClosed()) return { kind: 'login', retailer: l.retailer, page: l.page };
  return null;
}

/** Open the store's sign-in page in its bot profile. Returns the live session id. */
export async function openLoginSession(retailer) {
  const adapter = getAdapter(retailer);
  if (!adapter) throw new Error('unknown store');
  for (const s of loginSessions.values()) {
    if (s.retailer === retailer && !s.page.isClosed()) return s.id; // reuse an open one
  }
  const page = await newPage(retailer);
  await page.goto(adapter.loginUrl, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
  const id = `login-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const s = { id, retailer, page, started: Date.now(), expires: Date.now() + LOGIN_MINUTES * 60_000 };
  s.timer = setTimeout(() => closeLoginSession(id, { check: true }), LOGIN_MINUTES * 60_000);
  page.on('close', () => { clearTimeout(s.timer); loginSessions.delete(id); });
  loginSessions.set(id, s);
  console.log(`[live] ${retailer}: sign-in session ${id} opened`);
  return id;
}

/** While paused, close a store's browser again once a one-off action is done. */
async function closeIfPaused(retailer) {
  if (!loadConfigFresh()?.paused) return;
  if ([...loginSessions.values()].some((l) => l.retailer === retailer && !l.page.isClosed())) return;
  if (openSessions().includes(retailer)) await closeSession(retailer);
}

/** Close a sign-in session and (optionally) re-check whether the store now looks signed in. */
export async function closeLoginSession(id, { check = true } = {}) {
  const s = loginSessions.get(id);
  if (!s) return null;
  loginSessions.delete(id);
  clearTimeout(s.timer);
  let result = null;
  if (check && !s.page.isClosed()) result = await checkLoginOn(s.retailer, s.page).catch(() => null);
  if (!s.page.isClosed()) await s.page.close().catch(() => {});
  await closeIfPaused(s.retailer);
  return result;
}

async function checkLoginOn(retailer, page) {
  const adapter = getAdapter(retailer);
  const settings = getCheckoutSettings(loadConfigFresh() || {});
  const loggedIn = await adapter.checkLogin(page, { settings, timeout: settings.step_timeout_seconds * 1000, log: () => {} });
  markLogin(retailer, loggedIn, loggedIn == null ? 'could not tell (captcha or queue on account page)' : null);
  console.log(`[live] ${retailer}: signed in = ${loggedIn}`);
  return loggedIn;
}

/** Check sign-in status in a fresh tab. */
export async function checkLogin(retailer) {
  const page = await newPage(retailer);
  try {
    return await checkLoginOn(retailer, page);
  } finally {
    await page.close().catch(() => {});
    await closeIfPaused(retailer);
  }
}

export function liveSessions() {
  return [...loginSessions.values()].map(({ page, timer, ...s }) => ({ ...s, url: page.isClosed() ? null : page.url() }));
}

/** Returns { jpeg, width, height, url, title, kind, retailer } or null. */
export async function liveFrame(id) {
  const s = sessionFor(id);
  if (!s) return null;
  const { page } = s;
  const [width, height] = await page.evaluate(() => [window.innerWidth, window.innerHeight]);
  const jpeg = await page.screenshot({ type: 'jpeg', quality: 60, fullPage: false });
  return { jpeg, width, height, url: page.url(), title: await page.title().catch(() => ''), kind: s.kind, retailer: s.retailer };
}

/**
 * Input actions:
 *   { type: 'click', x, y }   — x/y as fractions 0..1 of the frame (resolution independent)
 *   { type: 'down', x, y } / { type: 'up' } — press and hold (e.g. a "Press & hold" check):
 *                               the mouse stays down until 'up' (auto-released after 30 s)
 *   { type: 'type', text }    — types into the focused field
 *   { type: 'key', key }      — e.g. Enter, Tab, Backspace
 *   { type: 'scroll', dy }    — CSS px, positive = down
 *   { type: 'back' } | { type: 'reload' } | { type: 'goto', url }
 */
export async function liveInput(id, a) {
  const s = sessionFor(id);
  if (!s) return { ok: false, error: 'this session is closed' };
  const { page } = s;
  const [w, h] = await page.evaluate(() => [window.innerWidth, window.innerHeight]);
  switch (a.type) {
    case 'click': {
      const x = Math.max(0, Math.min(1, Number(a.x))) * w;
      const y = Math.max(0, Math.min(1, Number(a.y))) * h;
      await page.mouse.click(x, y);
      break;
    }
    case 'down': {
      const x = Math.max(0, Math.min(1, Number(a.x))) * w;
      const y = Math.max(0, Math.min(1, Number(a.y))) * h;
      if (heldMouse.has(page)) { clearTimeout(heldMouse.get(page)); await page.mouse.up().catch(() => {}); }
      await page.mouse.move(x, y);
      await page.mouse.down();
      heldSince.set(page, Date.now());
      console.log(`[live] ${s.retailer}: hold started at ${Math.round(x)},${Math.round(y)} (${s.kind})`);
      // Never leave the mouse stuck down if the release never arrives.
      heldMouse.set(page, setTimeout(() => {
        heldMouse.delete(page); heldSince.delete(page);
        page.mouse.up().catch(() => {});
        console.log(`[live] ${s.retailer}: hold auto-released after 30 s (no release arrived)`);
      }, 30_000));
      return { ok: true }; // no settle delay — keep the hold timing accurate
    }
    case 'up': {
      clearTimeout(heldMouse.get(page));
      heldMouse.delete(page);
      await page.mouse.up();
      const since = heldSince.get(page);
      heldSince.delete(page);
      console.log(`[live] ${s.retailer}: hold released after ${since ? ((Date.now() - since) / 1000).toFixed(1) + ' s' : '? (no hold was active)'}`);
      break;
    }
    case 'type':
      await page.keyboard.type(String(a.text ?? ''), { delay: 35 });
      break;
    case 'key':
      if (!/^[A-Za-z0-9]+$/.test(String(a.key))) return { ok: false, error: 'bad key' };
      await page.keyboard.press(String(a.key));
      break;
    case 'scroll':
      await page.mouse.wheel(0, Number(a.dy) || 0);
      break;
    case 'back':
      await page.goBack().catch(() => {});
      break;
    case 'reload':
      await page.reload().catch(() => {});
      break;
    case 'goto': {
      // Only same-site navigation (e.g. jump to cart) — never arbitrary URLs.
      const target = new URL(String(a.url), page.url());
      const base = (host) => host.split('.').slice(-2).join('.');
      if (base(target.hostname) !== base(new URL(page.url()).hostname)) return { ok: false, error: 'can only navigate within the same site' };
      await page.goto(target.href).catch(() => {});
      break;
    }
    default:
      return { ok: false, error: 'unknown action' };
  }
  await page.waitForTimeout(300);
  return { ok: true };
}
