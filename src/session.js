// Long-lived browser sessions — one persistent, logged-in Chrome profile per
// retailer, shared by the monitor, queue/checkout flows, drawing entries,
// discovery searches and Live view. Keeping one session means the queue pass,
// cart and login cookies all live in the same place.

import { launchProfile } from './checkout/browser.js';
import { getCheckoutSettings, loadConfigFresh } from './config.js';

const sessions = new Map(); // retailer -> Promise<{ context, monitorPage }>

export function getSession(retailer) {
  if (!sessions.has(retailer)) {
    const p = (async () => {
      const settings = getCheckoutSettings(loadConfigFresh() || {});
      const { context, page } = await launchProfile(retailer, settings);
      context.on('close', () => { if (sessions.get(retailer) === p) sessions.delete(retailer); });
      console.log(`[session] ${retailer}: browser profile open`);
      return { context, monitorPage: page };
    })();
    sessions.set(retailer, p);
    p.catch(() => { if (sessions.get(retailer) === p) sessions.delete(retailer); });
  }
  return sessions.get(retailer);
}

/** The tab the monitor polls product pages in. */
export async function monitorPage(retailer) {
  const s = await getSession(retailer);
  if (s.monitorPage.isClosed()) s.monitorPage = await s.context.newPage();
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
