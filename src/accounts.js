// Store accounts — sign-in status per retailer and secrets entered from the
// dashboard (CVVs), so nothing has to be done on the server's command line.
//
//   data/accounts.json  — { retailer: { logged_in, checked_at, note } }
//   data/secrets.json   — { retailer: { cvv } }   (mode 600, never sent back out)
//
// Env vars (TARGET_CVV, …) still work and take precedence.

import { readFileSync, writeFileSync, existsSync, chmodSync } from 'fs';
import { resolve } from 'path';
import { DATA_DIR } from './checkout/ledger.js';
import { RETAILERS } from './config.js';

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
