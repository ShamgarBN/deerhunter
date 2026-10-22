// Shared visual language: colour ramp, sky, miniature metric graphics, and the
// width-matching that keeps a score's label the same width as the number above it.
//
// Lives apart from util.js because these are presentation concerns with no bearing on
// data fetching, and apart from the tab modules because every tab draws scores.

export const RAMP_STOPS = [
  [0, [92, 46, 38]], [0.35, [170, 74, 46]], [0.58, [205, 150, 62]],
  [0.8, [134, 168, 94]], [1, [160, 200, 104]],
];

/**
 * Score colour on a CONTINUOUS rust-to-moss ramp.
 *
 * Continuous rather than stepped buckets on purpose: a 6.9 and a 7.1 are the same day in
 * practice, and the old tiered palette rendered them as different species.
 */
export function ramp(v) {
  const t = Math.max(0, Math.min(1, (v ?? 0) / 10));
  let a = RAMP_STOPS[0];
  let b = RAMP_STOPS.at(-1);
  for (let i = 0; i < RAMP_STOPS.length - 1; i++) {
    if (t >= RAMP_STOPS[i][0] && t <= RAMP_STOPS[i + 1][0]) { a = RAMP_STOPS[i]; b = RAMP_STOPS[i + 1]; break; }
  }
  const f = (t - a[0]) / ((b[0] - a[0]) || 1);
  return `rgb(${a[1].map((x, i) => Math.round(x + (b[1][i] - x) * f)).join(',')})`;
}

/**
 * Dawn or dusk gradient, driven by the real slot and conditions.
 *
 * Decoration keyed to data, never a substitute for it: the verdict line and the warning
 * lamp do the telling. A grey sky should not feel like bad news before a number is read.
 */
export function skyFor(slot, wx) {
  const cloudy = (wx?.skyCover ?? 40) > 62;
  const dep = wx?.departureF ?? 0;
  if (cloudy) {
    return slot === 'AM'
      ? 'linear-gradient(180deg,#232a2e 0%,#3b4449 46%,#5b6560 100%)'
      : 'linear-gradient(180deg,#1e2328 0%,#343c40 46%,#4d5450 100%)';
  }
  if (slot === 'AM') {
    return dep <= -5
      ? 'linear-gradient(180deg,#0a1222 0%,#16263f 42%,#3a4458 66%,#9a6e42 86%,#e0a451 100%)'
      : 'linear-gradient(180deg,#101829 0%,#223350 40%,#4d4a55 66%,#a87248 86%,#e8a95c 100%)';
  }
  return 'linear-gradient(180deg,#0f1322 0%,#2a2740 36%,#5e3b45 64%,#a8533a 86%,#d9703f 100%)';
}

// Drawn in the viewBox's own units: preserveAspectRatio="none" on a wide, short hero
// would otherwise stretch round stars into blobs.
export const stars = (n = 26) => {
  let s = '';
  for (let i = 0; i < n; i++) {
    const x = ((i * 83) % 100).toFixed(1);
    const y = ((i * 37) % 38).toFixed(1);
    const r = i % 4 === 0 ? 0.5 : 0.3;
    const o = (0.3 + ((i % 5) / 10)).toFixed(2);
    s += `<ellipse cx="${x}" cy="${y}" rx="${(r * 0.35).toFixed(2)}" ry="${r}" fill="#fff" opacity="${o}"/>`;
  }
  return s;
};

export const RIDGE = `<svg class="ridge" viewBox="0 0 1200 240" preserveAspectRatio="none">
  <path d="M0,146 C130,110 210,162 320,134 C440,104 512,150 632,122 C752,94 832,142 952,118 C1062,96 1140,136 1200,116 L1200,240 L0,240 Z" fill="rgba(10,14,8,.58)"/>
  <path d="M0,180 C150,154 250,196 370,172 C510,144 590,186 710,166 C850,142 940,182 1070,162 C1140,152 1176,170 1200,164 L1200,240 L0,240 Z" fill="rgba(6,9,5,.9)"/></svg>`;

// --- miniature metric graphics ----------------------------------------------
// Each is shaped like the thing it describes, so the row scans as pictures rather than
// eight identical bars.

