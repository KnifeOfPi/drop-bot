// Walmart. Mostly "enter to win" drawings now, plus Wednesday online drops
// (sometimes behind a virtual queue). Requires a logged-in profile with saved
// address + card. Walmart uses PerimeterX ("Press & Hold") — when it blocks,
// the bot hands the session to you in Live view. CVV via WALMART_CVV.

import { defineRetailer } from './base.js';

export default defineRetailer({
  id: 'walmart',
  name: 'Walmart',
  loginUrl: 'https://www.walmart.com/account/login',
  accountUrl: 'https://www.walmart.com/account',
  cvvEnv: 'WALMART_CVV',
  cartUrl: 'https://www.walmart.com/cart',
  loggedOutUrl: /\/account\/login|\/signin/i,
  confirmUrl: /thankyou|thank-you|order-confirmation|\/confirmation/i,
  confirmText: /thanks for your order|thank you for your order|order (number|#)\s*:?\s*\d|order placed/i,

  productUrl: (p) => p.url,
  searchUrl: (q) => `https://www.walmart.com/search?q=${encodeURIComponent(q)}`,
  listingRe: /walmart\.com\/ip\/(?:[^/?#]+\/)?(\d+)/,
  toProduct: (l) => ({ retailer: 'walmart', url: l.url.split('?')[0] }),

  sel: {
    atc: [
      'button[data-automation-id="atc"]',
      'button[data-dca-name="ItemBuyBoxAddToCartButton"]',
      { role: 'button', name: /^add to cart$/i },
    ],
    oos: /\bout of stock\b|not available|get in-stock alert|currently unavailable/i,
    price: ['[itemprop="price"]', '[data-testid="price-wrap"] span'],
    checkout: [
      { role: 'button', name: /^continue to checkout$/i },
      { role: 'button', name: /^check ?out$/i },
    ],
    cont: [
      { role: 'button', name: /^continue( to (payment|review))?$/i },
      { role: 'button', name: /^review (your )?order$/i },
      { role: 'button', name: /^confirm (delivery|shipping|address)$/i },
    ],
    placeOrder: [
      'button[data-automation-id="place-order-button"]',
      { role: 'button', name: /^place order$/i },
    ],
    added: /added to (your )?cart|item(s)? added|\d+ added to cart|view cart/i,
  },
});
