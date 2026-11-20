// Sam's Club. Queues to join, then checkout. Membership + logged-in profile
// with saved address + card required. Sam's uses PerimeterX like Walmart — when
// it blocks, the bot hands the session to you in Live view. CVV via SAMSCLUB_CVV.

import { defineRetailer } from './base.js';

export default defineRetailer({
  id: 'sams-club',
  name: "Sam's Club",
  loginUrl: 'https://www.samsclub.com/login',
  accountUrl: 'https://www.samsclub.com/account',
  cvvEnv: 'SAMSCLUB_CVV',
  cartUrl: 'https://www.samsclub.com/cart',
  loggedOutUrl: /\/login|\/signin|\/account\/signin/i,
  confirmUrl: /thank-?you|order-confirmation|\/confirmation/i,
  confirmText: /thank you for your order|thanks for your order|order (number|#)\s*:?\s*\d|order placed/i,

  productUrl: (p) => p.url,
  searchUrl: (q) => `https://www.samsclub.com/s/${encodeURIComponent(q)}`,
  listingRe: /samsclub\.com\/ip\/(?:[^/?#]+\/)?([\w-]+)/,
  toProduct: (l) => ({ retailer: 'sams-club', url: l.url.split('?')[0] }),

  sel: {
    atc: [
      'button[data-automation-id="atc"]',
      { role: 'button', name: /^(add to cart|ship this item|add to cart for shipping)$/i },
    ],
    oos: /\bout of stock\b|sold out|not available|currently unavailable/i,
    price: ['[itemprop="price"]', '[data-testid="price"]'],
    checkout: [
      { role: 'button', name: /^(begin checkout|check ?out|continue to checkout)$/i },
      { role: 'link', name: /^(begin checkout|check ?out)$/i },
    ],
    placeOrder: [{ role: 'button', name: /^place (your )?order$/i }],
  },
});
