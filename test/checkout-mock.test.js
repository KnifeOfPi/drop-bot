#!/usr/bin/env node
// Offline end-to-end test — runs the real retailer adapters, engine, monitor,
// discovery, hand-off + Live view against MOCK retailer pages (Playwright
// request interception) and a local fake Discord. No real site is contacted,
// nothing is bought, and your config.yaml / data/ are not touched.
//
//   npm run test-checkout
//
// Needs Chrome/Chromium (CHECKOUT_BROWSER_PATH or installed Chrome).

import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { createServer } from 'http';
import { tmpdir } from 'os';
import { join } from 'path';
import yaml from 'js-yaml';

const TMP = mkdtempSync(join(tmpdir(), 'dropbot-test-'));
const CONFIG = join(TMP, 'config.yaml');
process.env.DROPBOT_CONFIG = CONFIG;
process.env.DROPBOT_DATA_DIR = join(TMP, 'data');
process.env.TARGET_CVV = '123';
process.env.BESTBUY_CVV = '456';
process.env.POKEMONCENTER_CVV = '789';
delete process.env.COSTCO_CVV; // Costco's CVV is saved the dashboard way (data/secrets.json) below
process.env.DISCORD_MENTION_USER_ID = '42';
process.env.DASHBOARD_URL = 'https://dash.example';

// ── Fake Discord: every webhook points here (never at real Discord) ─────────
const discord = [];
const hookServer = createServer((req, res) => {
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    discord.push({ hook: req.url.split('/').pop(), body: Buffer.concat(chunks).toString('latin1') });
    res.writeHead(204); res.end();
  });
});
await new Promise(r => hookServer.listen(0, '127.0.0.1', r));
const HOOK = `http://127.0.0.1:${hookServer.address().port}/hook`;
for (const k of ['DROP_ALERTS', 'QUEUE_LIVE', 'CHECKOUT_SUCCESS', 'CHECKOUT_FAIL', 'ACTION_NEEDED', 'DRAWINGS', 'DISCOVERY', 'CANCELLATIONS', 'HEALTH']) {
  process.env[`DISCORD_${k}`] = `${HOOK}/${k.toLowerCase()}`;
}
const sent = (hook, text) => discord.some(d => d.hook === hook && (!text || d.body.includes(text)));

const baseConfig = {
  discord: {},
  products: [
    { retailer: 'target', tcin: '1010892076', label: 'T ETB', max_price: 69.99, action: 'checkout' },
    { retailer: 'target', tcin: '1010892077', label: 'T Bundle (hangs)', max_price: 39.99, action: 'checkout' },
    { retailer: 'target', tcin: '1010892078', label: 'T UPC', max_price: 199.99, action: 'checkout' },
    { retailer: 'target', tcin: '999', label: 'T OOS', max_price: 50, action: 'checkout' },
    { retailer: 'best-buy', sku: '6580529', label: 'BB ETB', max_price: 69.99, action: 'checkout' },
    { retailer: 'best-buy', sku: '6580530', label: 'BB Bundle (kill switch)', max_price: 39.99, action: 'checkout' },
    { retailer: 'pokemon-center', url: 'https://www.pokemoncenter.com/product/699-18442', label: 'PC ETB', max_price: 69.99, action: 'checkout' },
    { retailer: 'pokemon-center', url: 'https://www.pokemoncenter.com/product/699-18443', label: 'PC notify-only', max_price: 39.99, action: 'notify' },
    { retailer: 'walmart', url: 'https://www.walmart.com/ip/Pokemon-ETB/111', label: 'WM ETB (queued)', max_price: 59.99, action: 'assist' },
    { retailer: 'walmart', url: 'https://www.walmart.com/ip/Pokemon-Drawing-Box/222', label: 'WM drawing', max_price: 49.99, action: 'assist' },
    { retailer: 'costco', url: 'https://www.costco.com/pokemon-etb-2-pack.product.4000111.html', label: 'Costco 2-pack', max_price: 74.99, action: 'checkout' },
    { retailer: 'sams-club', url: 'https://www.samsclub.com/ip/pokemon-tin/prod999', label: "Sam's tin", max_price: 39.99, action: 'assist' },
  ],
  checkout: {
    enabled: true, dry_run: true, headless: !process.env.TEST_HEADED, auto_enter_drawings: true,
    max_orders_per_product: 1, max_total_spend: 1000, max_total_overage_pct: 20,
    retry_cooldown_seconds: 1, step_timeout_seconds: 3, queue_wait_minutes: 1, handoff_hold_minutes: 5,
    profile_dir: join(TMP, 'profiles'),
  },
  monitor: { interval_seconds: 1, max_consecutive_errors: 50, watch_mode: 'full', daily_proxy_limit_mb: 0 },
  discovery: { enabled: false, retailers: ['walmart', 'target'], queries: ['pokemon tcg'], must_match: 'pok[eé]mon' },
};
const writeConfig = (patch = {}, { products, monitor } = {}) => {
  const c = structuredClone(baseConfig);
  Object.assign(c.checkout, patch);
  if (products) c.products = products;
  if (monitor) Object.assign(c.monitor, monitor);
  writeFileSync(CONFIG, yaml.dump(c));
};
writeConfig();

// Imports AFTER env + config are in place.
const { hooks } = await import('../src/checkout/browser.js');
const { runCheckout, runFlow, findProduct, onObserved, getCheckoutStatus, resolveHandoff, getHandoff } = await import('../src/checkout/index.js');
const { liveFrame, liveInput } = await import('../src/live.js');
const { discoverOnce, recentDiscoveries } = await import('../src/discovery.js');
const { startMonitors, stopMonitors, productState, activeHotWindow } = await import('../src/monitor.js');
const { closeAll, newPage } = await import('../src/session.js');
const { getAdapter } = await import('../src/retailers/index.js');
const { liteHooks, parseAvailability } = await import('../src/lite.js');
// Light checks never touch the network in tests: each test supplies responses.
const NO_NET = async (_r, url) => { throw new Error(`test tried a real light fetch: ${url}`); };
liteHooks.fetch = NO_NET;
const { openLoginSession, closeLoginSession } = await import('../src/live.js');
const { setCvv, accountsStatus } = await import('../src/accounts.js');

// ── Mock retailer pages ─────────────────────────────────────────────────────
const scenario = { bbTotal: '73.50', walmartQueueUntil: 0, walmartEntered: false, walmartNewListing: false, walmartLoggedIn: false };
const seen = [];
const html = (body) => `<!doctype html><html><head><meta charset="utf-8"><title>mock</title></head><body>${body}</body></html>`;
const addBtn = (label = 'Add to Cart', attrs = '') =>
  `<button ${attrs} onclick="document.getElementById('m').textContent='Added to cart'">${label}</button><div id="m"></div>`;

