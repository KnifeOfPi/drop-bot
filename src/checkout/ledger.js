// Checkout ledger — persists every real checkout attempt to data/orders.json so
// order limits and the spend cap survive daemon restarts.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = process.env.DROPBOT_DATA_DIR || resolve(__dirname, '..', '..', 'data');
export const SCREENSHOT_DIR = resolve(DATA_DIR, 'screenshots');
const LEDGER_PATH = resolve(DATA_DIR, 'orders.json');
const MAX_ENTRIES = 500;

mkdirSync(SCREENSHOT_DIR, { recursive: true });

function read() {
  if (!existsSync(LEDGER_PATH)) return { attempts: [] };
  try {
    const data = JSON.parse(readFileSync(LEDGER_PATH, 'utf8'));
    return Array.isArray(data.attempts) ? data : { attempts: [] };
  } catch (e) {
    console.error(`[ledger] orders.json unreadable (${e.message}) — refusing to assume zero orders`);
    // Fail closed: a corrupt ledger must not reset purchase limits.
    throw new Error('ledger unreadable');
  }
}

function write(data) {
  if (data.attempts.length > MAX_ENTRIES) data.attempts = data.attempts.slice(-MAX_ENTRIES);
  writeFileSync(LEDGER_PATH, JSON.stringify(data, null, 2));
}

/** Append an attempt. Returns its id. */
export function recordAttempt(entry) {
  const data = read();
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  data.attempts.push({ id, ts: Date.now(), ...entry });
  write(data);
  return id;
}

export function updateAttempt(id, patch) {
  const data = read();
  const a = data.attempts.find(x => x.id === id);
  if (a) Object.assign(a, patch, { updated_ts: Date.now() });
  else data.attempts.push({ id, ts: Date.now(), ...patch });
  write(data);
}

export function recentAttempts(n = 20) {
  try { return read().attempts.slice(-n).reverse(); } catch { return []; }
}

// "unconfirmed" = Place order was clicked but no confirmation was seen. It counts
// as an order for every limit so the bot can never double-buy after a timeout.
const COUNTS_AS_ORDER = new Set(['success', 'unconfirmed']);

export function successfulOrders(key) {
  return read().attempts.filter(a => COUNTS_AS_ORDER.has(a.status) && (!key || a.key === key));
}

export function totalSpend() {
  return successfulOrders().reduce((sum, a) => sum + (Number(a.total) || Number(a.price) || 0), 0);
}