export function vizCompass(dir, weak, size = 40) {
  if (dir == null) return '';
  const R = size * 0.425;
  const c = size / 2;
  const scent = (dir + 180) % 360;
  const pt = (a, r) => [c + r * Math.sin((a * Math.PI) / 180), c - r * Math.cos((a * Math.PI) / 180)];
  const [p1x, p1y] = pt(scent - 34, R - 2);
  const [p2x, p2y] = pt(scent + 34, R - 2);
  return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" aria-hidden="true">
    <circle cx="${c}" cy="${c}" r="${R}" fill="none" stroke="#3d4530"/>
    <path d="M ${c} ${c} L ${p1x.toFixed(1)} ${p1y.toFixed(1)} A ${R - 2} ${R - 2} 0 0 1 ${p2x.toFixed(1)} ${p2y.toFixed(1)} Z"
      fill="rgba(201,99,58,${weak ? '.18' : '.34'})" stroke="rgba(201,99,58,${weak ? '.35' : '.65'})"
      ${weak ? 'stroke-dasharray="2,2"' : ''}/>
    <circle cx="${c}" cy="${size * 0.09}" r="1.2" fill="#6b7355"/></svg>`;
}

export function vizThermo(t, norm) {
  const lo = Math.min(t, norm) - 18;
  const hi = Math.max(t, norm) + 18;
  const p = (v) => ((v - lo) / (hi - lo)) * 34 + 3;
  return `<svg width="40" height="40" viewBox="0 0 40 40" aria-hidden="true">
    <rect x="17" y="3" width="6" height="34" rx="3" fill="#262b1b"/>
    <rect x="17" y="${(40 - p(t)).toFixed(1)}" width="6" height="${(p(t) - 3).toFixed(1)}" rx="3"
      fill="${t < norm ? '#7fa8b8' : '#c9633a'}"/>
    <line x1="12" y1="${(40 - p(norm)).toFixed(1)}" x2="28" y2="${(40 - p(norm)).toFixed(1)}"
      stroke="#9aa37e" stroke-dasharray="2,2"/></svg>`;
}

export function vizArrow(d, full = 12) {
  const up = d > 0;
  const mag = Math.min(1, Math.abs(d ?? 0) / full);
  const col = up ? '#c9633a' : '#7fa8b8';
  return `<svg width="40" height="40" viewBox="0 0 40 40" aria-hidden="true">
    <line x1="20" y1="34" x2="20" y2="6" stroke="#262b1b" stroke-width="3"/>
    <line x1="20" y1="${up ? 34 : 6}" x2="20" y2="${up ? (34 - 28 * mag).toFixed(1) : (6 + 28 * mag).toFixed(1)}"
      stroke="${col}" stroke-width="3"/>
    <path d="${up ? 'M14,12 L20,5 L26,12' : 'M14,28 L20,35 L26,28'}" fill="none" stroke="${col}"
      stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

export function vizDial(frac, color = '#86a85e') {
  const R = 16;
  const C = 2 * Math.PI * R;
  const p = Math.max(0, Math.min(1, frac ?? 0));
  return `<svg width="40" height="40" viewBox="0 0 40 40" aria-hidden="true">
    <circle cx="20" cy="20" r="${R}" fill="none" stroke="#262b1b" stroke-width="4"/>
    <circle cx="20" cy="20" r="${R}" fill="none" stroke="${color}" stroke-width="4" stroke-linecap="round"
      stroke-dasharray="${(C * p).toFixed(1)} ${C.toFixed(1)}" transform="rotate(-90 20 20)"/></svg>`;
}

export function vizDistance(yd, max) {
  const f = 1 - Math.max(0, Math.min(1, (yd ?? max) / max));
  return `<svg width="40" height="40" viewBox="0 0 40 40" aria-hidden="true">
    ${[0, 1, 2, 3].map((i) => `<rect x="${4 + i * 9}" y="${28 - i * 6}" width="6" height="${8 + i * 6}" rx="1.5"
      fill="${(f * 4) > i ? '#86a85e' : '#262b1b'}"/>`).join('')}</svg>`;
}

// --- score + label balancing -------------------------------------------------

/**
 * Scale a score's label so it sits almost exactly as wide as the number above it.
 *
 * Measured rather than hardcoded, because "5.5" and "10.0" are different widths and
 * "BUCK" and "DEER ACTIVITY" are different lengths: a fixed font-size can only ever
 * balance one combination. The label is scaled to a fraction of the number's width and
 * the last few pixels are closed with letter-spacing.
 */
export function balanceStack(stack, { target = 0.97, maxRatio = 0.44 } = {}) {
  const n = stack.querySelector('.n');
  const l = stack.querySelector('.lab');
  if (!n || !l) return;

  const numW = n.getBoundingClientRect().width;
  const numSize = parseFloat(getComputedStyle(n).fontSize);
  if (!numW) return;

  l.style.letterSpacing = '0px';
  l.style.fontSize = '20px';
  const baseW = l.getBoundingClientRect().width;
  if (!baseW) return;

  const size = Math.min((20 * (numW * target)) / baseW, numSize * maxRatio);
  l.style.fontSize = `${size.toFixed(1)}px`;

  const w2 = l.getBoundingClientRect().width;
  const chars = Math.max(1, l.textContent.trim().length - 1);
  const extra = (numW * target - w2) / chars;
  l.style.letterSpacing = `${Math.max(0, Math.min(extra, size * 0.42)).toFixed(2)}px`;
}

export function balanceAll(root = document) {
  root.querySelectorAll('.stack').forEach((st) => balanceStack(st, st.classList.contains('mini')
    ? { target: 0.94, maxRatio: 0.40 }
    : { target: 0.97, maxRatio: 0.44 }));
}

/**
 * Balance once the webfont has actually loaded.
 *
 * Measuring before it lands balances every label against a fallback face and lands wrong,
 * and the error is invisible until someone wonders why the labels look slightly off.
 */
export async function balanceWhenReady(root = document) {
  try { if (document.fonts?.ready) await document.fonts.ready; } catch { /* no font API */ }
  balanceAll(root);
}

/** Markup for a score with its label beneath it. */
export function stack(value, label, { cls = '', color = null, mini = false } = {}) {
  const v = value == null ? '--' : Number(value).toFixed(1);
  return `<span class="stack ${mini ? 'mini' : ''} ${cls}">
    <span class="n"${color ? ` style="color:${color}"` : ''}>${v}</span><span class="lab">${label}</span>
  </span>`;
}