function mock(url) {
  const u = new URL(url);
  const p = u.pathname;
  if (u.host === 'www.target.com') {
    if (p === '/p/-/A-999') return html(`<h1>OOS item</h1><p>Out of stock</p><button>Notify me when it's back</button>`);
    if (p.startsWith('/p/-/A-')) {
      const tcin = p.split('A-')[1];
      // Like the real page: stock comes from a follow-up request to Target's product-data service.
      return html(`<h1>Item</h1><span>$69.99</span>${addBtn('Ship it', 'data-test="shippingButton"')}
        <script>${scenario.targetPost
          ? `fetch('https://www.target.com/api/v3/stock', { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'k123' }, body: JSON.stringify({ tcin: '${tcin}', zip: '10001' }) })`
          : `fetch('https://redsky.target.com/redsky_aggregations/v1/web/pdp_fulfillment_v1?key=testkey&tcin=${tcin}&store_id=1&page=%2Fp%2FA-${tcin}')`}</script>`);
    }
    if (p === '/checkout') {
      return html(`<h1>Checkout</h1><label>CVV <input id="creditCardInput-cvv"></label>
        <div>Order total</div><div>$${scenario.targetTotal || '74.21'}</div>
        <button data-test="placeOrderButton" onclick="${scenario.targetHang ? '' : `location.href='/order-confirmation?cvv='+document.getElementById('creditCardInput-cvv').value`}">Place your order</button>`);
    }
    if (p === '/order-confirmation') return html(`<h1>Thanks for your order!</h1><p>Order number: 912000123456</p>`);
    if (p === '/cart') return html(`<h1>Cart</h1>`);
    if (p === '/s') return html(`<a href="/p/pokemon-etb/-/A-1010892076">Pokémon TCG ETB</a> <span>$49.99</span>`);
  }
  if (u.host === 'redsky.target.com' || (u.host === 'www.target.com' && p === '/api/v3/stock')) {
    return '{"data":{"product":{"fulfillment":{"shipping_options":{"availability_status":"IN_STOCK"}}}}}';
  }
  if (u.host === 'www.bestbuy.com') {
    if (p.startsWith('/site/')) return html(`<h1>BB item</h1>
      <button class="add-to-cart-button" data-button-state="ADD_TO_CART" id="b">Add to Cart</button><div id="m"></div>
      <script>let n=0;const b=document.getElementById('b');b.onclick=()=>{n++;if(n===1){b.textContent='Please Wait...';b.disabled=true;
      b.setAttribute('data-button-state','PLEASE_WAIT');setTimeout(()=>{b.disabled=false;b.textContent='Add to Cart';
      b.setAttribute('data-button-state','ADD_TO_CART')},1500)}else{document.getElementById('m').textContent='Added to cart'}}</script>`);
    if (p === '/checkout/r/fast-track') {
      scenario.onBBCheckout?.();
      return html(`<h1>Checkout</h1><input id="cvv"><div>Order Total $${scenario.bbTotal}</div>
        <button class="button__fast-track" onclick="location.href='/checkout/r/thank-you?cvv='+document.getElementById('cvv').value">Place Your Order</button>`);
    }
    if (p === '/checkout/r/thank-you') return html(`<h1>Thank you for your order.</h1><p>Order number: BBY01-806123</p>`);
  }
  if (u.host === 'www.pokemoncenter.com') {
    if (p.startsWith('/product/')) return html(`<h1>PC item</h1>${addBtn()}`);
    if (p === '/cart') return html(`<h1>Cart</h1><a href="/checkout/shipping">Checkout</a>`);
    if (p === '/checkout/shipping') return html(`<h1>Shipping</h1><button onclick="location.href='/checkout/payment'">Continue to Payment</button>`);
    if (p === '/checkout/payment') return html(`<h1>Payment</h1><input name="cvv" id="c"><button onclick="location.href='/checkout/review?cvv='+document.getElementById('c').value">Review Order</button>`);
    if (p === '/checkout/review') return html(`<h1>Review</h1><div>Order Total: $75.10</div><button onclick="location.href='/order-confirmation'">Place Order</button>`);
    if (p === '/order-confirmation') return html(`<h1>Thank you for your order!</h1><p>Order number: P00012345</p>`);
  }
  if (u.host === 'www.walmart.com') {
    if (p === '/ip/Pokemon-ETB/111') {
      if (Date.now() < scenario.walmartQueueUntil) {
        return html(`<h1>You're in line</h1><p>Estimated wait time: 1 minute</p><script>setTimeout(()=>location.reload(),1000)</script>`);
      }
      return html(`<h1>Pokémon ETB</h1><img src="/img/etb-photo.png" width="10" height="10"><span itemprop="price">$54.97</span>${addBtn('Add to cart', 'data-automation-id="atc"')}`);
    }
    if (p === '/ip/Pokemon-Drawing-Box/222') {
      if (scenario.walmartEntered) return html(`<h1>Drawing Box</h1><p>You're entered! Winners are notified by email.</p>`);
      return html(`<h1>Drawing Box</h1><span>$49.97</span><button id="d">Enter drawing</button>
        <div role="dialog" id="dlg" style="display:none"><p>Enter this drawing?</p><button id="ok">Enter</button></div>
        <p id="msg"></p>
        <script>d.onclick=()=>{dlg.style.display='block'};ok.onclick=async()=>{await fetch('/drawing/submit');dlg.style.display='none';msg.textContent="You're entered!"}</script>`);
    }
    if (p === '/drawing/submit') { scenario.walmartEntered = true; return html('ok'); }
    if (p === '/hold-check') return html(`<h1>Quick verification</h1>
      <button id="h" style="margin:40px;padding:20px 40px">Press &amp; hold</button><p id="msg">waiting</p>
      <script>let t=0;h.onmousedown=()=>{t=Date.now();msg.textContent='holding'};
      document.onmouseup=()=>{if(t){msg.textContent='held '+((Date.now()-t)/1000).toFixed(1);t=0}}</script>`);
    if (p === '/account/login') return html(`<h1>Sign in</h1>
      <input id="email" type="email" placeholder="Email"> <input id="pw" type="password" placeholder="Password">
      <button id="go" onclick="fetch('/account/login/submit?e='+encodeURIComponent(email.value)+'&p='+encodeURIComponent(pw.value)).then(()=>location.href='/account')">Sign in</button>`);
    if (p === '/account/login/submit') {
      scenario.walmartLoggedIn = u.searchParams.get('e') === 'ash@example.com' && u.searchParams.get('p') === 'pikachu!';
      return html('ok');
    }
    if (p === '/account') return scenario.walmartLoggedIn
      ? html(`<h1>Hi, Ash</h1><a href="#">Purchase history</a> <button>Sign out</button>`)
      : html(`<script>location.replace('/account/login')</script>`);
    if (p === '/cart') return html(`<h1>Cart</h1><button onclick="location.href='/checkout'">Continue to checkout</button>`);
    if (p === '/checkout') return html(`<h1>Checkout</h1><button onclick="location.href='/checkout/review'">Continue</button>`);
    if (p === '/checkout/review') return html(`<h1>Review</h1><div>Order total</div><div>$55.00</div><button onclick="location.href='/thankyou'">Place order</button>`);
    if (p === '/thankyou') return html(`<h1>Thanks for your order!</h1><p>Order number 2000111222333</p>`);
    if (p === '/search') return html(`
      <div><a href="/ip/Pokemon-ETB/111">Pokemon TCG Elite Trainer Box</a> <span>$54.97</span></div>
      <div><a href="/ip/LEGO-Castle/555">LEGO Castle</a> <span>$99.00</span></div>
      ${scenario.walmartNewListing ? '<div><a href="/ip/Pokemon-TCG-New-Booster-Box/444">Pokémon TCG New Booster Box</a> <span>$49.97</span></div>' : ''}`);
  }
  if (u.host === 'www.costco.com') {
    if (p.endsWith('.product.4000111.html')) return html(`<h1>Pokémon ETB 2-pack</h1><span>$69.99</span>
      <input type="button" id="add-to-cart-btn" value="Add to Cart" onclick="document.getElementById('m').textContent='Added to cart'"><div id="m"></div>`);
    if (p === '/CheckoutCartDisplayView') return html(`<h1>Cart</h1><button id="shopCartCheckoutSubmitButton" onclick="location.href='/checkout/shipping'">Checkout</button>`);
    if (p === '/checkout/shipping') return html(`<h1>Shipping</h1><button onclick="location.href='/checkout/payment'">Continue</button>`);
    if (p === '/checkout/payment') return html(`<h1>Payment</h1><input name="securityCode" id="c"><button onclick="location.href='/checkout/review?cvv='+document.getElementById('c').value">Continue to Review</button>`);
    if (p === '/checkout/review') return html(`<h1>Review</h1><div>Order Total $79.99</div><button onclick="location.href='/OrderConfirmation'">Place Order</button>`);
    if (p === '/OrderConfirmation') return html(`<h1>Thank you for your order.</h1><p>Order Number: 1234567890</p>`);
  }
  if (u.host === 'www.samsclub.com') {
    if (p.startsWith('/ip/')) return html(`<h1>Pokémon Tin</h1><span>$34.98</span><p>Out of stock</p>`);
  }
  return null;
}

