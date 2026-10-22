// Today: the front door.
//
// The app used to open on a 93-row table. The question most mornings is "do I go, and
// where" - so this answers that first and leaves the calendar as the planning view.
//
// Everything here is read-only and derived from the same API the other tabs use. Nothing
// is computed client-side that the server does not already know.

import { api, $, $$, esc, compass } from '/util.js';
import {
  ramp, skyFor, stars, RIDGE, stack, balanceWhenReady,
  vizCompass, vizThermo, vizArrow, vizDial, vizDistance,
} from '/viz.js';

let slot = null;      // 'AM' | 'PM', null means pick automatically
let data = null;

const grade = (v) => (v >= 8 ? 'Exceptional' : v >= 6.5 ? 'Strong' : v >= 5 ? 'Fair' : v >= 3.5 ? 'Slow' : 'Poor');

/** Scent-viable stands, best first. Blown stands are excluded outright. */
const ranked = (s) => (s?.stands ?? [])
  .filter((x) => x.verdict !== 'unsafe')
  .sort((a, b) => b.buckScore - a.buckScore);

/**
 * Why the backup might beat the primary on the day.
 *
 * The wind you get is rarely the wind you were forecast, so a second choice that differs
 * in a way that matters - cleaner air, more rest, different terrain - is a real hedge
 * rather than just the runner-up.
 */
function whyBackup(a, b) {
  if (!a || !b) return '';
  if (a.verdict !== 'safe' && b.verdict === 'safe') return 'cleaner wind than the primary';
  if ((b.daysSinceHunted ?? 99) > (a.daysSinceHunted ?? 99)) return 'more rested';
  if ((b.foodYards ?? 9999) < (a.foodYards ?? 9999)) return 'closer to food';
  if (b.terrain && b.terrain !== a.terrain) return `different terrain (${b.terrain})`;
  return 'next best on this wind';
}

function contribBar(c, maxAbs) {
  const v = c ?? 0;
  const pct = Math.min(50, (Math.abs(v) / Math.max(maxAbs, 0.35)) * 50);
  const flat = Math.abs(v) < 0.02;
  const col = flat ? 'var(--dim)' : v > 0 ? 'var(--moss)' : 'var(--rust)';
  return `<div class="contrib">
    <div class="track"><div class="mid"></div>
      <div class="fill ${v >= 0 ? 'pos' : 'neg'}" style="width:${pct.toFixed(1)}%"></div></div>
    <div class="cv"><span>${flat ? 'no effect' : v > 0 ? 'helping' : 'hurting'}</span>
      <b style="color:${col}">${v > 0 ? '+' : ''}${v.toFixed(2)}</b></div>
  </div>`;
}

