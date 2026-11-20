// Pokémon Center product monitor — stealth browser + captcha
// Pokemon Center uses DataDome + Imperva — requires Playwright + residential proxy + 2Captcha.
// Falls back gracefully if the stealth browser fails (logs error, doesn't crash).

import { getProductsByRetailer } from '../config.js';
import { sendDropAlert } from '../discord.js';
import { homedir } from 'os';
import { join } from 'path';

// Track state
const stateCache = new Map();
const queueState = { is_open: false, lastChecked: 0 };

// ── Stealth browser helpers ────────────────────────────────────────────────

async function getStealthPage() {
  // Reuse the existing stealth browser infra from Hermes
  const libPath = join(homedir(), '.hermes/skills/web-automation/stealth-browser/scripts/lib.mjs');
  const { launchStealth, solveCaptchaIfPresent } = await import(libPath);

  const { browser, context, page } = await launchStealth({ headless: true });
  return { browser, page, solveCaptchaIfPresent };
}

// ── Product monitoring ─────────────────────────────────────────────────────

async function checkPokemonCenterProduct(page, url, label) {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2000);

    // Check for DataDome captcha
    const captchaPresent = await page.evaluate(() => {
      return !!document.querySelector('[id*="captcha"], [class*="captcha"], iframe[src*="captcha"]') ||
             document.body?.innerText?.includes('verify you are human');
    });

    if (captchaPresent) {
      console.log(`[pokecenter] Captcha detected for ${label}, attempting solve...`);
      // The solveCaptchaIfPresent from lib.mjs handles this
    }

    // Extract product info
    const data = await page.evaluate(() => {
      const title = document.querySelector('h1, [class*="title"], [class*="product-name"]')?.textContent?.trim() || '';
      const price = document.querySelector('[class*="price"], .price, [data-testid="price"]')?.textContent?.trim() || '';
      const addToCart = document.querySelector('button[class*="add-to-cart"], button:has-text("Add to cart"), [data-testid="add-to-cart"]');
      const soldOut = document.body?.innerText?.includes('sold out') || document.body?.innerText?.includes('unavailable');
      const inStock = !!addToCart && !soldOut;
      return { title, price, inStock, soldOut };
    });

    return {
      in_stock: data.inStock,
      title: data.title || label,
      price: data.price || 'N/A',
      url,
    };
  } catch (e) {
    return { error: e.message, in_stock: null, title: label, price: 'N/A', url };
  }
}

async function checkQueueStatus(page) {
  try {
    await page.goto('https://www.pokemoncenter.com/', {
      waitUntil: 'domcontentloaded', timeout: 15000
    });
    await page.waitForTimeout(2000);

    const hasQueue = await page.evaluate(() => {
      return document.body?.innerText?.includes('waiting room') ||
             document.body?.innerText?.includes('in line') ||
             !!document.querySelector('[class*="queue"], [id*="queue"]');
    });

    return { hasQueue };
  } catch (e) {
    return { hasQueue: false, error: e.message };
  }
}

// ── Public API ──────────────────────────────────────────────────────────────

export async function checkPokemonCenter(products) {
  const productList = products || getProductsByRetailer('pokemon-center');
  if (productList.length === 0) return [];

  let browser = null;
  let page = null;

  try {
    ({ browser, page } = await getStealthPage());
  } catch (e) {
    console.error(`[pokecenter] Failed to launch stealth browser: ${e.message}`);
    console.error(`[pokecenter] Skipping PC checks this cycle — will retry`);
    return [];
  }

  const results = [];

  try {
    // 1. Check queue status (less frequent)
    const now = Date.now();
    if (now - queueState.lastChecked > 15000) {
      const q = await checkQueueStatus(page);
      queueState.lastChecked = now;

      if (q.hasQueue && !queueState.is_open) {
        console.log('[pokecenter] 🔵 QUEUE OPEN');
        queueState.is_open = true;
        await sendDropAlert({
          retailer: 'pokemon-center',
          label: 'Queue Is Open',
          url: 'https://www.pokemoncenter.com/',
          sku: 'queue',
          price: 'N/A',
          status: 'queue_open',
          timestamp: Date.now(),
        });
      } else if (!q.hasQueue && queueState.is_open) {
        console.log('[pokecenter] Queue closed');
        queueState.is_open = false;
      }
    }

    // 2. Check products
    for (const product of productList) {
      if (!product.url) continue;

      const result = await checkPokemonCenterProduct(page, product.url, product.label);
      results.push({ product, result });

      if (result.error) {
        console.log(`[pokecenter] ${product.label}: ${result.error}`);
        continue;
      }

      const prev = stateCache.get(product.url);
      const changed = prev?.in_stock !== result.in_stock || prev?.price !== result.price;
      stateCache.set(product.url, result);

      if (changed && result.in_stock) {
        console.log(`[pokecenter] 🟢 IN STOCK: ${result.title} — ${result.price}`);
        await sendDropAlert({
          retailer: 'pokemon-center',
          label: result.title,
          url: result.url,
          sku: product.url.split('/').pop() || product.url,
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
if (process.argv[1]?.includes('pokemon-center.js')) {
  console.log('[pokecenter] Running standalone test...');
  const products = getProductsByRetailer('pokemon-center');
  console.log(`[pokecenter] Monitoring ${products.length} products`);
  const results = await checkPokemonCenter(products);
  for (const r of results) {
    if (r.result.error) {
      console.log(`  ${r.product.label}: ❌ ${r.result.error}`);
    } else {
      console.log(`  ${r.product.label}: ${r.result.in_stock ? '🟢 IN STOCK' : '🔴 OOS'} — ${r.result.price}`);
    }
  }
}