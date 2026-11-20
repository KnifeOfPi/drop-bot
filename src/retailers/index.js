// Retailer registry.

import target from './target.js';
import bestBuy from './best-buy.js';
import walmart from './walmart.js';
import costco from './costco.js';
import samsClub from './sams-club.js';
import pokemonCenter from './pokemon-center.js';

export const RETAILER_ADAPTERS = {
  target,
  'best-buy': bestBuy,
  walmart,
  costco,
  'sams-club': samsClub,
  'pokemon-center': pokemonCenter,
};

export function getAdapter(id) {
  return RETAILER_ADAPTERS[id] || null;
}