hooks.onContext = async (context) => {
  await context.route('**/*', (route) => {
    const url = route.request().url();
    seen.push(url);
    const body = mock(url);
    const json = body && body.startsWith('{');
    if (body) return route.fulfill({ status: 200, contentType: json ? 'application/json' : 'text/html; charset=utf-8', body });
    return route.fulfill({ status: 204, body: '' }); // never hit the network
  });
};

// ── Tests ───────────────────────────────────────────────────────────────────
let passed = 0, failed = 0;
async function test(name, fn) {
  if (process.env.ONLY && !name.includes(process.env.ONLY)) return; // ONLY=Walmart npm run test-checkout
  try {
    await fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (e) {
    console.log(`  ❌ ${name}\n     ${e.message}`);
    failed++;
  }
}
function expect(cond, msg) { if (!cond) throw new Error(msg); }
const P = (r, id) => findProduct(r, id);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return true; await sleep(200); }
  return false;
}
const ctxFor = () => ({ settings: { queue_wait_minutes: 1, step_timeout_seconds: 3 }, timeout: 3000, log: () => {} });

console.log('\nDrop bot mock tests\n');

// ── Checkout core (Target / Best Buy / Pokémon Center) ──
await test('Target dry run stops at Place order and reads total', async () => {
  const r = await runCheckout(P('target', '1010892076'), { dryRun: true });
  expect(r.status === 'dry_run', `status ${r.status} ${r.error || ''}`);
  expect(r.total === 74.21, `total ${r.total}`);
  expect(!seen.some(u => u.includes('order-confirmation')), 'dry run must not click Place order');
});

await test('Checkout while global dry_run is on → hands off instead of clicking', async () => {
  const r = await runCheckout(P('target', '1010892076'), { dryRun: false });
  expect(r.status === 'handoff', `status ${r.status} ${r.error || ''}`);
  expect(!seen.some(u => u.includes('order-confirmation')), 'must not place order');
  expect(await until(() => sent('action_needed', '<@42>'), 3000), 'hand-off alert should @mention you');
  expect(sent('action_needed', 'dash.example/live?id='), 'hand-off alert should link Live view');
  await resolveHandoff(r.handoff_id, 'abandoned');
  expect(!getHandoff(r.handoff_id), 'hand-off should be closed');
});

writeConfig({ dry_run: false });

await test('Target full checkout succeeds, enters CVV, captures order #', async () => {
  const r = await runCheckout(P('target', '1010892076'), { dryRun: false });
  expect(r.status === 'success', `status ${r.status} ${r.error || ''}`);
  expect(r.order_number === '912000123456', `order ${r.order_number}`);
  expect(seen.some(u => u.includes('order-confirmation?cvv=123')), 'CVV not entered');
});

await test('Second order of same product blocked by max_orders_per_product', async () => {
  const r = await runCheckout(P('target', '1010892076'), { dryRun: false });
  expect(r.status === 'guard' && /already ordered/.test(r.error), `${r.status} ${r.error}`);
});

await test('Out-of-stock page → unavailable (no ledger entry)', async () => {
  const r = await runCheckout(P('target', '999'), { dryRun: false });
  expect(r.status === 'unavailable', `status ${r.status} ${r.error || ''}`);
  expect(!getCheckoutStatus().recent.some(a => a.key === 'target:999'), 'unavailable should not be logged');
});

await test('Order total above cap → not bought, handed off for you to review', async () => {
  scenario.bbTotal = '150.00';
  const r = await runCheckout(P('best-buy', '6580529'), { dryRun: false });
  scenario.bbTotal = '73.50';
  expect(r.status === 'handoff' && /order total/.test(r.message), `${r.status} ${r.message || r.error}`);
  expect(!seen.some(u => u.includes('thank-you')), 'must not place order');
  await resolveHandoff(r.handoff_id, 'abandoned');
});

await test('Best Buy "Please Wait" queue → waits, re-clicks, orders', async () => {
  const r = await runCheckout(P('best-buy', '6580529'), { dryRun: false });
  expect(r.status === 'success', `status ${r.status} ${r.error || ''}`);
  expect(r.order_number === 'BBY01-806123', `order ${r.order_number}`);
  expect(seen.some(u => u.includes('thank-you?cvv=456')), 'CVV not entered');
  expect(await until(() => sent('queue_live', 'Joined the queue') && sent('queue_live', 'Through the queue'), 3000), 'queue alerts missing');
});

await test('Kill switch flipped mid-checkout → aborts, no hand-off', async () => {
  scenario.onBBCheckout = () => writeConfig({ dry_run: false, enabled: false });
  scenario.bbTotal = '42.50';
  const r = await runCheckout(P('best-buy', '6580530'), { dryRun: false });
  scenario.onBBCheckout = null;
  scenario.bbTotal = '73.50';
  writeConfig({ dry_run: false });
  expect(r.status === 'guard' && /disabled/.test(r.error), `${r.status} ${r.error}`);
});

