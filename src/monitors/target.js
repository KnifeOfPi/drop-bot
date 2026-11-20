// Target product monitor — stealth browser scraping
//
// Target requires authentication to show Add to Cart buttons on product pages,
// so full stock detection via DOM isn't feasible without login. Instead we use
// a pragmatic approach:
//
//   1. Load the product page — if it redirects or 404s, the TCIN is dead.
//   2. Check for OOS signals: "Sold out", "Out of stock", "Notify me" button.
//   3. Check for "Add to cart" / "Ship it" (rare without auth, but some show it).
//   4. Fall back to UNKNOWN for pre-release products that have no signals.
//
// Uses the Hermes stealth browser infra:
//   ~/.hermes/skills/web-automation/stealth-browser/scripts/lib.mjs

import { getProductsByRetailer } from '../config.js';
import { sendDropAlert } from '../discord.js';
import { homedir } from 'os';
import { join } from 'path';

const stateCache = new Map();

async function getStealthPage() {
  const libPath = join(homedir(), '.hermes/skills/web-automation/stealth-browser/scripts/lib.mjs');
  const { launchStealth } = await import(libPath);
  const { browser, page } = await launchStealth({ headless: true });
  return { browser, page };
}

async function extractStockData(page, tcin, url) {
  try {
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });

    // If TCIN doesn't exist — redirect or 4xx
    const finalUrl = page.url();
    if (!finalUrl.includes(tcin) || (response && response.status() >= 400)) {
      return {
        in_stock: false,
        title: 'Not found',
        price: 'N/A',
        error: `Redirected/removed (status: ${response?.status()})`,
        url, tcin,
      };
    }

    await page.waitForTimeout(2000);

    const data = await page.evaluate(() => {
      const body = document.body?.innerText || '';

      // Signal 1: "Add to cart" / "Ship it" button (visible + enabled)
      let atcEnabled = false;
      const allButtons = document.querySelectorAll('button');
      for (const b of allButtons) {
        const text = (b.textContent || '').toLowerCase().trim();
        if ((text.includes('add to cart') || text.startsWith('add for') || text === 'ship it') &&
            !b.disabled && b.offsetParent !== null) {
          atcEnabled = true;
          break;
        }
      }

      // Signal 2: "Notify me" = OOS
      let hasNotifyBtn = false;
      for (const b of allButtons) {
        const text = (b.textContent || '').toLowerCase();
        if (text.includes('notify me') && b.offsetParent !== null) {
          hasNotifyBtn = true;
          break;
        }
      }

      // Signal 3: Text indicators
      const soldOutText = /\bsold out\b/i.test(body);
      const outOfStockText = /\bout of stock\b/i.test(body);

      // Signal 4: Price
      const dollarMatch = body.match(/\$(\d+\.?\d*)/);
      const price = dollarMatch ? dollarMatch[0] : 'N/A';

      // Signal 5: Title
      const title = (document.title || '').replace(' : Target', '').trim();

      let inStock = null;
      if (atcEnabled) {
        inStock = true;
      } else if (soldOutText || outOfStockText || hasNotifyBtn) {
        inStock = false;
      }

      return { inStock, price, title, atcEnabled, soldOutText, outOfStockText, hasNotifyBtn };
    });

    return {
      in_stock: data.inStock,
      title: data.title,
      price: data.price,
      url, tcin,
    };
  } catch (e) {
    return { error: e.message, in_stock: null, title: 'Unknown', price: 'N/A', url, tcin };
  }
}

function hasChanged(tcin, current) {
  const prev = stateCache.get(tcin);
  if (!prev) { stateCache.set(tcin, current); return false; }
  const changed = prev.in_stock !== current.in_stock || prev.price !== current.price;
  stateCache.set(tcin, current);
  return changed;
}

export async function checkTarget(products) {
  const productList = products || getProductsByRetailer('target');
  if (productList.length === 0) return [];

  let browser = null, page = null;
  try {
    ({ browser, page } = await getStealthPage());
  } catch (e) {
    console.error(`[target] Stealth browser launch failed: ${e.message}`);
    return [];
  }

  const results = [];
  try {
    for (const product of productList) {
      const tcin = product.tcin;
      if (!tcin) continue;

      const url = `https://www.target.com/p/-/A-${tcin}`;
      const start = Date.now();
      const result = await extractStockData(page, tcin, url);
      const elapsed = Date.now() - start;

      results.push({ product, result });

      if (result.error) {
        console.log(`[target] ${product.label}: ⚠️ ${result.error} (${elapsed}ms)`);
        continue;
      }

      const emoji = result.in_stock === true ? '🟢' : result.in_stock === false ? '🔴' : '⚪';
      const status = result.in_stock === true ? 'IN STOCK' : result.in_stock === false ? 'OOS' : 'UNKNOWN';
      console.log(`[target] ${result.title || product.label}: ${emoji} ${status} — ${result.price} (${elapsed}ms)`);

      const changed = hasChanged(tcin, {
        in_stock: result.in_stock,
        price: result.price,
        lastSeen: Date.now(),
      });

      if (changed && result.in_stock) {
        console.log(`[target] 🚨 STOCK CHANGE: ${result.title} — ${result.price}`);
        await sendDropAlert({
          retailer: 'target', label: result.title, url: result.url,
          sku: tcin, price: result.price, status: 'in_stock', timestamp: Date.now(),
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
      const s = r.result.in_stock === true ? '🟢 IN STOCK' : r.result.in_stock === false ? '🔴 OOS' : '⚪ UNKNOWN';
      console.log(`  ${r.product.label}: ${s} — ${r.result.price}`);
    }
  }
}