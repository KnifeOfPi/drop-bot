// Direct fetch research — try each retailer's API endpoints without proxy first
// to understand data formats before building monitors

const headers = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

// 1. Target RedSky API — their product API
console.log('=== TARGET REDSKY API ===');
const tcin = '89191166'; // Example: Pokemon ETB TCIN
const targetUrl = `https://redsky.target.com/redsky_aggregations/v1/web/pdp_client_v1?key=9f36aeafbe60771e321a7cc95a78140772ab3e96&tcin=${tcin}&pricing_store_id=3991&has_financing_options=true`;
try {
  const res = await fetch(targetUrl, { headers });
  const data = await res.json();
  console.log(`Status: ${res.status}`);
  console.log(JSON.stringify(data?.data?.product?.item?.product_description?.title, null, 2));
  console.log(`Price: ${data?.data?.product?.price?.formatted_current_price}`);
  console.log(`Available: ${data?.data?.product?.fulfillment?.shipping_options?.availability_status}`);
  console.log(`Enrichment: ${JSON.stringify(data?.data?.product?.enrichment)?.substring(0, 200)}`);
} catch (e) {
  console.log(`Target RedSky error: ${e.message}`);
}

// 2. Best Buy API
console.log('\n=== BEST BUY API ===');
const bbSku = '6434256'; // Example Pokemon product
const bbUrl = `https://www.bestbuy.com/api/3.0/priceBlocks?skus=${bbSku}`;
try {
  const res = await fetch(bbUrl, { headers });
  console.log(`Status: ${res.status}`);
  const text = await res.text();
  console.log(text.substring(0, 500));
} catch (e) {
  console.log(`Best Buy error: ${e.message}`);
}

// 3. Pokemon Center — try the product API endpoint
console.log('\n=== POKEMON CENTER PRODUCT API ===');
const pcUrl = 'https://www.pokemoncenter.com/api/products/699-18442'; // ETB SKU guess
try {
  const res = await fetch(pcUrl, {
    headers: {
      ...headers,
      'Accept': 'application/json',
      'Origin': 'https://www.pokemoncenter.com',
      'Referer': 'https://www.pokemoncenter.com/',
    }
  });
  console.log(`Status: ${res.status}`);
  const text = await res.text();
  console.log(text.substring(0, 500));
} catch (e) {
  console.log(`Pokemon Center error: ${e.message}`);
}