await test('Pokémon Center multi-step checkout (continue → CVV → review → place)', async () => {
  const r = await runCheckout(P('pokemon-center', '699-18442'), { dryRun: false });
  expect(r.status === 'success', `status ${r.status} ${r.error || ''}`);
  expect(r.order_number === 'P00012345', `order ${r.order_number}`);
  expect(seen.some(u => u.includes('review?cvv=789')), 'CVV not entered');
});

await test('No confirmation after click → UNCONFIRMED, counts as an order (no double-buy)', async () => {
  scenario.targetHang = true; scenario.targetTotal = '42.00';
  const r = await runCheckout(P('target', '1010892077'), { dryRun: false });
  scenario.targetHang = false; scenario.targetTotal = null;
  expect(r.status === 'unconfirmed', `status ${r.status} ${r.error || ''}`);
  const again = await runCheckout(P('target', '1010892077'), { dryRun: false });
  expect(again.status === 'guard', `retry status ${again.status}`);
});

await test('Spend cap blocks before opening a page', async () => {
  writeConfig({ dry_run: false, max_total_spend: 100 });
  const before = seen.length;
  const r = await runCheckout(P('target', '1010892078'), { dryRun: false });
  writeConfig({ dry_run: false });
  expect(r.status === 'guard' && /spend cap/.test(r.error), `${r.status} ${r.error}`);
  expect(seen.length === before, 'should not have loaded any page');
});

// ── New retailers ──
await test('Costco full checkout (cart → continue → CVV → review → place)', async () => {
  setCvv('costco', '321'); // saved from the Accounts page, not .env
  expect(accountsStatus().costco.cvv_set && accountsStatus().costco.cvv_source === 'dashboard', 'cvv not saved');
  const r = await runCheckout(P('costco', '4000111'), { dryRun: false });
  expect(r.status === 'success', `status ${r.status} ${r.error || ''}`);
  expect(r.order_number === '1234567890', `order ${r.order_number}`);
  expect(r.total === 79.99, `total ${r.total}`);
  expect(seen.some(u => u.includes('review?cvv=321')), 'CVV not entered');
});

await test('Monitor check(): in stock / out of stock / queue / drawing', async () => {
  const st = async (r, id) => {
    const page = await newPage(r);
    try { return (await getAdapter(r).check(page, P(r, id), ctxFor())).status; } finally { await page.close(); }
  };
  scenario.walmartQueueUntil = Date.now() + 60_000;
  expect(await st('walmart', '111') === 'queue', 'walmart queue');
  scenario.walmartQueueUntil = 0;
  expect(await st('walmart', '111') === 'in_stock', 'walmart in stock');
  expect(await st('walmart', '222') === 'drawing_open', 'walmart drawing');
  expect(await st('sams-club', 'prod999') === 'oos', "sam's oos");
  expect(await st('costco', '4000111') === 'in_stock', 'costco in stock');
  expect(await st('target', '999') === 'oos', 'target oos');
});

writeConfig({ dry_run: true });

await test('Walmart drop: joins queue → through → cart → checkout → hand-off', async () => {
  scenario.walmartQueueUntil = Date.now() + 4000;
  onObserved(P('walmart', '111'), { status: 'queue', price: 'N/A' });
  expect(await until(() => getCheckoutStatus().busy.walmart?.in_queue, 8000), 'should report in queue');
  expect(await until(() => getCheckoutStatus().handoffs.some(h => h.key === 'walmart:111'), 30000), 'no hand-off created');
  expect(await until(() => sent('queue_live', 'Joined the queue') && sent('queue_live', 'WM ETB'), 3000), 'queue joined alert');
  expect(sent('queue_live', 'Through the queue'), 'queue passed alert');
});

await test('Live view: frame + tapping Place order completes the purchase (auto-detected)', async () => {
  const h = getCheckoutStatus().handoffs.find(x => x.key === 'walmart:111');
  expect(h, 'no walmart hand-off');
  const frame = await liveFrame(h.id);
  expect(frame && frame.jpeg.length > 1000 && frame.width > 0, 'no frame');
  const page = getHandoff(h.id).page;
  const box = await page.getByRole('button', { name: /place order/i }).boundingBox();
  const r = await liveInput(h.id, { type: 'click', x: (box.x + box.width / 2) / frame.width, y: (box.y + box.height / 2) / frame.height });
  expect(r.ok, r.error);
  expect(await until(() => !getHandoff(h.id), 12000), 'hand-off should resolve after confirmation');
  const rec = getCheckoutStatus().recent.find(a => a.key === 'walmart:111');
  expect(rec.status === 'success' && rec.order_number === '2000111222333', `${rec.status} ${rec.order_number}`);
  expect(await until(() => sent('checkout_success', 'ORDER PLACED'), 3000), 'success alert');
});

await test('Sold-out assist run → no hand-off; Live view refuses other sites', async () => {
  const r = await runFlow(P('sams-club', 'prod999'), { mode: 'assist' });
  expect(r.status === 'unavailable', `sam's ${r.status}`);
  const t = await runCheckout(P('target', '1010892078'), { dryRun: false }); // dry_run on → hand-off
  expect(t.status === 'handoff', `target ${t.status} ${t.error || ''}`);
  const bad = await liveInput(t.handoff_id, { type: 'goto', url: 'https://evil.example/' });
  expect(!bad.ok, 'cross-site goto should be refused');
  const ok = await liveInput(t.handoff_id, { type: 'goto', url: '/cart' });
  expect(ok.ok, 'same-site goto should work');
  await resolveHandoff(t.handoff_id, 'abandoned');
});

await test('Drawing open → bot enters it (dialog confirm) and records the entry', async () => {
  onObserved(P('walmart', '222'), { status: 'drawing_open' });
  expect(await until(() => getCheckoutStatus().recent.some(a => a.key === 'walmart:222' && a.status === 'drawing_entered'), 15000), 'not entered');
  expect(scenario.walmartEntered, 'mock never received the entry');
  expect(await until(() => sent('drawings', 'Entered drawing'), 3000), 'drawing alert');
  const n = getCheckoutStatus().recent.filter(a => a.key === 'walmart:222').length;
  onObserved(P('walmart', '222'), { status: 'drawing_open' });
  await sleep(1500);
  expect(getCheckoutStatus().recent.filter(a => a.key === 'walmart:222').length === n, 'should not re-enter');
});

await test('Auto trigger ignores notify-only, over-price and disabled', async () => {
  const before = seen.length;
  onObserved(P('pokemon-center', '699-18443'), { status: 'in_stock', price: '$39.99' }); // notify-only
  onObserved(P('target', '1010892078'), { status: 'in_stock', price: '$250.00' });      // > max_price
  writeConfig({ dry_run: true, enabled: false });
  onObserved(P('costco', '4000111'), { status: 'in_stock', price: '$69.99' });          // disabled
  await sleep(1500);
  writeConfig({ dry_run: true });
  expect(seen.length === before, `pages were loaded (${seen.length - before})`);
});

