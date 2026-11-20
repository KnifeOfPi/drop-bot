// Target product monitor — RedSky API
// Watches TCINs for stock availability changes and fires Discord alerts.
//
// RedSky API: redsky.target.com/redsky_aggregations/v1/web/pdp_client_v1
// This is the same API the Target mobile app uses — lighter bot detection
// than scraping the web frontend.

import { getProductsByRetailer } from '../config.js';
import { sendDropAlert } from '../discord.js';

const REDSKY_KEY = '9f36aeafbe60771e321a7cc95a78140772ab3e96';
const REDSKY_BASE = 'https://redsky.target.com/redsky_aggregations/v1/web/pdp_client_v1';
const DEFAULT_STORE = '3991'; // generic store ID

// Track previous state to detect changes
const stateCache = new Map(); // tcin -> { in_stock, price, lastSeen }

function getStatus(data) {
  if (!data?.data?.product?.item) return null;
  const item = data.data.product.item;
  const enrichment = data.data.product.enrichment;
  const price = data.data.product.price;
  const fulfillment = data.data.product.fulfillment;

  // Determine stock status from multiple signals
  const shippingAvailable = fulfillment?.shipping_options?.availability_status === 'IN_STOCK';
  const pickupAvailable = fulfillment?.pickup_options?.some(o => o.availability_status === 'IN_STOCK');
  const enrichmentStatus = enrichment?.buyability?.toLowerCase();
  const inStock = shippingAvailable || pickupAvailable || enrichmentStatus === 'in_stock';

  return {
    tcin: item.tcin,
    title: item.product_description?.title || enrichment?.product_title || 'Unknown',
    price: price?.formatted_current_price || enrichment?.price?.formatted_current_price || 'N/A',
    priceRaw: price?.current_retail || 0,
    in_stock: inStock,
    enrichmentStatus,
    url: `https://www.target.com/p/-/A-${item.tcin}`,
  };
}

async function checkProduct(tcin) {
  const url = `${REDSKY_BASE}?key=${REDSKY_KEY}&tcin=${tcin}&pricing_store_id=${DEFAULT_STORE}&has_financing_options=true`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Target/10.57.0 (iPhone; iOS 18.1; Scale/3.00)',
        'Accept': 'application/json',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });
    clearTimeout(timeout);

    if (res.status === 429) return { status: 429, error: 'rate_limited' };
    if (!res.ok) return { status: res.status, error: `HTTP ${res.status}` };

    const data = await res.json();
    const status = getStatus(data);
    if (!status) return { status: 0, error: 'parse_error', data };

    return { ...status, status: res.status };
  } catch (e) {
    clearTimeout(timeout);
    return { status: 0, error: e.message };
  }
}

function hasChanged(tcin, current) {
  const prev = stateCache.get(tcin);
  if (!prev) {
    stateCache.set(tcin, current);
    return false; // first check — don't alert
  }

  const changed = prev.in_stock !== current.in_stock || prev.price !== current.price;
  stateCache.set(tcin, current);
  return changed;
}

export async function checkTarget(products) {
  const productList = products || getProductsByRetailer('target');
  if (productList.length === 0) return [];

  const results = [];

  for (const product of productList) {
    const tcin = product.tcin;
    if (!tcin) continue;

    const result = await checkProduct(tcin);
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
    } else if (changed && !result.in_stock) {
      console.log(`[target] 🔴 OOS: ${result.title}`);
    }
  }

  return results;
}

// Standalone test mode
if (process.argv[1]?.includes('target.js')) {
  console.log('[target] Running standalone test...');
  const products = getProductsByRetailer('target');
  console.log(`[target] Monitoring ${products.length} products`);
  const results = await checkTarget(products);
  for (const r of results) {
    console.log(`  ${r.product.label}: ${r.result.in_stock ? '🟢 IN STOCK' : '🔴 OOS'} — ${r.result.price}`);
  }
}