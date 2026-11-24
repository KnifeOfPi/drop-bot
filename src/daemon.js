#!/usr/bin/env node
// Drop Bot Daemon
//
//   • Monitors every watched product at Target, Best Buy, Walmart, Costco,
//     Sam's Club and Pokémon Center in logged-in browser sessions
//   • Joins queues, adds to cart, checks out or hands off to you (Live view)
//   • Enters drawings
//   • Discovers new Pokémon listings
//   • Serves the dashboard API on DAEMON_PORT (default 4200)
//
// Usage: node src/daemon.js   (or npm start)

import './env.js';
import { createServer } from 'http';
import { readFileSync, writeFileSync } from 'fs';
import yaml from 'js-yaml';
import {
  loadConfig, loadConfigFresh, CONFIG_PATH, webhooksFromEnv, WEBHOOK_KEYS, RETAILERS,
  productKey, productId, productAction, getMonitorSettings, getDiscoverySettings, parseListingPrice,
  getCheckoutSettings, migrateConfigFile, clearConfigCache,
} from './config.js';
import { sendHealthAlert } from './discord.js';
import { getCheckoutStatus, runFlow, runDrawing, findProduct, resolveHandoff, isBusy } from './checkout/index.js';
import { startMonitors, stopMonitors, productState, retailerHealth } from './monitor.js';
import { startDiscovery, stopDiscovery, discoverOnce, recentDiscoveries, discoveryState, findDiscovery, markWatched } from './discovery.js';
import { liveFrame, liveInput, openLoginSession, closeLoginSession, checkLogin, liveSessions } from './live.js';
import { accountsStatus, setCvv, setProxyUrl, getProxyUrl, proxyStatus, proxiedStoreSet } from './accounts.js';
import { publicIp } from './checkout/browser.js';
import { bandwidthStatus } from './bandwidth.js';
import { setPaused, pauseStatus, isPaused, PAUSE_KEYS } from './pause.js';
import { RETAILER_ADAPTERS } from './retailers/index.js';
import { getAdapter } from './retailers/index.js';
import { openSessions, closeAll, closeSession } from './session.js';

// Upgrade settings written by the original bot (one time, backed up).
const migrated = migrateConfigFile();
if (migrated) {
  console.log(`[config] upgraded ${CONFIG_PATH} (backup: ${CONFIG_PATH}.v1.bak):`);
  for (const c of migrated) console.log(`[config]   • ${c}`);
  clearConfigCache();
}
const config = loadConfig();
const HTTP_PORT = parseInt(process.env.DAEMON_PORT || '4200', 10);
const DAEMON_TOKEN = process.env.DAEMON_TOKEN || '';
// With a DAEMON_TOKEN the API listens on all interfaces (so a dashboard on Vercel can
// reach it); without one it only listens on localhost. DAEMON_HOST overrides.
const DAEMON_HOST = process.env.DAEMON_HOST || (DAEMON_TOKEN ? '0.0.0.0' : '127.0.0.1');
const LOOPBACK = ['127.0.0.1', 'localhost', '::1'].includes(DAEMON_HOST);
if (!LOOPBACK && DAEMON_TOKEN.length < 16) {
  console.error('[daemon] Refusing to listen on a public interface without DAEMON_TOKEN (16+ characters).');
  console.error('[daemon] Anyone who can reach this API could change settings, place orders and drive your logged-in browsers.');
  process.exit(1);
}
const CVV_ENVS = Object.fromEntries(Object.entries(RETAILER_ADAPTERS).map(([id, a]) => [id, a.cvvEnv]));
const ENV_MARKER = '(set via env)';
const START_TIME = Date.now();
let running = true;

// ── HTTP helpers ────────────────────────────────────────────────────────────

function send(res, code, body, headers = {}) {
  res.writeHead(code, { 'Content-Type': 'application/json', ...headers });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString();
  return raw ? JSON.parse(raw) : {};
}

function writeConfig(cfg) {
  writeFileSync(CONFIG_PATH, yaml.dump(cfg, { lineWidth: 120, noRefs: true }), 'utf8');
}