// ── Accounts: sign in from the dashboard (Live view) + dashboard-saved CVV ──
await test('Sign in via Live view: open login page, tap + type, Done → signed in', async () => {
  const id = await openLoginSession('walmart');
  const frame = await liveFrame(id);
  expect(frame?.kind === 'login' && frame.retailer === 'walmart', `frame ${frame?.kind}`);
  // Find element positions from the real page to simulate phone taps.
  const sessPage = (await (await import('../src/session.js')).getSession('walmart')).context.pages().find(p => p.url().includes('/account/login'));
  const at = async (sel) => { const b = await sessPage.locator(sel).boundingBox(); return { x: (b.x + b.width / 2) / frame.width, y: (b.y + b.height / 2) / frame.height }; };
  expect((await liveInput(id, { type: 'click', ...(await at('#email')) })).ok, 'tap email');
  await liveInput(id, { type: 'type', text: 'ash@example.com' });
  await liveInput(id, { type: 'click', ...(await at('#pw')) });
  await liveInput(id, { type: 'type', text: 'pikachu!' });
  await liveInput(id, { type: 'click', ...(await at('#go')) });
  expect(await until(() => scenario.walmartLoggedIn, 5000), 'credentials never reached the store');
  const loggedIn = await closeLoginSession(id, { check: true });
  expect(loggedIn === true, `checkLogin → ${loggedIn}`);
  expect(accountsStatus().walmart.logged_in === true, 'status not saved');
  expect(!(await liveFrame(id)), 'session should be closed');
});

await test('Signed-out store is detected', async () => {
  scenario.walmartLoggedIn = false;
  const { checkLogin } = await import('../src/live.js');
  expect(await checkLogin('walmart') === false, 'should be signed out');
  expect(accountsStatus().walmart.logged_in === false, 'status not saved');
});

// ── Monitor loop + discovery + schedule ──
await test('Monitor loop records status for every retailer and alerts on drops', async () => {
  writeConfig({ dry_run: true, enabled: false });
  startMonitors();
  const ok = await until(() =>
    productState.get('costco:4000111')?.status === 'in_stock' &&
    productState.get('sams-club:prod999')?.status === 'oos' &&
    productState.get('walmart:222')?.status === 'drawing_entered' &&
    productState.get('target:999')?.status === 'oos', 45000);
  stopMonitors();
  await sleep(2000);
  expect(ok, `states: ${[...productState.values()].map(s => `${s.key}=${s.status}`).join(', ')}`);
  expect(await until(() => sent('drop_alerts', 'Costco 2-pack'), 3000), 'in-stock drop alert');
});

await test('Discovery: first run learns, later runs alert only on new Pokémon listings', async () => {
  const first = await discoverOnce();
  expect(first.length === 0, `first run should seed silently (got ${first.length})`);
  scenario.walmartNewListing = true;
  const second = await discoverOnce();
  expect(second.length === 1 && second[0].id === '444', `got ${JSON.stringify(second.map(x => x.id))}`);
  expect(second[0].price === '$49.97', `price ${second[0].price}`);
  expect(recentDiscoveries()[0].id === '444', 'not in recent list');
  expect(sent('discovery', 'New Booster Box'), 'discovery alert');
  expect((await discoverOnce()).length === 0, 'should not re-alert');
});

await test('Hot windows: Walmart Wednesday speeds up polling only on Wednesdays', async () => {
  const w = [{ retailers: ['walmart'], days: ['wed'], start: '06:00', end: '18:00', timezone: 'America/New_York', interval_seconds: 10 }];
  expect(activeHotWindow('walmart', w, new Date('2026-11-18T15:00:00Z')), 'Wed 10:00 ET should be hot');
  expect(!activeHotWindow('walmart', w, new Date('2026-11-19T15:00:00Z')), 'Thu should not be hot');
  expect(!activeHotWindow('walmart', w, new Date('2026-11-18T03:00:00Z')), 'Tue night ET should not be hot');
  expect(!activeHotWindow('target', w, new Date('2026-11-18T15:00:00Z')), 'other retailers unaffected');
});

// ── VPS upgrade + proxy ──
await test('Old config is upgraded in place: interval, hot window, modes kept/added, webhooks kept, backup', async () => {
  const { migrateConfigFile } = await import('../src/config.js');
  const { readFileSync, existsSync } = await import('fs');
  const old = join(TMP, 'old-config.yaml');
  writeFileSync(old, yaml.dump({
    discord: { drop_alerts: 'https://discord.com/api/webhooks/1/abc', health: 'https://discord.com/api/webhooks/1/abc' },
    products: [
      { retailer: 'target', tcin: '1010892076', label: 'ETB', max_price: 69.99, auto_checkout: false },
      { retailer: 'pokemon-center', url: 'https://www.pokemoncenter.com/product/699-18442', label: 'PC ETB', max_price: 69.99, auto_checkout: true },
      { retailer: 'best-buy', sku: '6580529', label: 'BB ETB' },
    ],
    checkout: { enabled: false, dry_run: true, max_total_spend: 500 },
    monitor: { interval_seconds: 3, pc_queue_check_seconds: 5, backoff_on_429: 30, max_consecutive_errors: 10 },
    stealth: { headless: true },
    notifications: { throttle_same_product_seconds: 300 },
  }));
  const changes = migrateConfigFile(old);
  expect(Array.isArray(changes) && changes.length >= 4, `changes: ${JSON.stringify(changes)}`);
  const c = yaml.load(readFileSync(old, 'utf8'));
  expect(c.config_version === 4, 'version');
  expect(JSON.stringify(c.stores) === '["target","walmart","pokemon-center"]', `stores ${JSON.stringify(c.stores)}`);
  expect(c.monitor.interval_seconds === 60 && !('pc_queue_check_seconds' in c.monitor), `monitor ${JSON.stringify(c.monitor)}`);
  expect(c.monitor.watch_mode === 'lite' && c.monitor.daily_proxy_limit_mb === 500 && c.discovery.interval_minutes === 60, 'v3 data-saving defaults');
  expect(c.monitor.hot_windows?.[0]?.retailers?.[0] === 'walmart', 'hot window');
  expect(!c.stealth, 'stealth removed');
  expect(c.products.map(p => p.action).join() === 'assist,checkout,assist', `actions ${c.products.map(p => p.action)}`);
  expect(c.products.every(p => !('auto_checkout' in p)), 'auto_checkout removed');
  expect(c.discord.drop_alerts.endsWith('/abc'), 'webhooks kept');
  expect(c.checkout.max_total_spend === 500 && c.checkout.enabled === false && c.checkout.handoff_hold_minutes === 20, 'checkout merged');
  expect(c.discovery?.enabled === true, 'discovery added');
  expect(existsSync(`${old}.v1.bak`), 'backup missing');
  expect(migrateConfigFile(old) === null, 'second run should be a no-op');
});

