#!/usr/bin/env node
// One-time login per retailer. Opens a real (headed) Chrome window on the
// retailer's sign-in page using the bot's saved profile. Log in, make sure a
// default shipping address and card are saved on the account, then close the
// window. The session is reused by every checkout.
//
//   npm run login -- target | best-buy | pokemon-center

import '../env.js';
import { loadConfig, getCheckoutSettings } from '../config.js';
import { launchProfile } from './browser.js';
import { FLOWS } from './index.js';

const retailer = process.argv[2];
const flow = FLOWS[retailer];
if (!flow) {
  console.error(`Usage: npm run login -- <${Object.keys(FLOWS).join(' | ')}>`);
  process.exit(1);
}

const settings = getCheckoutSettings(loadConfig());
const { context, page, userDataDir } = await launchProfile(retailer, settings, { headless: false });
console.log(`[login] Profile: ${userDataDir}`);
console.log(`[login] Log in to ${retailer} in the browser window.`);
console.log('[login] Check that the account has a default shipping address + saved card.');
console.log('[login] Close the browser window when done — the session is saved automatically.');
await page.goto(flow.loginUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
await new Promise(resolve => context.on('close', resolve));
console.log('[login] Saved. ✅');
process.exit(0);