function deepMerge(target, source) {
  for (const key of Object.keys(source)) {
    if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
      if (!target[key] || typeof target[key] !== 'object') target[key] = {};
      deepMerge(target[key], source[key]);
    } else {
      target[key] = source[key];
    }
  }
}

function statusBody() {
  const cfg = loadConfigFresh() || {};
  const msettings = getMonitorSettings(cfg);
  const products = (cfg.products || []).map(p => {
    const key = productKey(p);
    const st = productState.get(key);
    return {
      key, retailer: p.retailer, label: p.label, sku: productId(p), action: productAction(p),
      max_price: p.max_price ?? null, url: getAdapter(p.retailer)?.productUrl(p) || null,
      status: st?.status || 'pending', in_stock: st?.in_stock ?? null, price: st?.price || 'N/A',
      last_checked: st?.last_checked || null, since: st?.since || null, error: st?.error, via: st?.via || null,
    };
  });
  const active = new Set((cfg.products || []).map(p => p.retailer));
  return {
    running,
    pause: pauseStatus(cfg),
    uptime_seconds: Math.floor((Date.now() - START_TIME) / 1000),
    pid: process.pid,
    products,
    retailers: RETAILERS.filter(r => active.has(r)).map(r => ({
      retailer: r, name: getAdapter(r).name, errors: retailerHealth[r].errors, max_errors: msettings.max_consecutive_errors,
      last_tick: retailerHealth[r].last_tick, interval: retailerHealth[r].interval, hot: retailerHealth[r].hot, watch: retailerHealth[r].watch,
      busy: isBusy(r), session_open: openSessions().includes(r),
    })),
    checkout: getCheckoutStatus(),
    accounts: accountsStatus(CVV_ENVS),
    proxy: { ...proxyStatus(), stores: getCheckoutSettings(cfg).proxy_stores ?? null },
    bandwidth: { ...bandwidthStatus(proxiedStoreSet(cfg)), limit_mb: getMonitorSettings(cfg).daily_proxy_limit_mb },
    login_sessions: liveSessions(),
    discovery: { ...getDiscoverySettings(cfg), ...discoveryState, recent: recentDiscoveries(25) },
  };
}

// ── Routes ─────────────────────────────────────────────────────────────────

// Automation that opens a store browser — refused while paused. Signing in,
// checking an account and testing the proxy stay allowed: they're one-off actions
// you start yourself, and the store's browser closes again afterwards.
const NEEDS_BROWSER = new Set([
  '/checkout/test', '/flow/start', '/drawing/enter', '/discovery/run',
]);