await test('Proxy formats from providers are understood; SOCKS5 with a password is refused', async () => {
  const { normalizeProxy } = await import('../src/accounts.js');
  expect(normalizeProxy('gw.dataimpulse.com:823:user123:pa:ss') === 'http://user123:pa%3Ass@gw.dataimpulse.com:823', normalizeProxy('gw.dataimpulse.com:823:user123:pa:ss'));
  expect(normalizeProxy('http://u:p@1.2.3.4:8080') === 'http://u:p@1.2.3.4:8080', 'url form');
  expect(normalizeProxy('u:p@host.example:9000') === 'http://u:p@host.example:9000', 'user@host form');
  expect(normalizeProxy('host.example:9000') === 'http://host.example:9000', 'host:port');
  let threw = false;
  try { normalizeProxy('socks5://u:p@h:1080'); } catch { threw = true; }
  expect(threw, 'socks5 with auth should be refused');
  threw = false;
  try { normalizeProxy('not a proxy'); } catch { threw = true; }
  expect(threw, 'garbage should be refused');
});

await test('Proxy applies to all stores by default, or only the ones picked', async () => {
  const { setProxyUrl, proxyStatus } = await import('../src/accounts.js');
  const { proxyFor } = await import('../src/checkout/browser.js');
  setProxyUrl('gw.example.net:823:alice:s3cret');
  try {
    const st = proxyStatus();
    expect(st.set && st.server === 'http://gw.example.net:823' && !JSON.stringify(st).includes('s3cret'), `status ${JSON.stringify(st)}`);
    const all = proxyFor('walmart', { proxy_stores: null });
    expect(all?.server === 'http://gw.example.net:823' && all.username === 'alice' && all.password === 's3cret', JSON.stringify(all));
    expect(proxyFor('target', { proxy_stores: ['pokemon-center'] }) === undefined, 'target should go direct');
    expect(proxyFor('pokemon-center', { proxy_stores: ['pokemon-center'] })?.username === 'alice', 'PC should use proxy');
  } finally {
    setProxyUrl('');
  }
  expect(!proxyStatus().set, 'proxy should be removed');
});

await test('Watch tab blocks images via Chrome (cache stays on); checkout tab loads them', async () => {
  const { monitorPage, newPage: np } = await import('../src/session.js');
  const before = seen.length;
  const mp = await monitorPage('walmart');
  await getAdapter('walmart').check(mp, P('walmart', '111'), ctxFor());
  expect(!seen.slice(before).some(u => u.includes('/img/etb-photo.png')), 'monitor tab loaded the image');
  const cp = await np('walmart');
  await cp.goto('https://www.walmart.com/ip/Pokemon-ETB/111');
  await cp.waitForTimeout(500);
  await cp.close();
  expect(seen.slice(before).some(u => u.includes('/img/etb-photo.png')), 'checkout tab should load images');
});

await test('Data meter counts bytes per store and per activity (watching vs checkout vs search)', async () => {
  const { bandwidthStatus } = await import('../src/bandwidth.js');
  const bw = bandwidthStatus(new Set(['walmart']));
  const wm = bw.stores.walmart;
  expect(wm && wm.monitor > 0 && wm.flow > 0 && wm.discovery > 0, `walmart usage ${JSON.stringify(wm)}`);
  expect(wm.via_proxy === true && bw.stores.target?.via_proxy === false, 'proxy attribution');
  expect(bw.proxy_today === wm.total && bw.total_today >= bw.proxy_today, `totals ${bw.total_today} / ${bw.proxy_today}`);
  expect(bw.days.length >= 1 && bw.days.at(-1).total === bw.total_today, 'daily history');
});


// ── Data saving: light checks + daily limit ──
await test('Light check reads stock from page data (schema.org, Walmart, Best Buy) and spots queues/captchas', async () => {
  const ld = (avail) => `<html><script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"ETB","offers":{"@type":"Offer","price":"49.99","availability":"https://schema.org/${avail}"}}</script>${'x'.repeat(200000)}</html>`;
  const P0 = (body, extra = {}) => parseAvailability({ status: 200, url: 'https://www.walmart.com/ip/x/1', body, ...extra });
  let r = P0(ld('InStock'));
  expect(r.status === 'in_stock' && r.price === '$49.99' && r.signal === 'schema.org', JSON.stringify(r));
  expect(P0(ld('OutOfStock')).status === 'oos', 'OutOfStock');
  expect(P0(ld('InStoreOnly')).status === 'oos', 'InStoreOnly = not buyable online');
  expect(P0(ld('PreOrder')).status === 'in_stock', 'PreOrder');
  const big = 'y'.repeat(200000);
  expect(P0(`{"availabilityStatus":"OUT_OF_STOCK"}${big}`).status === 'oos', 'walmart oos');
  expect(P0(`{"availabilityStatus":"IN_STOCK"}${big}`).status === 'in_stock', 'walmart in');
  expect(P0(`{"availabilityStatus":"UNAVAILABLE"}${big}`).status === 'oos', 'UNAVAILABLE must not read as in stock');
  expect(P0(`{"buttonState":"SOLD_OUT"}${big}`).status === 'oos', 'bb sold out');
  expect(P0(`<button>Enter drawing</button>${big}`).status === 'maybe', 'drawing → confirm');
  expect(P0('<h1>You are now in line</h1>').status === 'queue', 'queue page');
  expect(P0('x', { url: 'https://pokemon.queue-it.net/?c=x' }).status === 'queue', 'queue url');
  expect(P0('<div id="px-captcha"></div> Press & Hold').status === 'blocked', 'captcha');
  expect(P0('', { status: 429 }).status === 'blocked', '429');
  expect(P0(`<html>${big}</html>`).status === 'unknown', 'no data → unknown');
});

