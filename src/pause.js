// Pause switch — stops ALL store activity (watching, search, queues, checkout,
// drawings, sign-in) and closes every store browser, so no store traffic and
// no proxy data is used. Saved in data/config.yaml (`paused: true`), so a
// daemon restart comes back paused. Resuming picks up on the next pass.

import { readFileSync, writeFileSync } from 'fs';
import yaml from 'js-yaml';
import { CONFIG_PATH, loadConfigFresh, clearConfigCache } from './config.js';
import { closeAll } from './session.js';

export function isPaused(cfg = loadConfigFresh()) {
  return !!cfg?.paused;
}

export function pauseStatus(cfg = loadConfigFresh()) {
  return { paused: !!cfg?.paused, since: cfg?.paused_at ?? null, reason: cfg?.paused ? (cfg?.paused_reason || 'manual') : null };
}

export const today = () => new Date().toLocaleDateString('en-CA');

/** reason: 'manual' (dashboard) or 'data_limit' (automatic — resumes the next day). */
export async function setPaused(paused, reason = 'manual') {
  const cfg = yaml.load(readFileSync(CONFIG_PATH, 'utf8')) || {};
  cfg.paused = !!paused;
  if (paused) {
    cfg.paused_at = Date.now();
    cfg.paused_reason = reason;
    if (reason === 'data_limit') cfg.data_limit_hit_day = today();
  } else {
    delete cfg.paused_at;
    delete cfg.paused_reason;
  }
  writeFileSync(CONFIG_PATH, yaml.dump(cfg, { lineWidth: 120, noRefs: true }));
  clearConfigCache();
  if (paused) await closeAll(); // closes every store browser (and any open hand-off / sign-in tab)
  console.log(`[pause] bot ${paused ? 'PAUSED — all store browsers closed' : 'resumed'}`);
  return pauseStatus(cfg);
}