async function route(req, res, url) {
  const path = url.pathname;
  const method = req.method;

  // ── Pause switch: { paused: true | false } ──
  if (path === '/pause' && method === 'POST') {
    const { paused } = await readJson(req);
    const by = req.headers['x-dropbot-client'] === 'dashboard' ? 'dashboard' : 'api';
    const st = await setPaused(!!paused, 'manual', by);
    return send(res, 200, { ok: true, ...st, message: st.paused
      ? 'Paused — every store browser is closed. No store traffic or proxy data until you resume.'
      : 'Resumed — the stores reopen on the next pass (a few seconds).' });
  }

  if (method === 'POST' && NEEDS_BROWSER.has(path) && isPaused()) {
    return send(res, 409, { error: 'The bot is paused — tap Resume on the dashboard first.' });
  }

  if (path === '/status' && method === 'GET') return send(res, 200, statusBody());

  if (path === '/config' && method === 'GET') {
    const current = yaml.load(readFileSync(CONFIG_PATH, 'utf8')) || {};
    current.discord = { ...(current.discord || {}) };
    for (const k of WEBHOOK_KEYS) if (!(k in current.discord)) current.discord[k] = '';
    for (const k of Object.keys(current.discord)) {
      if (current.discord[k] && typeof current.discord[k] === 'string') current.discord[k] = current.discord[k].substring(0, 8) + '...';
    }
    for (const k of webhooksFromEnv(current.discord)) current.discord[k] = ENV_MARKER;
    return send(res, 200, current);
  }

  if (path === '/config' && method === 'PUT') {
    const updates = await readJson(req);
    // Pause state only changes through /pause — a Settings save (which sends the
    // whole config it loaded earlier) must never pause or resume the bot.
    for (const k of PAUSE_KEYS) delete updates[k];
    const current = yaml.load(readFileSync(CONFIG_PATH, 'utf8')) || {};
    // Masked ("https://...") hooks keep their real value; env-supplied hooks are never written here.
    if (updates.discord) {
      for (const [k, v] of Object.entries(updates.discord)) {
        if (v === ENV_MARKER) { delete updates.discord[k]; continue; }
        const real = current.discord?.[k];
        if (typeof v === 'string' && typeof real === 'string' && real && v === real.substring(0, 8) + '...') updates.discord[k] = real;
      }
    }
    deepMerge(current, updates);
    writeConfig(current);
    if (updates.checkout && 'proxy_stores' in updates.checkout) await restartIdleSessions();
    console.log('[daemon] config updated');
    return send(res, 200, { ok: true, message: 'Saved. Watchlist, checkout, schedule and discovery changes apply on the next pass.' });
  }

  // Manual flows: { retailer, id, mode: 'dry_run' | 'assist' }
  if ((path === '/checkout/test' || path === '/flow/start') && method === 'POST') {
    const { retailer, id, mode: m } = await readJson(req);
    const mode = path === '/checkout/test' ? 'dry_run' : (m === 'dry_run' ? 'dry_run' : 'assist');
    const product = findProduct(retailer, id);
    if (!product) return send(res, 404, { error: `no ${retailer} product ${id} in config` });
    if (isBusy(retailer)) return send(res, 409, { error: `${getAdapter(retailer)?.name || retailer} is busy` });
    runFlow(product, { mode, trigger: path === '/checkout/test' ? 'dashboard_test' : 'manual' })
      .catch(e => console.error(`[daemon] flow crashed: ${e.message}`));
    return send(res, 202, { ok: true, message: mode === 'dry_run'
      ? `Dry run started for ${product.label} — result appears under Activity and in Discord`
      : `Going for ${product.label} — you'll be pinged when it's your turn` });
  }

  if (path === '/drawing/enter' && method === 'POST') {
    const { retailer, id } = await readJson(req);
    const product = findProduct(retailer, id);
    if (!product) return send(res, 404, { error: `no ${retailer} product ${id} in config` });
    if (isBusy(retailer)) return send(res, 409, { error: `${getAdapter(retailer)?.name || retailer} is busy` });
    runDrawing(product, { trigger: 'manual' }).catch(e => console.error(`[daemon] drawing crashed: ${e.message}`));
    return send(res, 202, { ok: true, message: `Entering the drawing for ${product.label}…` });
  }

  if (path === '/handoff/resolve' && method === 'POST') {
    const { id, outcome } = await readJson(req);
    if (!['success', 'abandoned'].includes(outcome)) return send(res, 400, { error: 'outcome must be success or abandoned' });
    const ok = await resolveHandoff(id, outcome);
    return send(res, ok ? 200 : 404, ok ? { ok: true } : { error: 'hand-off not found (already closed?)' });
  }

  // ── Accounts (sign in from the dashboard) ──
  if (path === '/accounts/login' && method === 'POST') {
    const { retailer } = await readJson(req);
    if (!getAdapter(retailer)) return send(res, 400, { error: 'unknown store' });
    const id = await openLoginSession(retailer);
    return send(res, 200, { ok: true, id, message: `Sign-in page open for ${getAdapter(retailer).name}` });
  }

  if (path === '/accounts/done' && method === 'POST') {
    const { id } = await readJson(req);
    const loggedIn = await closeLoginSession(id, { check: true });
    return send(res, 200, { ok: true, logged_in: loggedIn,
      message: loggedIn === true ? 'Signed in ✅' : loggedIn === false ? 'Still looks signed out' : 'Saved — couldn\'t confirm sign-in (try Check)' });
  }

  if (path === '/accounts/check' && method === 'POST') {
    const { retailer } = await readJson(req);
    if (!getAdapter(retailer)) return send(res, 400, { error: 'unknown store' });
    if (isBusy(retailer)) return send(res, 409, { error: 'store is busy — try again in a moment' });
    const loggedIn = await checkLogin(retailer);
    return send(res, 200, { ok: true, logged_in: loggedIn,
      message: loggedIn === true ? 'Signed in ✅' : loggedIn === false ? 'Signed out' : "Couldn't tell (captcha/queue on the account page)" });
  }

  // Proxy for the store browsers: { url } — '' removes it.
  if (path === '/accounts/proxy' && method === 'POST') {
    const { url: proxy } = await readJson(req);
    if (process.env.CHECKOUT_PROXY) return send(res, 409, { error: 'CHECKOUT_PROXY is set in the server .env — remove it there to manage the proxy here' });
    setProxyUrl(proxy);
    const { restarted, deferred } = await restartIdleSessions();
    return send(res, 200, { ok: true, proxy: proxyStatus(), message: `${proxy ? 'Proxy saved' : 'Proxy removed'}${restarted.length ? ` — restarted ${restarted.length} store browser(s)` : ''}${deferred.length ? `; ${deferred.join(', ')} will switch when idle` : ''}` });
  }

  if (path === '/accounts/proxy/test' && method === 'POST') {
    const proxy = getProxyUrl();
    const [server, viaProxy] = await Promise.allSettled([publicIp(null), proxy ? publicIp(proxy) : Promise.resolve(null)]);
    const out = {
      server_ip: server.status === 'fulfilled' ? server.value : null,
      proxy_ip: viaProxy.status === 'fulfilled' ? viaProxy.value : null,
      proxy_error: viaProxy.status === 'rejected' ? viaProxy.reason.message.split('\n')[0] : null,
    };
    out.message = !proxy ? `No proxy set — stores see your server's IP ${out.server_ip || '(unknown)'}`
      : out.proxy_error ? `Proxy failed: ${out.proxy_error}`
      : out.proxy_ip === out.server_ip ? `⚠️ Proxy returned your server's own IP (${out.proxy_ip}) — it isn't being used`
      : `✅ Stores see ${out.proxy_ip} (your server is ${out.server_ip || 'unknown'})`;
    return send(res, 200, { ok: !out.proxy_error, ...out });
  }

  if (path === '/accounts/cvv' && method === 'POST') {
    const { retailer, cvv } = await readJson(req);
    setCvv(retailer, cvv);
    return send(res, 200, { ok: true, message: cvv ? 'CVV saved on the server' : 'CVV removed' });
  }

  if (path === '/live/frame' && method === 'GET') {
    const frame = await liveFrame(url.searchParams.get('id'));
    if (!frame) return send(res, 404, { error: 'session is closed' });
    res.writeHead(200, {
      'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store',
      'X-Session-Kind': frame.kind, 'X-Session-Retailer': frame.retailer,
      'X-Frame-Width': String(frame.width), 'X-Frame-Height': String(frame.height),
      'X-Frame-Url': encodeURIComponent(frame.url), 'X-Frame-Title': encodeURIComponent(frame.title),
    });
    return res.end(frame.jpeg);
  }

  if (path === '/live/input' && method === 'POST') {
    const { id, ...action } = await readJson(req);
    const r = await liveInput(id, action);
    return send(res, r.ok ? 200 : 400, r);
  }

  if (path === '/discovery/run' && method === 'POST') {
    if (discoveryState.running) return send(res, 409, { error: 'discovery already running' });
    discoverOnce().catch(e => console.error(`[discovery] ${e.message}`));
    return send(res, 202, { ok: true, message: 'Searching all retailers for new listings…' });
  }

  // Add a discovered listing to the watchlist: { retailer, id, action?, max_price? }
  if (path === '/discovery/watch' && method === 'POST') {
    const body = await readJson(req);
    const listing = findDiscovery(body.retailer, String(body.id));
    const adapter = getAdapter(body.retailer);
    if (!listing || !adapter?.toProduct) return send(res, 404, { error: 'listing not found' });
    const current = yaml.load(readFileSync(CONFIG_PATH, 'utf8')) || {};
    current.products = current.products || [];
    const product = {
      ...adapter.toProduct(listing),
      label: listing.title.slice(0, 120),
      max_price: body.max_price ?? parseListingPrice(listing.price),
      action: ['notify', 'assist', 'checkout'].includes(body.action) ? body.action : 'assist',
    };
    if (product.max_price == null) delete product.max_price;
    if (current.products.some(p => productKey(p) === productKey(product))) {
      markWatched(body.retailer, String(body.id));
      return send(res, 200, { ok: true, message: 'Already on your watchlist' });
    }
    current.products.push(product);
    writeConfig(current);
    markWatched(body.retailer, String(body.id));
    return send(res, 200, { ok: true, message: `Watching ${product.label}` });
  }

  if (path === '/logs' && method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end(`[drop-bot daemon] PID ${process.pid} — uptime ${Math.floor((Date.now() - START_TIME) / 1000)}s\n`);
  }

  return send(res, 404, { error: 'not found' });
}

