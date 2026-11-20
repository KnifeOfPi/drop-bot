// Best Buy product monitor — BB API
// Watches SKUs for price/availability changes.

import { getProductsByRetailer } from '../config.js';
import { sendDropAlert } from '../discord.js';

const BB_API = 'https://www.bestbuy.com/api/3.0/priceBlocks';

// Track previous state
const stateCache = new Map();

async function checkSkus(skus) {
  const url = `${BB_API}?skus=${skus.join(',')}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Accept': 'application/json',
        'Accept-Language': 'en-US,en;q=0.9',
        'Origin': 'https://www.bestbuy.com',
        'Referer': 'https://www.bestbuy.com/',
      },
    });
    clearTimeout(timeout);

    if (res.status === 429) return { status: 429, error: 'rate_limited' };
    if (!res.ok) return { status: res.status, error: `HTTP ${res.status}` };

    const data = await res.json();
    return { status: 200, data };
  } catch (e) {
    clearTimeout(timeout);
    return { status: 0, error: e.message };
  }
}

function parseSkuResult(skuData) {
  if (!skuData || Array.isArray(skuData)) return null;
  const s = skuData.sku;
  // Inactive SKU = product not yet listed, treat as OOS (not an error)
  if (s?.error && s.error.includes('PRODUCT_SKU_INACTIVE')) {
    return { available: false, price: 'N/A', inactive: true };
  }
  if (s?.error || !s?.skuId) return { available: false, price: 'N/A', error: s?.error || 'unknown' };

  return {
    available: s.regularPrice !== undefined && s.regularPrice > 0,
    price: s.currentPrice ? `$${(s.currentPrice).toFixed(2)}` : (s.regularPrice ? `$${(s.regularPrice).toFixed(2)}` : 'N/A'),
    priceRaw: s.currentPrice || s.regularPrice || 0,
    sku: s.skuId,
  };
}

function hasChanged(sku, current) {
  const prev = stateCache.get(sku);
  if (!prev) {
    stateCache.set(sku, current);
    return false;
  }
  const changed = prev.available !== current.available || prev.price !== current.price;
  stateCache.set(sku, current);
  return changed;
}

export async function checkBestBuy(products) {
  const productList = products || getProductsByRetailer('best-buy');
  if (productList.length === 0) return [];

  const skus = productList.filter(p => p.sku).map(p => p.sku);
  const { data, error, status } = await checkSkus(skus);

  if (error) {
    console.log(`[bestbuy] Error: ${error}`);
    return [];
  }

  const results = [];
  const block = Array.isArray(data) ? data : [data];

  for (const product of productList) {
    const raw = block.find(b => b?.sku?.skuId === product.sku);
    const parsed = raw ? parseSkuResult(raw) : null;
    if (!parsed) {
      console.log(`[bestbuy] ${product.label} (${product.sku}): parse error`);
      continue;
    }

    results.push({ product, result: parsed });
    const changed = hasChanged(product.sku, { available: parsed.available, price: parsed.price });

    if (changed && parsed.available) {
      console.log(`[bestbuy] 🟢 IN STOCK: ${product.label} — ${parsed.price}`);
      await sendDropAlert({
        retailer: 'best-buy',
        label: product.label,
        url: `https://www.bestbuy.com/site/searchpage.jsp?st=${product.sku}`,
        sku: product.sku,
        price: parsed.price,
        status: 'in_stock',
        timestamp: Date.now(),
      });
    } else if (changed && !parsed.available) {
      console.log(`[bestbuy] 🔴 OOS: ${product.label}`);
    }
  }

  return results;
}

// Standalone test
if (process.argv[1]?.includes('best-buy.js')) {
  console.log('[bestbuy] Running standalone test...');
  const products = getProductsByRetailer('best-buy');
  console.log(`[bestbuy] Monitoring ${products.length} products`);
  const results = await checkBestBuy(products);
  for (const r of results) {
    console.log(`  ${r.product.label}: ${r.result.available ? '🟢 IN STOCK' : '🔴 OOS'} — ${r.result.price}`);
  }
}