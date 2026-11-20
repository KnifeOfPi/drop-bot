// Target product monitor — stealth browser scraping
// PerimeterX blocks the RedSky API from most IPs, so we use Playwright +
// residential proxy to load product pages and extract stock data from the
// client-side rendered DOM (same approach as Pokemon Center).
//
// Uses the existing Hermes stealth browser infra at
// ~/.hermes/skills/web-automation/stealth-browser/scripts/lib.mjs

import { getProductsByRetailer } from '../config.js';
import { sendDropAlert } from '../discord.js';
import { homedir } from 'os';
import { join } from 'path';

// Track previous state to detect changes
const stateCache = new Map();

// ── Stealth browser helpers ────────────────────────────────────────────────

async function getStealthPage() {
  const libPath = join(homedir(), '.hermes/skills/web-automation/stealth-browser/scripts/lib.mjs');
  const { launchStealth } = await import(libPath);
  const { browser, context, page } = await launchStealth({ headless: true });
  // We don't call solveCaptchaIfPresent here — Target product pages usually
  // don't show captcha unless the IP is burned. If they do, the page content
  // check will catch it.
  return { browser, page };
}

// ── Stock detection ─────────────────────────────────────────────────────────

/**
 * Parse the Target product page DOM for stock status.
 * Target uses client-side JS to populate the "Add to cart" button
 * and price. We check multiple DOM signals.
 */
async function extractStockData(page, tcin, url) {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000); // let client JS hydrate

    const data = await page.evaluate(() => {
      // Multiple signals for in-stock vs out-of-stock
      const body = document.body?.innerText || '';

      // Signal 1: "Add to cart" button that's actually enabled
      const addToCartBtn = document.querySelector('[data-test="shippingATCButton"], [data-test="pickupATCButton"], button:has-text("Add to cart")');
      const atcEnabled = addToCartBtn && !addToCartBtn.disabled;

      // Signal 2: Text-based indicators
      const soldOutText = /sold out|out of stock/i.test(body);
      const unavailableText = /currently unavailable|not available|coming soon/i.test(body);

      // Signal 3: Price
      const priceEl = document.querySelector('[data-test="product-price"], [class*="price"] span, .h-text-red');
      const price = priceEl?.textContent?.trim() || 'N/A';

      // Signal 4: Title
      const title = document.title?.replace(' : Target', '') || '';

      // Signal 5: "Notify me when available" = OOS
      const notifyBtn = document.querySelector('button:has-text("Notify me")');

      const inStock = (atcEnabled && !soldOutText && !unavailableText && !notifyBtn);

      return { inStock, price, title, atcEnabled, soldOutText, unavailableText, hasNotifyBtn: !!notifyBtn };
    });

    return {
      in_stock: data.inStock,
      title: data.title,
      price: data.price,
      url,
      tcin,
    };
  } catch (e) {
    return { error: e.message, in_stock: null, title: 'Unknown', price: 'N/A', url, tcin };
  }
}

// ── Change detection ────────────────────────────────────────────────────────

function hasChanged(tcin, current) {
  const prev = stateCache.get(tcin);
  if (!prev) {
    stateCache.set(tcin, current);
    return false;
  }
  const changed = prev.in_stock !== current.in_stock || prev.price !== current.price;
  stateCache.set(tcin, current);
  return changed;
}

// ── Public API ──────────────────────────────────────────────────────────────

export async function checkTarget(products) {
  const productList = products || getProductsByRetailer('target');
  if (productList.length === 0) return [];

  let browser = null;
  let page = null;

  try {
    ({ browser, page } = await getStealthPage());
  } catch (e) {
    console.error(`[target] Failed to launch stealth browser: ${e.message}`);
    return [];
  }

  const results = [];

  try {
    for (const product of productList) {
      const tcin = product.tcin;
      if (!tcin) continue;

      const url = `https://www.target.com/p/-/A-${tcin}`;
      const result = await extractStockData(page, tcin, url);
      results.push({ product, result });

      if (result.error) {
        console.log(`[target] ${product.label} (${tcin}): ${result.error}`);
        continue;
      }

      const changed = hasChanged(tcin, {
        in_stock: result.in_stock,
        price: result.price,
        lastSeen: Date.now(),
      });

      if (changed && result.in_stock) {
        console.log(`[target] 🟢 IN STOCK: ${result.title} — ${result.price}`);
        await sendDropAlert({
          retailer: 'target',
          label: result.title,
          url: result.url,
          sku: tcin,
          price: result.price,
          status: 'in_stock',
          timestamp: Date.now(),
        });
      }
    }
  } finally {
    if (browser) await browser.close().catch(() => {});
  }

  return results;
}

// Standalone test
if (process.argv[1]?.includes('target.js')) {
  console.log('[target] Running standalone test...');
  const products = getProductsByRetailer('target');
  console.log(`[target] Monitoring ${products.length} products`);
  const results = await checkTarget(products);
  for (const r of results) {
    if (r.result.error) {
      console.log(`  ${r.product.label}: ❌ ${r.result.error}`);
    } else {
      console.log(`  ${r.product.label}: ${r.result.in_stock ? '🟢 IN STOCK' : '🔴 OOS'} — ${r.result.price}`);
    }
  }
}