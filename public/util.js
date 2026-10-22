// Shared helpers for every dashboard module.
//
// These live in their own file rather than in app.js on purpose. The tab modules are
// loaded with dynamic import() from app.js, and if they imported app.js back for these
// helpers the cycle would deadlock: app.js sits on a top-level await for the dynamic
// import, which waits on app.js to finish evaluating. Keeping the shared surface in a
// leaf module means nothing imports upward.

export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

export const DIRS = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];
export const compass = (deg) => (deg == null ? null : DIRS[Math.round(((deg % 360) + 360) % 360 / 22.5) % 16]);

// Retained for modules not yet migrated to the continuous ramp in viz.js. The stepped
// classes no longer carry colour, so this is now just a hook for sizing.
export const scoreClass = () => 'sc';
export const fmtScore = (v) => (v == null ? '--' : v.toFixed(1));

// Offline state, read by the header. Ben opens this from a stand with one bar of signal,
// so every GET falls back to its last cached response rather than showing an error page.
export const net = { offline: false, cacheAge: null };

const CACHE_PREFIX = 'deerhunter:';

export async function api(path, opts) {
  const isGet = !opts || !opts.method || opts.method === 'GET';
  try {
    const res = await fetch(path, {
      ...opts,
      headers: opts?.body ? { 'Content-Type': 'application/json' } : undefined,
    });
    if (!res.ok) throw new Error(`${res.status} ${await res.text().catch(() => '')}`);
    const data = await res.json();
    if (isGet) {
      try { localStorage.setItem(CACHE_PREFIX + path, JSON.stringify({ at: Date.now(), data })); } catch { /* quota, or private mode */ }
      net.offline = false; net.cacheAge = null;
    }
    return data;
  } catch (err) {
    if (!isGet) throw err;
    let cached = null;
    try { cached = JSON.parse(localStorage.getItem(CACHE_PREFIX + path) || 'null'); } catch { cached = null; }
    if (!cached) throw err;
    net.offline = true;
    net.cacheAge = Math.max(net.cacheAge ?? 0, Date.now() - cached.at);
    return cached.data;
  }
}

// --- collapsible panels -----------------------------------------------------
//
// Explanatory banners earn their place the first time you read them and cost screen
// height every time after. These render as native <details>, collapsed by default once
// you've closed them, with the open/closed state remembered per key.
//
// Native <details> rather than a hand-rolled toggle: keyboard and screen-reader behavior
// come free, and it still works if the script that would have wired a custom toggle
// never runs.

const OPEN_PREFIX = 'deerhunter:open:';

export function isOpen(key, dflt = false) {
  try {
    const v = localStorage.getItem(OPEN_PREFIX + key);
    return v == null ? dflt : v === '1';
  } catch { return dflt; }
}

export function rememberOpen(key, open) {
  try { localStorage.setItem(OPEN_PREFIX + key, open ? '1' : '0'); } catch { /* private mode */ }
}

/**
 * @param key      stable id, used to remember open/closed
 * @param summary  the always-visible line (HTML)
 * @param body     the content revealed on expand (HTML)
 * @param opts     { open: default state, cls: extra classes on the details element }
 */
export function collapsible(key, summary, body, opts = {}) {
  const open = isOpen(key, opts.open ?? false);
  return `<details class="coll ${opts.cls ?? ''}" data-coll="${key}"${open ? ' open' : ''}>
    <summary>${summary}</summary>
    <div class="coll-body">${body}</div>
  </details>`;
}

// Call after inserting collapsibles so their state persists.
export function wireCollapsibles(root = document) {
  root.querySelectorAll('details[data-coll]').forEach((d) => {
    if (d.dataset.wired) return;
    d.dataset.wired = '1';
    d.addEventListener('toggle', () => rememberOpen(d.dataset.coll, d.open));
  });
}
