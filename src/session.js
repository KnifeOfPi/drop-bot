// Long-lived browser sessions — one persistent, logged-in Chrome profile per
// retailer, shared by the monitor, queue/checkout flows, drawing entries,
// discovery searches and Live view. Keeping one session means the queue pass,
// cart and login cookies all live in the same place.
//
// Every tab is metered (src/bandwidth.js); monitor + discovery tabs also get
// the data saver (blocks images/video/fonts/trackers but keeps the cache).

import { launchProfile } from './checkout/browser.js';
import { getCheckoutSettings, getMonitorSettings, loadConfigFresh } from './config.js';
import { meterPage, leanPage as lean } from './bandwidth.js';

const sessions = new Map(); // retailer -> Promise<{ context, monitorPage }>

const saverOn = () => getMonitorSettings(loadConfigFresh() || {}).save_bandwidth !== false;

/** Turn a tab into a data-saving tab: 'monitor' (default) or 'discovery'. */
export function leanPage(retailer, page, purpose = 'monitor') {
  return lean(retailer, page, purpose, saverOn());
}

export function getSession(retailer) {
  if (!sessions.has(retailer)) {
    const p = (async () => {
      const settings = getCheckoutSettings(loadConfigFresh() || {});
      const { context, page } = await launchProfile(retailer, settings);
      context.on('close', () => { if (sessions.get(retailer) === p) sessions.delete(retailer); });
      context.on('page', (pg) => { meterPage(retailer, pg); }); // pop-ups etc.
      console.log(`[session] ${retailer}: browser profile open`);
      return { context, monitorPage: await leanPage(retailer, page, 'monitor') };
    })();
    sessions.set(retailer, p);
    p.catch(() => { if (sessions.get(retailer) === p) sessions.delete(retailer); });
  }
  return sessions.get(retailer);
}

/** The tab the monitor polls product pages in. */
export async function monitorPage(retailer) {
  const s = await getSession(retailer);
  if (s.monitorPage.isClosed()) s.monitorPage = await leanPage(retailer, await s.context.newPage(), 'monitor');
  return s.monitorPage;
}

/** A fresh, metered tab for a flow (checkout, drawing, sign-in). Caller closes it. */
export async function newPage(retailer) {
  const s = await getSession(retailer);
  const page = await s.context.newPage();
  await meterPage(retailer, page); // attach before the caller navigates
  return page;
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
