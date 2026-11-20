// Pokémon Center. Online drops behind a waiting room (Queue-it style) and
// DataDome/Imperva. Requires a logged-in profile with saved address + card.
// CVV via POKEMONCENTER_CVV. A residential CHECKOUT_PROXY and headed Chrome help.

import { defineRetailer } from './base.js';

export default defineRetailer({
  id: 'pokemon-center',
  name: 'Pokémon Center',
  loginUrl: 'https://www.pokemoncenter.com/account/login',
  cvvEnv: 'POKEMONCENTER_CVV',
  cartUrl: 'https://www.pokemoncenter.com/cart',
  loggedOutUrl: /\/login|\/sign-in|\/account\/login/i,
  confirmUrl: /confirmation|thank-you|order-complete/i,
  confirmText: /thank you for your order|order (number|#)/i,

  productUrl: (p) => p.url,
  searchUrl: (q) => `https://www.pokemoncenter.com/search/${encodeURIComponent(q)}`,
  listingRe: /pokemoncenter\.com\/product\/([\w-]+)/,
  toProduct: (l) => ({ retailer: 'pokemon-center', url: `https://www.pokemoncenter.com/product/${l.id}` }),

  sel: {
    atc: [
      '[data-testid="add-to-cart"]',
      'button[class*="add-to-cart"]',
      { role: 'button', name: /^add to cart$/i },
    ],
    oos: /\b(sold out|out of stock|currently unavailable)\b/i,
    price: ['[data-testid="price"]', '[class*="product-price"]'],
    checkout: [
      '[data-testid="checkout-button"]',
      { role: 'button', name: /^(secure )?checkout$/i },
      { role: 'link', name: /^(secure )?checkout$/i },
    ],
    placeOrder: [
      '[data-testid="place-order"]',
      { role: 'button', name: /^(place|submit) (your )?order$/i },
    ],
  },
});