// ── Startup ─────────────────────────────────────────────────────────────────

/** Restart store browsers that aren't in use so proxy changes take effect now. */
async function restartIdleSessions() {
  const inUse = new Set([
    ...getCheckoutStatus().handoffs.map(h => h.retailer),
    ...liveSessions().map(l => l.retailer),
  ]);
  const restarted = [], deferred = [];
  for (const r of openSessions()) {
    if (isBusy(r) || inUse.has(r)) { deferred.push(r); continue; }
    await closeSession(r);
    restarted.push(r);
  }
  if (restarted.length) console.log(`[daemon] restarted browsers for ${restarted.join(', ')} (proxy change)`);
  return { restarted, deferred };
}

async function main() {
  console.log('[daemon] 🚀 Drop Bot starting...');
  const byRetailer = {};
  for (const p of (config.products || [])) byRetailer[p.retailer] = (byRetailer[p.retailer] || 0) + 1;
  console.log(`[daemon] Watchlist: ${config.products?.length || 0} products — ${Object.entries(byRetailer).map(([r, c]) => `${r}:${c}`).join(' ') || 'none'}`);

  const webhooks = config.discord || {};
  const configuredHooks = Object.entries(webhooks).filter(([, v]) => v).length;
  console.log(`[daemon] Discord webhooks configured: ${configuredHooks}/${Object.keys(webhooks).length}`);
  if (configuredHooks === 0) {
    console.warn('[daemon] ⚠️ No Discord webhooks configured — alerts will not be sent');
    console.warn('[daemon] Add webhook URLs to .env as DISCORD_DROP_ALERTS, DISCORD_HEALTH, ... (see .env.example)');
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${HTTP_PORT}`);
    // No CORS: the dashboard calls the daemon server-to-server through its /api routes.
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
    if (DAEMON_TOKEN && req.headers.authorization !== `Bearer ${DAEMON_TOKEN}`) return send(res, 401, { error: 'unauthorized' });
    try {
      await route(req, res, url);
    } catch (e) {
      if (!res.headersSent) send(res, 400, { error: e.message });
    }
  });
  server.listen(HTTP_PORT, DAEMON_HOST, () => console.log(`[daemon] HTTP API on ${DAEMON_HOST}:${HTTP_PORT}${DAEMON_TOKEN ? ' (token required)' : ''}`));

  const shutdown = async () => {
    console.log('\n[daemon] Shutting down...');
    running = false;
    stopMonitors();
    stopDiscovery();
    server.close();
    await closeAll().catch(() => {});
    await sendHealthAlert('Drop Bot stopped').catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  if (process.env.DROPBOT_NO_LOOPS) {
    console.log('[daemon] DROPBOT_NO_LOOPS set — API only');
    return;
  }
  await sendHealthAlert('Drop Bot started — monitoring active ✅');
  startMonitors();
  startDiscovery();
}

main().catch(e => {
  console.error(`[daemon] Fatal: ${e.stack || e.message}`);
  process.exit(1);
});
