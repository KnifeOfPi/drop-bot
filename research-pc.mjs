// Scrape Pokemon Center for 30th Celebration ETB — research run
import { launchStealth, solveCaptchaIfPresent } from '/Users/cepheus/.hermes/skills/web-automation/stealth-browser/scripts/lib.mjs';

const { browser, context, page } = await launchStealth({ headless: true });
try {
  // Try the direct product search page first
  console.log('[1] Loading Pokemon Center search...');
  await page.goto('https://www.pokemoncenter.com/search/?q=elite+trainer+box', {
    waitUntil: 'domcontentloaded',
    timeout: 30000
  });
  await solveCaptchaIfPresent(page);
  // Wait for product grid to appear
  await page.waitForTimeout(3000);
  
  const title = await page.title();
  console.log(`Title: ${title}`);
  
  // Extract product URLs and names from the page
  const products = await page.evaluate(() => {
    const items = [];
    // Pokemon Center uses various product card selectors
    const cards = document.querySelectorAll('a[href*="/product/"], [data-testid="product-card"], .product-card');
    cards.forEach(card => {
      const link = card.href || card.querySelector('a')?.href || '';
      const name = card.querySelector('h2, h3, .product-name, [class*="title"]')?.textContent?.trim() || '';
      const price = card.querySelector('[class*="price"], .price')?.textContent?.trim() || '';
      if (link) items.push({ link, name, price });
    });
    return items;
  });
  
  console.log(`Found ${products.length} product cards`);
  products.slice(0, 10).forEach(p => console.log(JSON.stringify(p)));
  
  // If nothing found, dump page structure to understand it
  if (products.length === 0) {
    console.log('\n[DEBUG] Page body text (first 2000 chars):');
    const text = await page.evaluate(() => document.body?.innerText?.substring(0, 2000) || 'no body text');
    console.log(text);
    
    // Check for JSON data in script tags
    const scripts = await page.evaluate(() => {
      const data = [];
      document.querySelectorAll('script[type="application/json"], script[type="application/ld+json"]').forEach(s => {
        data.push(s.textContent.substring(0, 500));
      });
      return data;
    });
    console.log(`\nFound ${scripts.length} JSON scripts`);
    scripts.forEach(s => console.log(s.substring(0, 300)));
  }
  
  // Try the queue status endpoint
  console.log('\n[2] Checking Pokemon Center queue status...');
  await page.goto('https://www.pokemoncenter.com/', { waitUntil: 'domcontentloaded', timeout: 15000 });
  await solveCaptchaIfPresent(page);
  await page.waitForTimeout(2000);
  console.log(`Homepage title: ${await page.title()}`);
  
} catch (e) {
  console.error('Error:', e.message);
} finally {
  await browser.close();
}