await test('Light checks go through the store session\'s proxy (with the browser\'s user-agent) and are metered', async () => {
  const { setProxyUrl } = await import('../src/accounts.js');
  const { closeSession } = await import('../src/session.js');
  const { liteFetch } = await import('../src/lite.js');
  const { bandwidthStatus } = await import('../src/bandwidth.js');
  const { connect } = await import('net');
  // Fake store server, reachable only through the fake proxy's tunnel.
  const viaProxy = [];
  const origin = createServer((req, res) => {
    viaProxy.push({ url: `http://${req.headers.host}${req.url}`, ua: req.headers['user-agent'] || '' });
    res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html>ok</html>');
  });
  await new Promise(r => origin.listen(0, '127.0.0.1', r));
  const tunnels = [];
  const proxy = createServer((req, res) => { // plain proxied requests
    viaProxy.push({ url: req.url, ua: req.headers['user-agent'] || '' });
    res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html>ok</html>');
  });
  proxy.on('connect', (req, client) => { // CONNECT tunnels → fake store
    tunnels.push(req.url);
    const up = connect(origin.address().port, '127.0.0.1', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      up.pipe(client); client.pipe(up);
    });
    up.on('error', () => client.destroy()); client.on('error', () => up.destroy());
  });
  await new Promise(r => proxy.listen(0, '127.0.0.1', r));
  await closeSession('sams-club');
  setProxyUrl(`127.0.0.1:${proxy.address().port}`);
  liteHooks.fetch = null;
  const before = bandwidthStatus().stores['sams-club']?.monitor || 0;
  try {
    const r = await liteFetch('sams-club', 'http://shop.example/ip/pokemon-tin/prod999');
    expect(r.status === 200 && r.body.includes('ok'), `status ${r.status}`);
  } finally {
    liteHooks.fetch = NO_NET;
    setProxyUrl('');
    await closeSession('sams-club');
    proxy.close(); origin.close();
  }
  expect(tunnels.some(t => t.startsWith('shop.example')), `proxy tunnels: ${JSON.stringify(tunnels)}`);
  expect(viaProxy.some(x => x.url === 'http://shop.example/ip/pokemon-tin/prod999'), `proxy saw ${JSON.stringify(viaProxy)}`);
  expect(viaProxy.every(x => /Chrome\//.test(x.ua) && !/Playwright/i.test(x.ua)), `user-agent ${viaProxy[0]?.ua}`);
  expect((bandwidthStatus().stores['sams-club']?.monitor || 0) > before, 'light fetch not metered');
});

await test('Lite watching: out of stock = no Chrome load; in stock = confirmed in Chrome; unclear = Chrome only when due', async () => {
  const ldPage = (avail) => `<script type="application/ld+json">{"@type":"Product","offers":{"availability":"https://schema.org/${avail}","price":"69.99"}}</script>${'z'.repeat(160000)}`;
  const lite = [];
  liteHooks.fetch = async (_r, url) => {
    lite.push(url);
    if (url.includes('4000111')) return { status: 200, url, headers: {}, body: ldPage('OutOfStock') };
    if (url.includes('/ip/Pokemon-ETB/111')) return { status: 200, url, headers: {}, body: `{"availabilityStatus":"IN_STOCK"}${'z'.repeat(160000)}` };
    return { status: 200, url, headers: {}, body: `<html>${'z'.repeat(160000)}</html>` }; // no stock info
  };
  const products = baseConfig.products.filter(p => ['costco', 'walmart'].includes(p.retailer) || p.tcin === '999').filter(p => !String(p.url).includes('222'));
  writeConfig({ dry_run: true, enabled: false }, { products, monitor: { watch_mode: 'lite', full_check_minutes: 15 } });
  const t0 = seen.length;
  startMonitors();
  const ok = await until(() => productState.get('costco:4000111')?.via?.startsWith('light') && productState.get('walmart:111')?.via === 'full', 30000);
  await sleep(2500);
  stopMonitors();
  await sleep(1500);
  liteHooks.fetch = NO_NET;
  writeConfig();
  const loaded = seen.slice(t0);
  expect(ok, `states: ${['costco:4000111', 'walmart:111', 'target:999'].map(k => `${k}=${productState.get(k)?.status}/${productState.get(k)?.via}`).join(' ')}`);
  expect(productState.get('costco:4000111').status === 'oos', 'costco should be oos from light check');
  expect(!loaded.some(u => u.includes('4000111')), 'costco should never load in Chrome');
  expect(loaded.some(u => u.includes('/ip/Pokemon-ETB/111')), 'walmart in-stock should be confirmed in Chrome');
  expect(!loaded.some(u => u.includes('/A-999')), 'target unclear + full check not due → no Chrome load');
  expect(lite.some(u => u.includes('A-999')), 'target should still be light-checked');
});

await test('Daily proxy data limit pauses the bot, a manual resume sticks, and it auto-resumes the next day', async () => {
  const { setProxyUrl } = await import('../src/accounts.js');
  const { addBytes } = await import('../src/bandwidth.js');
  const { dataGuard } = await import('../src/monitor.js');
  const { setPaused, pauseStatus } = await import('../src/pause.js');
  const { readFileSync } = await import('fs');
  setProxyUrl('127.0.0.1:9');
  try {
    writeConfig({}, { monitor: { daily_proxy_limit_mb: 1 } });
    addBytes('walmart', 'monitor', 2 * 1024 * 1024);
    await dataGuard();
    let st = pauseStatus();
    expect(st.paused && st.reason === 'data_limit', `after limit: ${JSON.stringify(st)}`);
    expect(await until(() => sent('health', 'proxy data reached'), 3000), 'limit alert');
    await setPaused(false); // you resume by hand
    await dataGuard();
    expect(!pauseStatus().paused, 'should not re-pause the same day after a manual resume');
    // Next day: yesterday's automatic pause lifts by itself.
    const c = yaml.load(readFileSync(CONFIG, 'utf8'));
    Object.assign(c, { paused: true, paused_reason: 'data_limit', data_limit_hit_day: '2000-01-01' });
    writeFileSync(CONFIG, yaml.dump(c));
    await dataGuard();
    expect(!pauseStatus().paused, 'should auto-resume on a new day');
  } finally {
    setProxyUrl('');
    writeConfig();
  }
});

await test('Target: a full check learns the stock-data request; light checks then use it (few KB, no page)', async () => {
  const { parseTargetFulfillment } = await import('../src/retailers/target.js');
  const fj = (st) => `{"data":{"product":{"tcin":"1","fulfillment":{"store_options":[{"order_pickup":{"availability_status":"UNAVAILABLE"}}],"shipping_options":{"availability_status":"${st}","loyalty_availability_status":"${st}"}}}}}`;
  expect(parseTargetFulfillment(fj('IN_STOCK'))?.status === 'in_stock', 'IN_STOCK');
  expect(parseTargetFulfillment(fj('PRE_ORDER_SELLABLE'))?.status === 'in_stock', 'preorder');
  expect(parseTargetFulfillment(fj('OUT_OF_STOCK'))?.status === 'oos', 'OOS');
  expect(parseTargetFulfillment(fj('UNAVAILABLE'))?.status === 'oos', 'UNAVAILABLE');
  expect(parseTargetFulfillment('{"nope":1}') === null, 'no status → null');

  const { monitorPage } = await import('../src/session.js');
  const { liteCheck } = await import('../src/lite.js');
  const { forgetTargetLearning, isTargetLearned, targetDebug } = await import('../src/retailers/target.js');
  const { existsSync, readFileSync } = await import('fs');
  const target = getAdapter('target');
  forgetTargetLearning();
  // One full check (as the monitor does) → learns the request from the response that has the stock status.
  await target.check(await monitorPage('target'), P('target', '1010892078'), ctxFor());
  const learnedFile = join(process.env.DROPBOT_DATA_DIR, 'target-fulfillment.json');
  const learned = existsSync(learnedFile) && JSON.parse(readFileSync(learnedFile, 'utf8'));
  expect(isTargetLearned() && learned?.method === 'GET' && learned.url.includes('tcin={TCIN}'), `not learned: ${JSON.stringify(learned)}`);
  expect(targetDebug.seen.some(e => e.stock && e.tcin === 'url'), `debug list: ${JSON.stringify(targetDebug.seen)}`);
  const asked = [];
  liteHooks.fetch = async (_r, url, headers) => {
    asked.push({ url, accept: headers.accept });
    const st = url.includes('tcin=999') ? 'OUT_OF_STOCK' : 'IN_STOCK';
    return { status: 200, url, headers: { 'content-length': '900' }, body: fj(st) };
  };
  try {
    const oos = await liteCheck(target, P('target', '999'));
    const inn = await liteCheck(target, P('target', '1010892076'));
    expect(oos.status === 'oos' && inn.status === 'in_stock', `${JSON.stringify(oos)} ${JSON.stringify(inn)}`);
    // Replays the request the page made (same address + headers, e.g. the page's own Accept).
    expect(asked.length === 2 && asked.every(a => a.url.startsWith('https://redsky.target.com/') && a.accept), JSON.stringify(asked));
    expect(asked[0].url.includes('tcin=999') && asked[0].url.includes('page=%2Fp%2FA-999') && !asked[0].url.includes('1010892078'), `tcin not swapped: ${asked[0].url}`);
    // Expired key → forget and re-learn on the next full check.
    liteHooks.fetch = async (_r, url) => ({ status: 403, url, headers: {}, body: '' });
    const exp = await liteCheck(target, P('target', '999'));
    expect(exp.status === 'unknown' && exp.learning, JSON.stringify(exp));
    const again = await liteCheck(target, P('target', '999'));
    expect(again.signal === 'target-api-not-learned-yet', 'should wait for re-learning');

    // Target refusing a replay (435) → no more light requests for 24 h.
    await target.check(await monitorPage('target'), P('target', '1010892078'), ctxFor()); // re-learn
    let refusedCalls = 0;
    liteHooks.fetch = async (_r, url) => { refusedCalls++; return { status: 435, url, headers: {}, body: '' }; };
    const ref1 = await liteCheck(target, P('target', '999'));
    const ref2 = await liteCheck(target, P('target', '1010892076'));
    expect(ref1.signal === 'target-api-refused-http-435' && ref2.signal === 'target-light-refused-24h' && refusedCalls === 1,
      `refusal: ${JSON.stringify(ref1)} ${JSON.stringify(ref2)} calls=${refusedCalls}`);
    (await import('fs')).rmSync(join(process.env.DROPBOT_DATA_DIR, 'target-light-refused.json'), { force: true });
    const { resetTargetRefusal } = await import('../src/retailers/target.js');
    resetTargetRefusal();

    // A POST-style stock request (product id in the body, custom header) is learned and replayed too.
    scenario.targetPost = true;
    await target.check(await monitorPage('target'), P('target', '1010892078'), ctxFor());
    scenario.targetPost = false;
    const post = JSON.parse(readFileSync(learnedFile, 'utf8'));
    expect(post?.method === 'POST' && post.body.includes('{TCIN}') && post.headers['x-api-key'] === 'k123', `POST not learned: ${JSON.stringify(post)}`);
    const sentPost = [];
    liteHooks.fetch = async (_r, url, headers, opts) => {
      sentPost.push({ url, headers, opts });
      return { status: 200, url, headers: {}, body: fj('OUT_OF_STOCK') };
    };
    const viaPost = await liteCheck(target, P('target', '999'));
    expect(viaPost.status === 'oos', JSON.stringify(viaPost));
    const sp = sentPost[0];
    expect(sp.opts.method === 'POST' && sp.opts.body.includes('"tcin":"999"') && sp.headers['x-api-key'] === 'k123' && sp.url.endsWith('/api/v3/stock'), JSON.stringify(sp));
  } finally {
    scenario.targetPost = false;
    liteHooks.fetch = NO_NET;
  }
});

await test('Pause closes every store browser, stops all loading, and Resume brings watching back', async () => {
  const { setPaused, isPaused } = await import('../src/pause.js');
  const { openSessions } = await import('../src/session.js');
  writeConfig({ dry_run: true, enabled: true });
  await setPaused(true);
  expect(isPaused() && openSessions().length === 0, `sessions still open: ${openSessions()}`);
  const before = seen.length;
  startMonitors();
  onObserved(P('costco', '4000111'), { status: 'in_stock', price: '$69.99' }); // would normally start a flow
  await sleep(5000);
  expect(seen.length === before, `pages loaded while paused (${seen.length - before})`);
  expect(openSessions().length === 0, `browsers opened while paused: ${openSessions()}`);
  await setPaused(false);
  writeConfig({ dry_run: true, enabled: false }); // resume watching only (no flows) for the check
  const t0 = Date.now();
  const back = await until(() => [...productState.values()].some(st => st.last_checked > t0), 20000);
  stopMonitors();
  await sleep(1500);
  expect(back, 'watching did not resume');
});

await test('While paused you can still sign in and check accounts; the store browser closes again after', async () => {
  const { setPaused } = await import('../src/pause.js');
  const { openSessions } = await import('../src/session.js');
  const { checkLogin } = await import('../src/live.js');
  await setPaused(true);
  try {
    scenario.walmartLoggedIn = false;
    const id = await openLoginSession('walmart');
    expect(openSessions().includes('walmart') && (await liveFrame(id))?.kind === 'login', 'sign-in should open while paused');
    scenario.walmartLoggedIn = true; // as if you signed in via Live view
    const ok = await closeLoginSession(id, { check: true });
    expect(ok === true, `sign-in check → ${ok}`);
    expect(!openSessions().includes('walmart'), `browser left open while paused: ${openSessions()}`);
    expect(await checkLogin('walmart') === true, 'account check while paused');
    expect(openSessions().length === 0, `browsers left open after check: ${openSessions()}`);
  } finally {
    await setPaused(false);
  }
});

await test('Live view press & hold: mouse stays down until released (for "Press & hold" checks)', async () => {
  const id = await openLoginSession('walmart');
  try {
    expect((await liveInput(id, { type: 'goto', url: '/hold-check' })).ok, 'goto');
    const sess = (await (await import('../src/session.js')).getSession('walmart')).context.pages().find(p => p.url().includes('/hold-check'));
    const frame = await liveFrame(id);
    const b = await sess.locator('#h').boundingBox();
    const at = { x: (b.x + b.width / 2) / frame.width, y: (b.y + b.height / 2) / frame.height };
    expect((await liveInput(id, { type: 'down', ...at })).ok, 'down');
    await sleep(1600);
    expect(await sess.locator('#msg').textContent() === 'holding', 'should still be holding');
    expect((await liveInput(id, { type: 'up' })).ok, 'up');
    const msg = await sess.locator('#msg').textContent();
    const held = parseFloat(msg.replace('held ', ''));
    expect(held >= 1.5 && held < 3, `held for ${msg}`);
  } finally {
    await closeLoginSession(id, { check: false });
  }
});

console.log(`\n${passed} passed, ${failed} failed\n`);
await closeAll();
hookServer.close();
rmSync(TMP, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
