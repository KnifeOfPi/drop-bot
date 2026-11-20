#!/usr/bin/env node
// Run a checkout by hand — always a dry run (stops at Place order).
//
//   npm run checkout-test -- target 1010892076
//   npm run checkout-test -- best-buy 6580529
//   npm run checkout-test -- pokemon-center 699-18442
//
// The product must be in config.yaml. Uses the same flow + guards as the daemon.
// Dry runs leave the item in your cart — empty it afterwards.

import '../env.js';
import { runCheckout, findProduct } from './index.js';

const [retailer, id] = process.argv.slice(2);
if (!retailer || !id) {
  console.error('Usage: npm run checkout-test -- <retailer> <tcin | sku | pokemon-center product id>');
  process.exit(1);
}
const product = findProduct(retailer, id);
if (!product) {
  console.error(`No ${retailer} product with id ${id} in config.yaml`);
  process.exit(1);
}
const result = await runCheckout(product, { dryRun: true, trigger: 'cli' });
console.log(JSON.stringify(result, null, 2));
process.exit(result.status === 'dry_run' ? 0 : 1);
