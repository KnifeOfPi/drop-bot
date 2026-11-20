// Costco. Queues to join, then checkout. Membership + logged-in profile with
// saved address + card required ("Sign In to Buy" means the session expired).
// Costco uses Akamai bot protection. CVV via COSTCO_CVV.

import { defineRetailer } from './base.js';

export default defineRetailer({
  id: 'costco',
  name: 'Costco',
  loginUrl: 'https://www.costco.com/LogonForm',
  cvvEnv: 'COSTCO_CVV',
  cartUrl: 'https://www.costco.com/CheckoutCartDisplayView',
  loggedOutUrl: /logonform|\/login|\/signin/i,
  confirmUrl: /orderconfirmation|order-confirmation|thank-?you/i,
  confirmText: /thank you for your order|order (number|#)\s*:?\s*\d|your order has been placed/i,

  productUrl: (p) => p.url,
  searchUrl: (q) => `https://www.costco.com/s?keyword=${encodeURIComponent(q)}`,
  listingRe: /costco\.com\/[^?#]*?\.product\.(\d+)\.html/,
  toProduct: (l) => ({ retailer: 'costco', url: l.url.split('?')[0] }),

  sel: {
    atc: [
      'input#add-to-cart-btn:not([disabled])',
      'button#add-to-cart-btn',
      '[automation-id="addToCartButton"]',
      { role: 'button', name: /^add to cart$/i },
    ],
    oos: /\bout of stock\b|sold out|not available|sign in to buy/i,
    price: ['[automation-id="productPriceOutput"]', '#pull-right-price .value'],
    checkout: [
      '#shopCartCheckoutSubmitButton',
      { role: 'button', name: /^check ?out$/i },
      { role: 'link', name: /^check ?out$/i },
    ],
    cont: [
      { role: 'button', name: /^continue( to (payment|review|shipping options))?$/i },
      { role: 'button', name: /^review (your )?order$/i },
      { role: 'button', name: /^ship to this address$/i },
    ],
    placeOrder: [
      { role: 'button', name: /^place order$/i },
      'input[value="Place Order" i]',
    ],
  },
});
