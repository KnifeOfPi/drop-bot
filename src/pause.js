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
  return { paused: !!cfg?.paused, since: cfg?.paused_at ?? null };
}

export async function setPaused(paused) {
  const cfg = yaml.load(readFileSync(CONFIG_PATH, 'utf8')) || {};
  cfg.paused = !!paused;
  if (paused) cfg.paused_at = Date.now();
  else delete cfg.paused_at;
  writeFileSync(CONFIG_PATH, yaml.dump(cfg, { lineWidth: 120, noRefs: true }));
  clearConfigCache();
  if (paused) await closeAll(); // closes every store browser (and any open hand-off / sign-in tab)
  console.log(`[pause] bot ${paused ? 'PAUSED — all store browsers closed' : 'resumed'}`);
  return pauseStatus(cfg);
}
