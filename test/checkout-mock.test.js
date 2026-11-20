#!/usr/bin/env node
// Offline checkout test — runs the real Target / Best Buy / Pokémon Center
// flows and the engine's safety guards against MOCK retailer pages served by
// Playwright request interception. No real site is contacted, nothing is bought,
// and your config.yaml / data/orders.json are not touched (temp copies are used).
//
//   npm run test-checkout
//
// Needs Chrome/Chromium (same resolution as checkout: CHECKOUT_BROWSER_PATH or installed Chrome).

import { mkdtempSync, writeFileSync, rmSync } from 'fs';
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

const baseConfig = {
  discord: { drop_alerts: '', checkout_success: '', checkout_fail: '', health: '' },
  products: [
    { retailer: 'target', tcin: '1010892076', label: 'T ETB', max_price: 69.99, auto_checkout: true },
    { retailer: 'target', tcin: '1010892077', label: 'T Bundle (hangs)', max_price: 39.99, auto_checkout: true },
    { retailer: 'target', tcin: '1010892078', label: 'T UPC', max_price: 199.99, auto_checkout: true },
    { retailer: 'target', tcin: '999', label: 'T OOS', max_price: 50, auto_checkout: true },
    { retailer: 'best-buy', sku: '6580529', label: 'BB ETB', max_price: 69.99, auto_checkout: true },
    { retailer: 'best-buy', sku: '6580530', label: 'BB Bundle (kill switch)', max_price: 39.99, auto_checkout: true },
    { retailer: 'pokemon-center', url: 'https://www.pokemoncenter.com/product/699-18442', label: 'PC ETB', max_price: 69.99, auto_checkout: true },
    { retailer: 'pokemon-center', url: 'https://www.pokemoncenter.com/product/699-18443', label: 'PC unarmed', max_price: 39.99, auto_checkout: false },
  ],
  checkout: {
    enabled: true, dry_run: true, headless: true,
    max_orders_per_product: 1, max_total_spend: 1000, max_total_overage_pct: 20,
    retry_cooldown_seconds: 1, step_timeout_seconds: 3, queue_wait_minutes: 1,
    profile_dir: join(TMP, 'profiles'),
  },
};
const writeConfig = (patch = {}) => {
  const c = structuredClone(baseConfig);
  Object.assign(c.checkout, patch);
  writeFileSync(CONFIG, yaml.dump(c));
};
writeConfig();

// Imports AFTER env + config are in place.
const { hooks } = await import('../src/checkout/browser.js');
const { runCheckout, findProduct, onStockObserved, getCheckoutStatus } = await import('../src/checkout/index.js');

// ── Mock retailer pages ─────────────────────────────────────────────────────
const scenario = { bbTotal: '73.50', onCheckoutPage: null };
const seen = [];
const page = (body) => `<!doctype html><html><head><title>mock</title></head><body>${body}</body></html>`;

function mock(url) {
  const u = new URL(url);
  const p = u.pathname;
  // Target
  if (u.host === 'www.target.com') {
    if (p === '/p/-/A-999') return page(`<h1>OOS item</h1><p>Out of stock</p><button>Notify me when it's back</button>`);
    if (p.startsWith('/p/-/A-')) return page(`<h1>Item</h1><span>$69.99</span>
      <button data-test="shippingButton" onclick="document.getElementById('m').textContent='Added to cart'">Ship it</button><div id="m"></div>`);
    if (p === '/checkout') {
      const hang = scenario.targetHang;
      const total = scenario.targetTotal || '74.21';
      return page(`<h1>Checkout</h1><label>CVV <input id="creditCardInput-cvv"></label>
        <div>Order total</div><div>$${total}</div>
        <button data-test="placeOrderButton" onclick="${hang ? '' : `location.href='/order-confirmation?cvv='+document.getElementById('creditCardInput-cvv').value`}">Place your order</button>`);
    }
    if (p === '/order-confirmation') return page(`<h1>Thanks for your order!</h1><p>Order number: 912000123456</p>`);
  }
  // Best Buy
  if (u.host === 'www.bestbuy.com') {
    if (p.startsWith('/site/')) return page(`<h1>BB item</h1>
      <button class="add-to-cart-button" data-button-state="ADD_TO_CART" id="b">Add to Cart</button><div id="m"></div>
      <script>let n=0;const b=document.getElementById('b');b.onclick=()=>{n++;if(n===1){b.textContent='Please Wait...';b.disabled=true;
      b.setAttribute('data-button-state','PLEASE_WAIT');setTimeout(()=>{b.disabled=false;b.textContent='Add to Cart';
      b.setAttribute('data-button-state','ADD_TO_CART')},1500)}else{document.getElementById('m').textContent='Added to cart'}}</script>`);
    if (p === '/checkout/r/fast-track') {
      scenario.onCheckoutPage?.();
      return page(`<h1>Checkout</h1><input id="cvv"><div>Order Total $${scenario.bbTotal}</div>
        <button class="button__fast-track" onclick="location.href='/checkout/r/thank-you?cvv='+document.getElementById('cvv').value">Place Your Order</button>`);
    }
    if (p === '/checkout/r/thank-you') return page(`<h1>Thank you for your order.</h1><p>Order number: BBY01-806123</p>`);
  }
  // Pokémon Center
  if (u.host === 'www.pokemoncenter.com') {
    if (p.startsWith('/product/')) return page(`<h1>PC item</h1><button onclick="document.getElementById('m').textContent='Added to cart'">Add to Cart</button><div id="m"></div>`);
    if (p === '/cart') return page(`<h1>Cart</h1><a href="/checkout/shipping">Checkout</a>`);
    if (p === '/checkout/shipping') return page(`<h1>Shipping</h1><button onclick="location.href='/checkout/payment'">Continue to Payment</button>`);
    if (p === '/checkout/payment') return page(`<h1>Payment</h1><input name="cvv" id="c"><button onclick="location.href='/checkout/review?cvv='+document.getElementById('c').value">Review Order</button>`);
    if (p === '/checkout/review') return page(`<h1>Review</h1><div>Order Total: $75.10</div><button onclick="location.href='/order-confirmation'">Place Order</button>`);
    if (p === '/order-confirmation') return page(`<h1>Thank you for your order!</h1><p>Order number: P00012345</p>`);
  }
  return null;
}