function metricTiles(s) {
  const f = s.factors?.buck ?? {};
  const w = s.weather ?? {};
  const maxAbs = Math.max(...Object.values(f).map((x) => Math.abs(x.contribution ?? 0)), 0.35);
  const weak = (w.windConfidenceLabel ?? '') !== 'reliable';

  const tile = (k, v, sub, viz, contrib, off = false) => `<div class="m ${off ? 'off' : ''}">
    <div class="mh"><div><div class="k">${k}</div><div class="v">${v}</div><div class="s">${sub}</div></div>
    <div class="viz">${viz}</div></div>${contrib != null ? contribBar(contrib, maxAbs) : ''}</div>`;

  const hp = f.huntingPressure?.detail ?? {};
  return `<div class="metrics">
    ${tile('Wind + rain', `${Math.round(w.windMph ?? 0)} ${compass(w.windDirDeg) ?? ''}`,
      weak ? `<span style="color:var(--amber)">${esc(w.windConfidenceLabel ?? 'unknown')}</span>`
           : `gust ${Math.round(w.gustMph ?? 0)}`,
      vizCompass(w.windDirDeg, weak), f.precipitation?.contribution)}

    ${tile('Temp vs normal', `${Math.round(w.tempF ?? 0)}&deg;`,
      w.departureF != null ? `${w.departureF > 0 ? '+' : ''}${Math.round(w.departureF)} vs normal` : 'no normal',
      vizThermo(w.tempF ?? 50, w.tempNormalF ?? 50), f.tempDeparture?.contribution)}

    ${tile('24h change', w.tempChange24h != null ? `${w.tempChange24h > 0 ? '+' : ''}${Math.round(w.tempChange24h)}&deg;` : '--',
      esc(f.tempChange24h?.detail?.direction ?? 'no reading'),
      vizArrow(w.tempChange24h ?? 0), f.tempChange24h?.contribution)}

    ${tile('Barometer', w.pressureHpa ? Math.round(w.pressureHpa) : '--',
      w.pressureChange24h != null ? `${w.pressureChange24h > 0 ? '+' : ''}${w.pressureChange24h} / 24h` : 'no reading',
      vizArrow(w.pressureChange24h ?? 0, 6), f.pressureTrend?.contribution)}

    ${tile('Stand rest', hp.neverHunted ? '&infin;' : `${hp.daysSince ?? 0}d`,
      hp.neverHunted ? 'never hunted' : 'since last sat',
      vizDial(hp.neverHunted ? 1 : Math.min(1, (hp.daysSince ?? 0) / 14)), f.huntingPressure?.contribution)}

    ${tile('Food', `${f.foodProximity?.detail?.distanceYards ?? '--'}<span style="font-size:15px"> yd</span>`,
      'to nearest', vizDistance(f.foodProximity?.detail?.distanceYards, 700), f.foodProximity?.contribution)}

    ${tile('Water', `${f.waterProximity?.detail?.distanceYards ?? '--'}<span style="font-size:15px"> yd</span>`,
      'to nearest active', vizDistance(f.waterProximity?.detail?.distanceYards, 900), f.waterProximity?.contribution)}

    ${tile('Moon', `${Math.round(s.astro?.moon?.illumination ?? 0)}<span style="font-size:15px">%</span>`,
      'not scored', vizDial((s.astro?.moon?.illumination ?? 0) / 100, '#3d4530'), null, true)}
  </div>`;
}

function standRow(st, rank) {
  const isP = rank === 1;
  return `<div class="standpick ${isP ? 'p' : 's'}">
    <div class="rank">${rank}</div>
    <div class="body">
      <div class="k">${isP ? 'Primary' : 'Backup'}</div>
      <div class="nm">${esc(st.label)}</div>
      <div class="meta">
        <span class="verdictpill vp-${st.verdict}">${esc(st.verdict)}</span>
        <span>${st.daysSinceHunted == null ? 'never hunted' : `${st.daysSinceHunted}d rest`}</span>
        ${st.terrain ? `<span>${esc(st.terrain)}</span>` : ''}
        ${st.foodYards != null ? `<span>${st.foodYards}yd food</span>` : ''}
      </div>
      ${isP && st.thermalNotes?.[0] ? `<div class="thermal">${esc(st.thermalNotes[0])}</div>` : ''}
    </div>
    <div class="sc2">
      ${stack(st.buckScore, 'Buck', { mini: true, color: ramp(st.buckScore) })}
      ${stack(st.generalScore, 'Deer', { mini: true, cls: 'sec' })}
    </div>
  </div>`;
}

function pickBlock(s) {
  const r = ranked(s);
  if (!r.length) {
    return `<div class="picks none">
      <div class="k" style="font-family:var(--mono);font-size:9px;letter-spacing:2.4px;color:var(--dim);text-transform:uppercase">Nothing clear</div>
      <div class="nm">All stands blown on this wind</div>
      <div class="note">Every stand is downwind of marked bedding. Hunt a different wind, or mark more bedding so the check has something better to measure against.</div>
    </div>`;
  }
  return `<div class="picks">
    ${standRow(r[0], 1)}
    ${r[1] ? standRow(r[1], 2) : ''}
    ${r[1] ? `<div class="whyline">Backup is ${esc(whyBackup(r[0], r[1]))}.</div>` : ''}
  </div>`;
}

