// Store accounts — sign-in status per retailer and secrets entered from the
// dashboard (CVVs), so nothing has to be done on the server's command line.
//
//   data/accounts.json  — { retailer: { logged_in, checked_at, note } }
//   data/secrets.json   — { retailer: { cvv } }   (mode 600, never sent back out)
//
// Also the proxy for the store browsers (data/secrets.json → _proxy).
// Env vars (TARGET_CVV, CHECKOUT_PROXY, …) still work and take precedence.

import { readFileSync, writeFileSync, existsSync, chmodSync } from 'fs';
import { resolve } from 'path';
import { DATA_DIR } from './checkout/ledger.js';
import { RETAILERS, getCheckoutSettings } from './config.js';

const ACCOUNTS = resolve(DATA_DIR, 'accounts.json');
const SECRETS = resolve(DATA_DIR, 'secrets.json');

function readJson(file) {
  if (!existsSync(file)) return {};
  try { return JSON.parse(readFileSync(file, 'utf8')) || {}; } catch { return {}; }
}

function writeSecret(data) {
  writeFileSync(SECRETS, JSON.stringify(data, null, 2), { mode: 0o600 });
  try { chmodSync(SECRETS, 0o600); } catch {}
}

export function getCvv(retailer, envName) {
  return (envName && process.env[envName]) || readJson(SECRETS)[retailer]?.cvv || '';
}

export function setCvv(retailer, cvv) {
  if (!RETAILERS.includes(retailer)) throw new Error('unknown store');
  const v = String(cvv ?? '').trim();
  if (v && !/^\d{3,4}$/.test(v)) throw new Error('CVV must be 3 or 4 digits');
  const data = readJson(SECRETS);
  data[retailer] = { ...(data[retailer] || {}) };
  if (v) data[retailer].cvv = v;
  else delete data[retailer].cvv;
  writeSecret(data);
}

export function markLogin(retailer, loggedIn, note = null) {
  const data = readJson(ACCOUNTS);
  data[retailer] = { logged_in: loggedIn, checked_at: Date.now(), note };
  writeFileSync(ACCOUNTS, JSON.stringify(data, null, 2));
}

/** { retailer: { logged_in: true|false|null, checked_at, note, cvv_set, cvv_source } } */
export function accountsStatus(cvvEnvs = {}) {
  const acc = readJson(ACCOUNTS);
  const sec = readJson(SECRETS);
  return Object.fromEntries(RETAILERS.map(r => {
    const envSet = !!(cvvEnvs[r] && process.env[cvvEnvs[r]]);
    return [r, {
      logged_in: acc[r]?.logged_in ?? null,
      checked_at: acc[r]?.checked_at ?? null,
      note: acc[r]?.note ?? null,
      cvv_set: envSet || !!sec[r]?.cvv,
      cvv_source: envSet ? 'env' : sec[r]?.cvv ? 'dashboard' : null,
    }];
  }));
}

// ── Proxy for the store browsers ─────────────────────────────────────────────

/**
 * Accepts the formats proxy providers hand out and returns a URL:
 *   http://user:pass@host:port   host:port:user:pass   user:pass@host:port   host:port
 */
export function normalizeProxy(input) {
  let v = String(input ?? '').trim();
  if (!v) return '';
  if (!/^[a-z0-9]+:\/\//i.test(v)) {
    const parts = v.split(':');
    if (parts.length >= 4 && /^\d+$/.test(parts[1])) {
      const [host, port, user, ...pass] = parts;
      v = `http://${encodeURIComponent(user)}:${encodeURIComponent(pass.join(':'))}@${host}:${port}`;
    } else {
      v = `http://${v}`;
    }
  }
  let u;
  try { u = new URL(v); } catch { throw new Error('That doesn\'t look like a proxy address (expected host:port:user:pass or http://user:pass@host:port)'); }
  if (!['http:', 'https:', 'socks5:'].includes(u.protocol)) throw new Error('Proxy must be http, https or socks5');
  if (!u.port) throw new Error('Proxy address needs a port');
  if (u.protocol === 'socks5:' && u.username) {
    throw new Error("Chrome can't use a SOCKS5 proxy with a username/password — use your provider's HTTP endpoint instead");
  }
  return u.toString().replace(/\/$/, '');
}

export function getProxyUrl() {
  return process.env.CHECKOUT_PROXY || readJson(SECRETS)._proxy?.url || '';
}

export function setProxyUrl(input) {
  const url = normalizeProxy(input);
  const data = readJson(SECRETS);
  if (url) data._proxy = { url };
  else delete data._proxy;
  writeSecret(data);
  return url;
}

/** Safe-to-show proxy info (never the password). */
export function proxyStatus() {
  const url = getProxyUrl();
  if (!url) return { set: false, source: null, server: null, user: null };
  try {
    const u = new URL(url.includes('://') ? url : `http://${url}`);
    const user = decodeURIComponent(u.username || '');
    return {
      set: true,
      source: process.env.CHECKOUT_PROXY ? 'env' : 'dashboard',
      server: `${u.protocol}//${u.host}`,
      user: user ? (user.length > 6 ? `${user.slice(0, 4)}…` : '…') : null,
    };
  } catch {
    return { set: true, source: process.env.CHECKOUT_PROXY ? 'env' : 'dashboard', server: '(unparseable)', user: null };
  }
}

/** Stores whose browser traffic goes through the proxy. */
export function proxiedStoreSet(cfg) {
  if (!getProxyUrl()) return new Set();
  const picked = getCheckoutSettings(cfg || {}).proxy_stores;
  return new Set(Array.isArray(picked) ? picked : RETAILERS);
}