hooks.onContext = async (context) => {
  await context.route('**/*', (route) => {
    const url = route.request().url();
    seen.push(url);
    const html = mock(url);
    if (html) return route.fulfill({ status: 200, contentType: 'text/html', body: html });
    return route.fulfill({ status: 204, body: '' }); // never hit the network
  });
};

// ── Tests ───────────────────────────────────────────────────────────────────
let passed = 0, failed = 0;
async function test(name, fn) {
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

console.log('\nCheckout mock tests\n');

await test('Target dry run stops at Place order and reads total', async () => {
  const r = await runCheckout(P('target', '1010892076'), { dryRun: true });
  expect(r.status === 'dry_run', `status ${r.status} ${r.error || ''}`);
  expect(r.total === 74.21, `total ${r.total}`);
  expect(!seen.some(u => u.includes('order-confirmation')), 'dry run must not click Place order');
});

await test('Live run is refused while config says dry_run (last-moment re-check)', async () => {
  const r = await runCheckout(P('target', '1010892076'), { dryRun: false });
  expect(r.status === 'guard', `status ${r.status}`);
});

writeConfig({ dry_run: false });

await test('Target live checkout succeeds, enters CVV, captures order #', async () => {
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

await test('Order total above max_price + headroom → blocked before clicking', async () => {
  scenario.bbTotal = '150.00';
  const r = await runCheckout(P('best-buy', '6580529'), { dryRun: false });
  scenario.bbTotal = '73.50';
  expect(r.status === 'guard' && /order total/.test(r.error), `${r.status} ${r.error}`);
  expect(!seen.some(u => u.includes('thank-you')), 'must not place order');
});

await test('Best Buy "Please Wait" queue → waits, re-clicks, orders', async () => {
  const r = await runCheckout(P('best-buy', '6580529'), { dryRun: false });
  expect(r.status === 'success', `status ${r.status} ${r.error || ''}`);
  expect(r.order_number === 'BBY01-806123', `order ${r.order_number}`);
  expect(seen.some(u => u.includes('thank-you?cvv=456')), 'CVV not entered');
});

await test('Kill switch flipped mid-checkout → aborts before Place order', async () => {
  scenario.onCheckoutPage = () => writeConfig({ dry_run: false, enabled: false });
  scenario.bbTotal = '42.50';
  const r = await runCheckout(P('best-buy', '6580530'), { dryRun: false });
  scenario.onCheckoutPage = null;
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

await test('Spend cap blocks before opening a browser', async () => {
  writeConfig({ dry_run: false, max_total_spend: 100 });
  const before = seen.length;
  const r = await runCheckout(P('target', '1010892078'), { dryRun: false });
  writeConfig({ dry_run: false });
  expect(r.status === 'guard' && /spend cap/.test(r.error), `${r.status} ${r.error}`);
  expect(seen.length === before, 'should not have loaded any page');
});

await test('Auto trigger ignores unarmed products, disabled checkout, and over-price', async () => {
  const before = seen.length;
  onStockObserved(P('pokemon-center', '699-18443'), { price: '$39.99' });  // unarmed
  onStockObserved(P('target', '1010892078'), { price: '$250.00' });        // > max_price
  writeConfig({ dry_run: false, enabled: false });
  onStockObserved(P('target', '1010892078'), { price: '$199.99' });        // disabled
  await sleep(1500);
  writeConfig({ dry_run: false });
  expect(seen.length === before, `pages were loaded (${seen.length - before})`);
});

await test('Auto trigger fires a checkout when armed + in stock', async () => {
  writeConfig({ dry_run: true });
  onStockObserved(P('target', '1010892078'), { price: '$199.99' });
  await sleep(300);
  expect(getCheckoutStatus().busy.target, 'should be busy');
  for (let i = 0; i < 60 && getCheckoutStatus().busy.target; i++) await sleep(250);
  const last = getCheckoutStatus().recent[0];
  expect(last.key === 'target:1010892078' && last.status === 'dry_run', `${last.key} ${last.status} ${last.error || ''}`);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
rmSync(TMP, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