function heroFor(s, openSeasons) {
  const w = s.weather ?? {};
  const r = ranked(s);
  return `<div class="hero">
    <div class="sky" style="background:${skyFor(s.slot, w)}"></div>
    <svg class="stars" viewBox="0 0 100 100" preserveAspectRatio="none">${stars()}</svg>${RIDGE}
    <div class="inner">
      <div class="kick">
        ${(openSeasons ?? []).map((x) => `<span><span class="sdot" style="background:${x.color}"></span> ${esc(x.label)}</span>`).join('')}
        <span>${esc(s.rutPhase)} ${s.rutOffset >= 0 ? '+' : ''}${s.rutOffset}</span>
        <span>${s.slot === 'AM' ? 'MORNING' : 'EVENING'} SIT</span>
        <span>LIGHT ${esc(s.astro?.legalStart ?? '')}&ndash;${esc(s.astro?.legalEnd ?? '')}</span>
      </div>
      <div class="scorewrap">
        ${stack(s.buckScore, 'Buck', { cls: 'primary' })}
        ${stack(s.generalScore, 'Deer activity', { cls: 'secondary' })}
      </div>
      <div class="verdict">${grade(s.buckScore)} movement. ${r[0] ? `Sit <em>${esc(r[0].label)}</em>.` : '<em>No clear stand.</em>'}</div>
    </div>
  </div>`;
}

export async function mount() {
  const state = window.__dh.state;
  data = await api(`/api/forecast?days=${Math.max(8, state.forecast?.nearTermDays ?? 8)}`);

  const today = state.today;
  const todays = data.slots.filter((s) => s.date === today);

  // Before the season opens there is no "today" to show, so fall back to the first
  // scored slot rather than rendering an empty page.
  const pool = todays.length ? todays : data.slots.slice(0, 2);
  if (!pool.length) {
    $('#todayBody').innerHTML = `<div class="banner empty">
      <h4>Nothing scored yet</h4>
      Run a refresh, or check that your seasons cover a date range the forecast can reach.
    </div>`;
    return;
  }

  // Default to the sit that has not happened yet: mornings until midday, then evenings.
  if (!slot) slot = new Date().getHours() < 12 ? 'AM' : 'PM';
  const s = pool.find((x) => x.slot === slot) ?? pool[0];
  slot = s.slot;

  const w = s.weather ?? {};
  const conf = w.windConfidenceLabel ?? 'unknown';
  const next = data.slots.filter((x) => x.date > today && x.slot === 'AM').slice(0, 6);

  $('#todayBody').innerHTML = `
    <div class="card flush" style="overflow:hidden">
      ${heroFor(s, state.openToday)}
      ${metricTiles(s)}
      ${conf !== 'reliable' ? `<div class="lamp ${conf === 'unreliable' ? 'bad' : ''}">
        &#9650;&nbsp; WIND ${esc(conf.toUpperCase())} &mdash; scent call not trusted at ${Math.round(w.windMph ?? 0)} mph</div>` : ''}
      ${pickBlock(s)}
      ${next.length ? `<div class="weekstrip">${next.map((x) => `<div>
        <div class="d">${esc(x.weekday.toUpperCase())} ${x.date.slice(5)}</div>
        ${stack(x.buckScore, 'Buck', { mini: true, color: ramp(x.buckScore) })}
        <div class="g">${x.generalScore.toFixed(1)} deer</div>
        <div class="bar" style="background:${ramp(x.buckScore)};opacity:.85"></div>
      </div>`).join('')}</div>` : ''}
    </div>`;

  // Slot switch sits above the card so it reads as a control, not part of the forecast.
  $('#todayToolbar').innerHTML = `
    <div class="seg" id="slotSeg">
      <button data-s="AM" class="${slot === 'AM' ? 'active' : ''}">Morning</button>
      <button data-s="PM" class="${slot === 'PM' ? 'active' : ''}">Evening</button>
    </div>
    <span class="muted mono right" style="font-size:11px">
      ${todays.length ? today : `season opens ${data.slots[0]?.date ?? ''}`}
      &middot; <span class="conf ${esc(s.confidence)}">${esc(s.confidence)}</span>
    </span>`;
  $$('#slotSeg button').forEach((b) => { b.onclick = () => { slot = b.dataset.s; mount(); }; });

  await balanceWhenReady($('#todayBody'));
}
