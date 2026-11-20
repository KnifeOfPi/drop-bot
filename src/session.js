// Long-lived browser sessions — one persistent, logged-in Chrome profile per
// retailer, shared by the monitor, queue/checkout flows, drawing entries,
// discovery searches and Live view. Keeping one session means the queue pass,
// cart and login cookies all live in the same place.

import { launchProfile } from './checkout/browser.js';
import { getCheckoutSettings, getMonitorSettings, loadConfigFresh } from './config.js';

const sessions = new Map(); // retailer -> Promise<{ context, monitorPage }>
const leaned = new WeakSet();

const HEAVY = new Set(['image', 'media', 'font']);

/**
 * Bandwidth saver for tabs nobody looks at (monitor + discovery): skip images,
 * video and fonts — most of a product page's weight, and what a per-GB
 * residential proxy bills for. Checkout, sign-in and Live view tabs load fully.
 */
export async function leanPage(page) {
  if (leaned.has(page)) return page;
  leaned.add(page);
  if (getMonitorSettings(loadConfigFresh() || {}).save_bandwidth === false) return page;
  await page.route('**/*', (route) => (HEAVY.has(route.request().resourceType()) ? route.abort() : route.fallback()));
  return page;
}

export function getSession(retailer) {
  if (!sessions.has(retailer)) {
    const p = (async () => {
      const settings = getCheckoutSettings(loadConfigFresh() || {});
      const { context, page } = await launchProfile(retailer, settings);
      context.on('close', () => { if (sessions.get(retailer) === p) sessions.delete(retailer); });
      console.log(`[session] ${retailer}: browser profile open`);
      return { context, monitorPage: await leanPage(page) };
    })();
    sessions.set(retailer, p);
    p.catch(() => { if (sessions.get(retailer) === p) sessions.delete(retailer); });
  }
  return sessions.get(retailer);
}

/** The tab the monitor polls product pages in. */
export async function monitorPage(retailer) {
  const s = await getSession(retailer);
  if (s.monitorPage.isClosed()) s.monitorPage = await leanPage(await s.context.newPage());
  return s.monitorPage;
}

/** A fresh tab for a flow (checkout, drawing, discovery). Caller closes it. */
export async function newPage(retailer) {
  const s = await getSession(retailer);
  return s.context.newPage();
}

export function openSessions() {
  return [...sessions.keys()];
}

export async function closeSession(retailer) {
  const p = sessions.get(retailer);
  sessions.delete(retailer);
  if (p) await (await p.catch(() => null))?.context.close().catch(() => {});
}

export async function closeAll() {
  await Promise.all([...sessions.keys()].map(closeSession));
}
