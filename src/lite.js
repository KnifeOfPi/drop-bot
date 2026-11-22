// Light stock checks — the data-cheap way to watch products.
//
// Instead of loading a full product page in Chrome (≈1–2 MB with scripts and
// data calls), a light check downloads ONE response through the store's own
// logged-in session (same cookies, same proxy, same browser user-agent):
//   • Best Buy: its price/availability data (a few KB)
//   • other stores: the product page's HTML only — no scripts, images or API
//     calls — and reads the stock info stores embed for search engines
//     (schema.org "availability") or in their page data.
// The monitor only falls back to a full Chrome check when a light check says
// something is live, or can't tell (rate-limited — see monitor.js).

import { getSession, monitorPage } from './session.js';
import { addBytes } from './bandwidth.js';
import { QUEUE_URL, QUEUE_TEXT } from './checkout/helpers.js';

// Tests replace this: (retailer, url, headers) => ({ status, url, headers, body })
export const liteHooks = { fetch: null };

const uaCache = new Map();
async function userAgent(retailer) {
  if (!uaCache.has(retailer)) {
    const page = await monitorPage(retailer);
    uaCache.set(retailer, await page.evaluate(() => navigator.userAgent).catch(() => null));
  }
  return uaCache.get(retailer);
}

/** One GET through the store's session. Counts its bytes as "monitor" data. */
export async function liteFetch(retailer, url, { accept, referer } = {}) {
  const headers = {
    accept: accept || 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'accept-language': 'en-US,en;q=0.9',
  };
  if (referer) headers.referer = referer;
  let r;
  if (liteHooks.fetch) {
    r = await liteHooks.fetch(retailer, url, headers);
  } else {
    const ua = await userAgent(retailer);
    if (ua) headers['user-agent'] = ua;
    const { context } = await getSession(retailer);
    const res = await context.request.get(url, { headers, timeout: 20000, maxRedirects: 5, failOnStatusCode: false });
    r = { status: res.status(), url: res.url(), headers: res.headers(), body: await res.text() };
    await res.dispose().catch(() => {});
  }
  const wire = Number(r.headers?.['content-length']) || Buffer.byteLength(r.body || '');
  addBytes(retailer, 'monitor', wire + 800); // + request/response headers
  return r;
}

const CAPTCHA = /px-captcha|captcha-delivery\.com|press (&|and) hold|verify you are (a )?human|are you a robot|robot or human|_Incapsula_Resource|cf-chl-|access denied/i;
const DRAWING = /\b(enter (the |this )?drawing|enter for (a|the) chance to (buy|win|purchase)|join (the )?drawing)\b/i;

function mapAvailability(v) {
  const s = String(v || '');
  if (/InStoreOnly/i.test(s)) return 'oos'; // can't buy online
  if (/InStock|OnlineOnly|LimitedAvailability|PreOrder|PreSale/i.test(s)) return 'in_stock';
  if (/OutOfStock|SoldOut|Discontinued/i.test(s)) return 'oos';
  return null;
}

function walkLd(node, out) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { for (const n of node) walkLd(n, out); return; }
  const type = [].concat(node['@type'] || []).join(',');
  if (/Product/i.test(type) && node.offers) {
    for (const o of [].concat(node.offers)) {
      for (const offer of [].concat(o.offers || o)) {
        const st = mapAvailability(offer.availability);
        if (st) out.push({ status: st, price: offer.price ?? offer.lowPrice ?? null });
      }
    }
  }
  if (node['@graph']) walkLd(node['@graph'], out);
}

/**
 * Read stock status from a light response.
 * Returns { status: in_stock | oos | queue | blocked | maybe | unknown, signal, price }.
 * "maybe" = something worth confirming with a full check (e.g. drawing wording).
 */
export function parseAvailability({ status, url = '', body = '' }) {
  if (QUEUE_URL.test(url)) return { status: 'queue', signal: 'queue-url' };
  const small = body.length < 150_000; // queue / captcha pages are small; product pages aren't
  if (small && QUEUE_TEXT.test(body)) return { status: 'queue', signal: 'queue-page' };
  if (status === 403 || status === 429 || status === 503 || (small && CAPTCHA.test(body))) {
    return { status: 'blocked', signal: `http-${status}` };
  }
  if (status >= 400) return { status: 'unknown', signal: `http-${status}` };
  if (DRAWING.test(body)) return { status: 'maybe', signal: 'drawing-text' };

  const ld = [];
  for (const m of body.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try { walkLd(JSON.parse(m[1].trim()), ld); } catch { /* malformed block */ }
  }
  const fmt = (p) => (p != null && !Number.isNaN(Number(p)) ? `$${Number(p).toFixed(2)}` : null);
  if (ld.length) {
    const hit = ld.find((x) => x.status === 'in_stock') || ld[0];
    return { status: hit.status, signal: 'schema.org', price: fmt(hit.price) };
  }
  const as = body.match(/"availabilityStatus"\s*:\s*"([A-Z_]+)"/);
  if (as) {
    if (/^(IN_STOCK|LIMITED_STOCK|AVAILABLE)$/.test(as[1])) return { status: 'in_stock', signal: 'availabilityStatus' };
    if (/OUT_OF_STOCK|NOT_AVAILABLE|UNAVAILABLE/.test(as[1])) return { status: 'oos', signal: 'availabilityStatus' };
  }
  const bs = body.match(/"buttonState"\s*:\s*"([A-Z_]+)"/);
  if (bs) {
    if (/^(ADD_TO_CART|PRE_ORDER)$/.test(bs[1])) return { status: 'in_stock', signal: 'buttonState' };
    if (/DRAW|INVITE/.test(bs[1])) return { status: 'maybe', signal: 'buttonState' };
    return { status: 'oos', signal: 'buttonState' };
  }
  return { status: 'unknown', signal: 'no-stock-data' };
}

/** Light check for one product. Never throws. */
export async function liteCheck(adapter, product) {
  const fetchLite = (url, opts) => liteFetch(adapter.id, url, opts);
  try {
    if (adapter.liteCheck) {
      const r = await adapter.liteCheck(fetchLite, product);
      if (r) return r;
    }
    return parseAvailability(await fetchLite(adapter.productUrl(product)));
  } catch (e) {
    return { status: 'unknown', signal: 'error', error: e.message.split('\n')[0] };
  }
}
