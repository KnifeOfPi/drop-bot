// Live view — lets you drive a handed-off browser tab from the dashboard (phone
// friendly): the dashboard polls a JPEG of the tab and forwards your taps/typing.

import { getHandoff } from './checkout/index.js';

function pageFor(id) {
  const h = getHandoff(id);
  if (!h || h.page.isClosed()) return null;
  return h.page;
}

/** Returns { jpeg: Buffer, width, height, url, title } (width/height in CSS px) or null. */
export async function liveFrame(id) {
  const page = pageFor(id);
  if (!page) return null;
  const [width, height] = await page.evaluate(() => [window.innerWidth, window.innerHeight]);
  const jpeg = await page.screenshot({ type: 'jpeg', quality: 60, fullPage: false });
  return { jpeg, width, height, url: page.url(), title: await page.title().catch(() => '') };
}

/**
 * Input actions:
 *   { type: 'click', x, y }   — x/y as fractions 0..1 of the frame (resolution independent)
 *   { type: 'type', text }    — types into the focused field
 *   { type: 'key', key }      — e.g. Enter, Tab, Backspace
 *   { type: 'scroll', dy }    — CSS px, positive = down
 *   { type: 'back' } | { type: 'reload' } | { type: 'goto', url }
 */
export async function liveInput(id, a) {
  const page = pageFor(id);
  if (!page) return { ok: false, error: 'hand-off session is closed' };
  const [w, h] = await page.evaluate(() => [window.innerWidth, window.innerHeight]);
  switch (a.type) {
    case 'click': {
      const x = Math.max(0, Math.min(1, Number(a.x))) * w;
      const y = Math.max(0, Math.min(1, Number(a.y))) * h;
      await page.mouse.click(x, y);
      break;
    }
    case 'type':
      await page.keyboard.type(String(a.text ?? ''), { delay: 30 });
      break;
    case 'key':
      if (!/^[A-Za-z0-9]+$/.test(String(a.key))) return { ok: false, error: 'bad key' };
      await page.keyboard.press(String(a.key));
      break;
    case 'scroll':
      await page.mouse.wheel(0, Number(a.dy) || 0);
      break;
    case 'back':
      await page.goBack().catch(() => {});
      break;
    case 'reload':
      await page.reload().catch(() => {});
      break;
    case 'goto': {
      // Only same-site navigation (e.g. jump to cart) — never arbitrary URLs.
      const target = new URL(String(a.url), page.url());
      if (target.hostname !== new URL(page.url()).hostname) return { ok: false, error: 'can only navigate within the same site' };
      await page.goto(target.href).catch(() => {});
      break;
    }
    default:
      return { ok: false, error: 'unknown action' };
  }
  await page.waitForTimeout(300);
  return { ok: true };
}
