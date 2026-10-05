// DeerHunter dashboard.
//
// Offline behavior matters here more than in most tools: Ben opens this from a stand with
// one bar of signal at 5:50am. Every GET is cached to localStorage and replayed if the
// fetch fails, with the cache age shown in the header so a stale number never passes for
// a live one.

import { $, $$, esc, api, net, compass, scoreClass, fmtScore, collapsible, wireCollapsibles } from '/util.js';

let state = {};
let calendar = null;
// Mirrors config.scent.safeAngleThresholdDeg, used only for the tooltip that explains how
// far a weapon tightens it.
const cfgScentThreshold = 115;

// --- what the badges and abbreviations mean --------------------------------
//
// These appear on every row of the calendar and none of them are self-explanatory, so
// each is spelled out on hover against its own actual values rather than generically.

const CONFIDENCE_HELP = {
  observed: {
    short: 'Observed',
    text: 'This slot has already passed. Temperature, wind and pressure are real measurements from the nearest reporting station, not a forecast. The most trustworthy row on the page.',
  },
  forecast: {
    short: 'Forecast',
    text: 'Real forecast data, inside the window where it holds up: NWS for temperature, precipitation and sky cover, Open-Meteo for wind and barometric pressure. Every factor is live.',
  },
  outlook: {
    short: 'Outlook',
    text: 'Still real forecast data, but past the confidence window where it is dependable. Directionally useful for planning, soft on specifics. Treat the wind here as a hint rather than a plan.',
  },
  climatology: {
    short: 'Climatology',
    text: 'Past the forecast horizon entirely. There is no weather for this day yet, so the score is the rut curve plus stand pressure plus 30-year climate normals. Rain, wind and pressure all read zero because they are genuinely unknown, which also means no scent verdict is possible.',
  },
};

const WIND_CONF_HELP = {
  reliable: 'Wind is strong and steady enough to trust the scent verdict.',
  marginal: 'Wind is light or inconsistent enough that the scent verdict is shaky. Check it yourself in the stand.',
  unreliable: 'Too light or too variable to call scent from a forecast bearing. Below about 3 mph thermals decide where your scent goes, not the wind.',
};

// Builds the hover text for the conditions cell from that slot's real numbers, so the
// explanation names the figures you are actually looking at.
function conditionsTooltip(w, date, slot) {
  if (!w) return 'No weather for this slot.';
  const L = [`${date} ${slot ?? ''}`.trim()];
  if (w.tempF != null) {
    L.push(`${Math.round(w.tempF)}°F — mean temperature across the whole sit${w.tempMinF != null && w.tempMaxF != null ? ` (ranged ${Math.round(w.tempMinF)}–${Math.round(w.tempMaxF)}°F within the window)` : ''}`);
  }
  if (w.departureF != null) {
    const d = Math.round(w.departureF);
    L.push(`${d > 0 ? '+' : ''}${d}° — versus the 30-year climate normal for this date and slot. ${d <= -5 ? 'Colder than normal, which reads positive for movement.' : d >= 5 ? 'Warmer than normal, which suppresses it.' : 'Close to normal.'}`);
  }
  if (w.windMph != null) {
    L.push(`${Math.round(w.windMph)} ${compass(w.windDirDeg) ?? ''} — wind speed in mph and the direction it blows FROM. Your scent travels the opposite way.${w.gustMph != null ? ` Gusting ${Math.round(w.gustMph)}.` : ''}`);
  }
  if (w.windConfidenceLabel) {
    const mark = w.windConfidenceLabel === 'unreliable' ? '?' : w.windConfidenceLabel === 'marginal' ? '~' : '';
    L.push(`${mark ? `${mark} — ` : ''}${WIND_CONF_HELP[w.windConfidenceLabel] ?? ''}`);
  }
  if (w.precipProb != null && w.precipProb >= 20) L.push(`${Math.round(w.precipProb)}% — peak chance of precipitation at any hour of the sit.`);
  if (w.pressureChange24h != null) L.push(`Barometer ${w.pressureChange24h > 0 ? '+' : ''}${w.pressureChange24h} hPa versus this slot yesterday.`);
  if (w.tempChange24h != null) L.push(`Temperature ${w.tempChange24h > 0 ? '+' : ''}${Math.round(w.tempChange24h)}° versus this slot yesterday.`);
  return L.join('\n');
}

// --- formatting -------------------------------------------------------------

const BUCK_HELP = 'Buck score, 0-10. How likely a mature, rut-influenced buck is moving in daylight. Driven primarily by rut phase.';
const DEER_HELP = 'General activity score, 0-10. How likely you are to see a deer at all, any age or sex. Driven more by food, water, stand pressure and weather than by rut phase.';

function scoreCell(buck, general) {
  return `<span class="${scoreClass(buck)} help" title="${BUCK_HELP}">${fmtScore(buck)}</span>
          <span class="${scoreClass(general)} help" title="${DEER_HELP}" style="margin-left:3px">${fmtScore(general)}</span>`;
}

function conditionsText(w, date, slot) {
  if (!w) return '<span class="dim">--</span>';
  const bits = [];
  if (w.tempF != null) {
    const d = w.departureF;
    const sign = d == null ? '' : ` <span class="${d <= -5 ? 'wk' : 'dim'}">${d > 0 ? '+' : ''}${Math.round(d)}</span>`;
    bits.push(`${Math.round(w.tempF)}&deg;${sign}`);
  }
  if (w.windMph != null) {
    // Flag wind the scent check cannot be trusted on, rather than showing a bare bearing
    // that looks as authoritative at 1 mph as at 15.
    const conf = w.windConfidenceLabel;
    const flag = conf === 'unreliable' ? ` <span style="color:var(--red)" title="${esc(WIND_CONF_HELP.unreliable)}">?</span>`
      : conf === 'marginal' ? ` <span style="color:var(--amber)" title="${esc(WIND_CONF_HELP.marginal)}">~</span>` : '';
    bits.push(`${Math.round(w.windMph)}${compass(w.windDirDeg) ? ` ${compass(w.windDirDeg)}` : ''}${flag}`);
  }
  if (w.precipProb != null && w.precipProb >= 20) bits.push(`<span style="color:var(--blue)">${Math.round(w.precipProb)}%</span>`);
  if (!bits.length) return '<span class="dim">--</span>';
  return `<span class="mono help" style="font-size:11.5px" title="${esc(conditionsTooltip(w, date, slot))}">${bits.join(' · ')}</span>`;
}

// --- header -----------------------------------------------------------------

function renderChips() {
  const c = [];
  if (net.offline) {
    const mins = Math.round((net.cacheAge ?? 0) / 60000);
    const label = mins < 60 ? `${mins}m ago` : `${Math.round(mins / 60)}h ago`;
    c.push(`<span class="chip stale">OFFLINE &middot; cached <b>${label}</b></span>`);
  }
  if (state.rutToday) {
    const off = state.rutToday.offset;
    c.push(`<span class="chip"><b>${esc(state.rutToday.phaseLabel)}</b> ${off >= 0 ? '+' : ''}${off}d</span>`);
  }
  if (state.inSeason === false) c.push(`<span class="chip">season opens in <b>${state.daysToSeason}d</b></span>`);
  if (state.drought?.severity > 0) {
    const lbl = state.drought.severity >= 0.9 ? 'extreme' : state.drought.severity >= 0.6 ? 'severe' : 'dry';
    c.push(`<span class="chip warn">drought <b>${lbl}</b></span>`);
  }
  if (!state.calibrated) c.push('<span class="chip warn">uncalibrated</span>');
  if (state.counts) {
    const k = state.counts;
    c.push(`<span class="chip">${k.stands} stands &middot; ${k.food} food &middot; ${k.water} water &middot; ${k.bedding} bedding</span>`);
    if (k.waterDry) c.push(`<span class="chip warn">${k.waterDry} water dry</span>`);
  }
  if (state.lastRefresh) {
    const h = Math.round((Date.now() - Date.parse(state.lastRefresh)) / 3600000);
    c.push(`<span class="chip ${h > 30 ? 'warn' : ''}">refreshed <b>${h < 1 ? 'just now' : `${h}h ago`}</b></span>`);
  }
  c.push('<button class="btn sm" id="doRefresh">Refresh</button>');
  $('#chips').innerHTML = c.join('');
  syncStickyOffsets();

  $('#doRefresh').onclick = async (e) => {
    e.target.disabled = true; e.target.textContent = 'Refreshing...';
    try { await api('/api/refresh', { method: 'POST', body: '{}' }); await boot(); }
    catch (err) { alert(`Refresh failed: ${err.message}`); }
    finally { e.target.disabled = false; e.target.textContent = 'Refresh'; }
  };
}

// --- season landmarks -------------------------------------------------------
//
// These were six stacked banners taking most of a screen before you reached the calendar,
// which is backwards: you read them once in September and then want them out of the way.
// Now it is one line you can always see, with the detail one click down and the open or
// closed state remembered.

const PHASE_TONE = { chasing: 'hot', seeking: 'hot', second: 'warm', postrut: 'cold', lockdown: 'warm' };
const SHORT_PHASE = { seeking: 'Seeking', chasing: 'Chasing', lockdown: 'Lockdown', postrut: 'Lull', second: '2nd rut' };

function renderHighlights() {
  if (!calendar?.highlights) return;
  const peak = calendar.peakRutDate;
  const open0 = calendar.days[0];

  // Compact labels and ranges: the strip has to survive on a phone without wrapping to
  // three rows, which is the whole reason it replaced the stack of banners.
  const range = (h) => {
    if (!h.through) return h.date.slice(5);
    const a = h.date.slice(5);
    const b = h.through.slice(5);
    return a.slice(0, 2) === b.slice(0, 2) ? `${a}–${b.slice(3)}` : `${a}–${b}`;
  };
  const timeline = calendar.highlights
    .map((h) => `<span class="${PHASE_TONE[h.key] ?? ''}"><b>${esc(SHORT_PHASE[h.key] ?? h.label)}</b> ${range(h)}</span>`)
    .join('');

  const detail = calendar.highlights.map((h) => `
    <div style="margin:7px 0">
      <b>${esc(h.label)}</b>
      <span class="mono dim" style="font-size:11px"> ${h.date}${h.through ? ` to ${h.through}` : ''}</span><br>
      ${esc(h.note)}
    </div>`).join('');

  const body = `
    <div style="margin-bottom:9px">
      Peak breeding is set to <b>${peak}</b>, and everything on this page is computed as day-offsets from
      that single date. Change it on the Model tab and the whole season re-shapes. Gun season opens
      <b>${calendar.season.start}</b>, day ${open0?.rutOffset >= 0 ? '+' : ''}${open0?.rutOffset ?? '?'} on the curve.
    </div>
    ${detail}`;

  // A readable key, not only hover text. Tooltips are invisible until you already suspect
  // something needs explaining, and half of these abbreviations give no such hint.
  const key = collapsible('column-key',
    '<b>What the columns mean</b><span class="sum-note">score badges, data-confidence codes, conditions</span>',
    `<div class="keygrid">
      <div class="keysec"><h5>The two scores</h5>
        <div><span class="sc s8">8.2</span><span class="sc s5">5.4</span></div>
        <p><b>Buck</b> then <b>deer</b>. Buck is how likely a mature, rut-influenced buck is moving in daylight,
        driven mostly by rut phase. Deer is how likely you see anything at all, driven more by food, water,
        stand pressure and weather. They disagree often, and that is the point: a post-rut evening on a green
        field can be a poor buck day and a fine deer day.</p>
      </div>

      <div class="keysec"><h5>Data confidence, on the date</h5>
        <div class="keyrow"><span class="conf observed">OBSE</span><span><b>Observed.</b> Already happened. Real measurements from the nearest reporting station.</span></div>
        <div class="keyrow"><span class="conf forecast">FORE</span><span><b>Forecast.</b> Real forecast data inside the window where it holds up. Every factor is live.</span></div>
        <div class="keyrow"><span class="conf outlook">OUTL</span><span><b>Outlook.</b> Real forecast, but past the dependable window. Directional, soft on specifics.</span></div>
        <div class="keyrow"><span class="conf climatology">CLIM</span><span><b>Climatology.</b> No weather exists for this day yet. Score is the rut curve plus stand pressure plus 30-year normals; rain, wind and pressure read zero because they are genuinely unknown, so no scent verdict is possible.</span></div>
      </div>

      <div class="keysec"><h5>Conditions, read left to right</h5>
        <p class="mono" style="font-size:12px;color:var(--text)">90&deg; <span class="dim">+19</span> &middot; 5 SSW <span style="color:var(--red)">?</span> &middot; <span style="color:var(--blue)">40%</span></p>
        <ul>
          <li><b>90&deg;</b> mean temperature across the whole five-hour sit, not a single moment.</li>
          <li><b>+19</b> degrees above or below the 30-year normal for that date and slot. Colder than normal reads positive for movement.</li>
          <li><b>5 SSW</b> wind in mph and the direction it blows <i>from</i>. Your scent travels the opposite way.</li>
          <li><b>?</b> wind too light or variable to call scent from; below about 3 mph thermals decide, not the wind. <b>~</b> means marginal. No mark means trustworthy.</li>
          <li><b>40%</b> peak chance of rain at any hour of the sit, shown from 20% up.</li>
        </ul>
      </div>

      <div class="keysec"><h5>The rest</h5>
        <ul>
          <li><b>Colour stripe</b> on the date: which seasons are open. Two colours means both are, and the stricter weapon governs the scent check.</li>
          <li><b>Moon</b> percent illuminated. Shown because it is worth knowing, weighted <b>zero</b> because collar studies found no measurable movement effect.</li>
          <li><b>Rut</b> days from the peak breeding date. Negative is before it. The buck score peaks near day &minus;4, during chasing, not at day 0 &mdash; dominant bucks go quiet with a doe during lockdown.</li>
          <li><b>Free</b> mark the sits you can actually take. A 9.9 on a Tuesday you cannot take off is trivia.</li>
        </ul>
      </div>
    </div>`,
    { open: false });

  $('#highlights').innerHTML = collapsible('season-highlights', `<span class="tl">${timeline}</span>`, body, { open: false }) + key;
  wireCollapsibles($('#highlights'));
}

// --- season calendar --------------------------------------------------------

let calFilter = 'all';

function renderCalendar() {
  if (!calendar) return;
  const today = state.today;
  let days = calendar.days;

  if (calFilter === 'avail') days = days.filter((d) => d.available.AM || d.available.PM);
  if (calFilter === 'best') {
    days = [...calendar.days]
      .map((d) => ({ d, top: Math.max(d.slots.AM?.buckScore ?? 0, d.slots.PM?.buckScore ?? 0, d.slots.AM?.generalScore ?? 0, d.slots.PM?.generalScore ?? 0) }))
      .sort((a, b) => b.top - a.top).slice(0, 15).map((x) => x.d)
      .sort((a, b) => a.date.localeCompare(b.date));
  }

  let lastPhase = null;
  const rows = [];
  for (const d of days) {
    if (calFilter === 'all' && d.rutPhase !== lastPhase) {
      const ph = calendar.phases.find((p) => p.key === d.rutPhase);
      rows.push(`<tr class="phaserow"><td colspan="8">${esc(ph?.label ?? d.rutPhase)}
        <span class="blurb">${esc(ph?.blurb ?? '')}</span></td></tr>`);
      lastPhase = d.rutPhase;
    }
    const wd = d.weekday;
    const isWeekend = wd === 'Sat' || wd === 'Sun';
    const am = d.slots.AM; const pm = d.slots.PM;
    const huntedAM = d.hunted?.AM; const huntedPM = d.hunted?.PM;
    const conf = am?.confidence ?? pm?.confidence;

    // Season stripe on the date cell. Overlapping seasons stack as a gradient, which is
    // the honest rendering: on those days both are genuinely open.
    const open = d.seasons ?? [];
    const stripe = open.length === 0 ? 'transparent'
      : open.length === 1 ? open[0].color
      : `linear-gradient(${open.map((x, i) => `${x.color} ${(i / open.length) * 100}%, ${x.color} ${((i + 1) / open.length) * 100}%`).join(',')})`;
    const seasonTitle = open.length
      ? `${open.map((x) => `${x.label} (${x.weapon})`).join(' + ')}${d.scent?.strictness > 1 ? ` — scent threshold tightened to ${Math.round((cfgScentThreshold) * d.scent.strictness)}° by ${d.scent.weaponLabel}` : ''}`
      : 'no season open';

    rows.push(`<tr class="${d.date === today ? 'today ' : ''}${d.available.AM || d.available.PM ? 'avail' : ''}" data-date="${d.date}">
      <td class="mono seasoncell" style="font-size:12px">
        <i class="seasonstripe" style="background:${stripe}" title="${esc(seasonTitle)}"></i><span title="${esc(seasonTitle)}">${d.date.slice(5)}</span>${conf ? `<span class="conf help ${conf}" style="margin-left:5px" title="${esc(`${CONFIDENCE_HELP[conf]?.short ?? conf} — ${CONFIDENCE_HELP[conf]?.text ?? ''}`)}">${conf.slice(0, 4).toUpperCase()}</span>` : ''}</td>
      <td class="wd ${isWeekend ? 'wk' : ''}">${wd}</td>
      <td>${am ? scoreCell(am.buckScore, am.generalScore) : ''}${huntedAM ? `<span class="huntdot ${huntedAM.sawDeer ? 'saw' : 'none'}" title="${huntedAM.sawDeer ? `saw ${huntedAM.deerCount}` : 'hunted, no deer'}"></span>` : ''}</td>
      <td>${pm ? scoreCell(pm.buckScore, pm.generalScore) : ''}${huntedPM ? `<span class="huntdot ${huntedPM.sawDeer ? 'saw' : 'none'}" title="${huntedPM.sawDeer ? `saw ${huntedPM.deerCount}` : 'hunted, no deer'}"></span>` : ''}</td>
      <td>${conditionsText(pm?.weather ?? am?.weather, d.date, pm?.weather ? 'PM' : 'AM')}</td>
      <td class="mono dim help" style="font-size:11px" title="${esc(`${Math.round(d.moon.illumination)}% illuminated — ${d.moon.phaseName}. Shown for reference and weighted ZERO: multiple independent collar studies found no measurable effect of moon phase on deer movement, including the solunar overhead/underfoot theory. It does not move either score.`)}">${Math.round(d.moon.illumination)}%</td>
      <td class="muted help" style="font-size:12px" title="${esc(`Day ${d.rutOffset >= 0 ? '+' : ''}${d.rutOffset} from the peak breeding date (${calendar.peakRutDate}). Negative is before the peak, positive after. The whole rut curve is computed from this offset, and the buck score peaks during chasing around day -4, not at day 0, because dominant bucks go quiet with an estrous doe during lockdown.`)}">${d.rutOffset >= 0 ? '+' : ''}${d.rutOffset}</td>
      <td>
        <button class="availbtn ${d.available.AM ? 'on' : ''}" data-av="AM" data-date="${d.date}" title="Mark the morning sit as a time you are actually free to hunt. Highlighted days feed the 'Available only' filter and the best-on-days-you're-free lists.">AM</button>
        <button class="availbtn ${d.available.PM ? 'on' : ''}" data-av="PM" data-date="${d.date}" title="Mark the evening sit as a time you are actually free to hunt.">PM</button>
      </td>
    </tr>`);
  }

  $('#calBody').innerHTML = rows.join('');

  const TH_HELP = {
    DATE: 'Date, with a colour stripe for whichever seasons are open and a badge for how much real weather is behind the score.',
    'AM BUCK / DEER': 'Morning sit: sunrise minus one hour, running five hours. First number is the buck score, second is general deer activity.',
    'PM BUCK / DEER': 'Evening sit: sunset minus four hours, running five hours to an hour past dark. First number is the buck score, second is general deer activity.',
    CONDITIONS: 'Temperature, departure from the 30-year normal, wind speed and the direction it blows from, and chance of rain. Hover any row for the full reading.',
    MOON: 'Illumination percent. Reference only, weighted zero.',
    RUT: 'Days from the peak breeding date. Negative is before it.',
    FREE: 'Days you are free to hunt.',
  };
  $$('.caltable thead th').forEach((th) => {
    const k = th.textContent.trim().toUpperCase().replace(/\s+/g, ' ');
    if (TH_HELP[k]) { th.title = TH_HELP[k]; th.classList.add('help'); }
  });

  const legend = (calendar.seasons ?? []).map((s2) =>
    `<span class="slegend" title="${esc(s2.weapon)} · ${s2.start} to ${s2.end}"><i style="background:${s2.color}"></i>${esc(s2.label)}</span>`).join('');
  $('#calLegend').innerHTML = `${legend}<span class="dim" style="margin-left:10px">buck &middot; deer</span>`;

  $$('#calBody .availbtn').forEach((b) => {
    b.onclick = async () => {
      const date = b.dataset.date;
      const day = calendar.days.find((d) => d.date === date);
      const slot = b.dataset.av;
      day.available[slot] = !day.available[slot];
      await api('/api/availability', { method: 'POST', body: JSON.stringify({ date, am: day.available.AM, pm: day.available.PM }) });
      renderCalendar();
      syncAvailButtons();
    };
  });
}

// --- availability bulk controls ---------------------------------------------
//
// Marking every weekend is the common opening move. Having no way to undo it was a real
// gap: one click could only be reversed by clicking roughly forty buttons by hand. The
// weekend button now reads the current state and flips.

function weekendsAllMarked() {
  const weekends = (calendar?.days ?? []).filter((d) => d.weekday === 'Sat' || d.weekday === 'Sun');
  return weekends.length > 0 && weekends.every((d) => d.available.AM && d.available.PM);
}

const anyMarked = () => (calendar?.days ?? []).some((d) => d.available.AM || d.available.PM);

function syncAvailButtons() {
  const mark = $('#markWeekends');
  const clear = $('#clearAvail');
  if (!mark || !clear) return;
  const allMarked = weekendsAllMarked();
  mark.textContent = allMarked ? 'Clear weekends' : 'Mark weekends available';
  mark.dataset.clear = allMarked ? '1' : '';
  clear.classList.toggle('hide', !anyMarked());
}

// --- near-term --------------------------------------------------------------

const FACTOR_LABELS = {
  precipitation: 'Rain + wind', huntingPressure: 'Stand pressure', foodProximity: 'Food',
  waterProximity: 'Water', tempDeparture: 'Temp vs normal', tempChange24h: 'Temp drop (24h)',
  pressureTrend: 'Barometer', cloudCover: 'Cloud', moonIllumination: 'Moon',
};

function factorRows(contribs) {
  const entries = Object.entries(contribs || {})
    .map(([k, v]) => ({ k, ...v }))
    .sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution));
  const max = Math.max(0.6, ...entries.map((e) => Math.abs(e.contribution)));
  return entries.map((e) => {
    const pct = (Math.abs(e.contribution) / max) * 50;
    const zero = Math.abs(e.contribution) < 0.02;
    const d = e.detail || {};
    let sub = '';
    if (e.k === 'tempDeparture' && d.departureF != null) sub = `${d.departureF > 0 ? '+' : ''}${d.departureF}&deg; vs normal`;
    else if (e.k === 'tempChange24h' && d.deltaF != null) sub = `${d.deltaF > 0 ? '+' : ''}${d.deltaF}&deg; vs 24h ago`;
    else if (e.k === 'precipitation' && d.intensity != null) sub = d.windCancel > 0.05 ? `${Math.round(d.intensity * 100)}% rain, wind offsets ${Math.round(d.windCancel * 100)}%` : `${Math.round(d.intensity * 100)}% rain`;
    else if (e.k === 'huntingPressure') sub = d.neverHunted ? 'never hunted' : `${d.daysSince}d since sat`;
    else if (e.k === 'foodProximity' && d.distanceYards != null) sub = `${d.distanceYards} yd to food`;
    else if (e.k === 'waterProximity' && d.distanceYards != null) sub = `${d.distanceYards} yd to water`;
    else if (e.k === 'cloudCover' && d.skyCover != null) sub = `${d.skyCover}% cloud`;
    else if (e.k === 'moonIllumination') sub = `${d.illumination ?? '--'}% &middot; not scored`;
    else if (e.k === 'pressureTrend') sub = d.available ? `${d.deltaHpa > 0 ? '+' : ''}${d.deltaHpa} hPa, ${d.direction}` : 'no data';
    return `<div class="fac ${zero ? 'zero' : ''}">
      <div class="name">${esc(FACTOR_LABELS[e.k] ?? e.k)}<br><span class="dim" style="font-size:10px">${sub}</span></div>
      <div class="track"><div class="mid"></div>
        <div class="fill ${e.contribution >= 0 ? 'pos' : 'neg'}" style="width:${pct}%"></div></div>
      <div class="val">${e.contribution > 0 ? '+' : ''}${e.contribution.toFixed(2)}</div>
    </div>`;
  }).join('');
}

function standBlock(s) {
  const conflicts = (s.conflicts || []).slice(0, 3).map((c) =>
    `${esc(c.label)} ${c.distanceYards}yd ${c.bearingCompass} (${c.scentOffsetDeg}&deg; off, ${c.band})`).join(' · ');
  return `<div class="stand ${s.verdict}">
    <div class="hd">
      <span class="nm">${esc(s.label)}</span>
      <span class="badge ${s.verdict}">${s.verdict}</span>
      ${s.scentSource === 'manual' ? '<span class="badge manual">your tags</span>' : ''}
      <span class="${scoreClass(s.buckScore)}">${fmtScore(s.buckScore)}</span>
      <span class="${scoreClass(s.generalScore)}">${fmtScore(s.generalScore)}</span>
      <span class="right muted mono" style="font-size:11px">
        ${s.daysSinceHunted == null ? 'unhunted' : `${s.daysSinceHunted}d rest`}${s.foodYards != null ? ` · food ${s.foodYards}yd` : ''}${s.waterYards != null ? ` · water ${s.waterYards}yd` : ''}
      </span>
    </div>
    ${conflicts ? `<div class="note">Scent reaches: ${conflicts}</div>` : ''}
    ${s.scentNote ? `<div class="note">${esc(s.scentNote)}</div>` : ''}
    ${(s.thermalNotes || []).map((t) => `<div class="note thermal">${esc(t)}</div>`).join('')}
  </div>`;
}

async function renderNear(days = 7) {
  const data = await api(`/api/forecast?days=${days}`);
  $('#nearNote').innerHTML = `NWS forecast is solid to about ${data.forecastConfidenceDays} days. Past that, days fall back to climate normals and are marked <span class="conf climatology">clim</span>.`;

  const byDate = new Map();
  for (const s of data.slots) {
    if (!byDate.has(s.date)) byDate.set(s.date, []);
    byDate.get(s.date).push(s);
  }

  if (!byDate.size) {
    $('#nearBody').innerHTML = '<div class="banner empty">Nothing in range. Before the season opens this shows the first days of gun season once a refresh has run.</div>';
    return;
  }

  $('#nearBody').innerHTML = [...byDate.entries()].map(([date, slots]) => {
    const a = slots[0];
    return `<div class="card">
      <h3>${a.weekday} ${date}
        <span class="conf help ${a.confidence}" style="margin-left:7px" title="${esc(`${CONFIDENCE_HELP[a.confidence]?.short ?? a.confidence} — ${CONFIDENCE_HELP[a.confidence]?.text ?? ''}`)}">${a.confidence}</span>
        <span class="muted" style="font-weight:400;font-size:12px;margin-left:7px">
          ${esc(a.rutPhase)} &middot; day ${a.rutOffset >= 0 ? '+' : ''}${a.rutOffset}
        </span>
        <span class="right muted mono" style="font-size:11px;font-weight:400">
          light ${a.astro.legalStart}&ndash;${a.astro.legalEnd} &middot; moon ${Math.round(a.astro.moon.illumination)}% ${esc(a.astro.moon.phaseName)}
        </span>
      </h3>
      <div class="two">
        ${slots.map((s) => `
          <div>
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:7px">
              <b style="font-size:15px">${s.slot}</b>
              <span class="${scoreClass(s.buckScore)} help" style="font-size:15px;padding:3px 9px" title="${BUCK_HELP}">${fmtScore(s.buckScore)}</span>
              <span class="muted" style="font-size:11px">buck</span>
              <span class="${scoreClass(s.generalScore)} help" style="font-size:15px;padding:3px 9px" title="${DEER_HELP}">${fmtScore(s.generalScore)}</span>
              <span class="muted" style="font-size:11px">deer</span>
              ${s.available ? '<span class="badge manual right">free</span>' : ''}
            </div>
            <div class="muted mono" style="font-size:11.5px;margin-bottom:8px">
              ${conditionsText(s.weather, s.date, s.slot)}
              ${s.weather?.windowStart ? `<span class="dim"> &middot; sit ${s.weather.windowStart.slice(11, 16)}&ndash;${s.weather.windowEnd.slice(11, 16)}Z</span>` : ''}
            </div>
            ${factorRows(s.factors?.buck)}
            <h4>Stands on this wind</h4>
            ${s.stands?.length ? s.stands.map(standBlock).join('')
              : '<div class="note">No stands marked yet. Add them on the Map tab and this becomes the useful part of the page.</div>'}
          </div>`).join('')}
      </div>
    </div>`;
  }).join('');
}

// --- sticky layout ----------------------------------------------------------
//
// The header wraps to two or three rows depending on window width and how many status
// chips are showing, and the tab bar and the calendar's column headers both stick below
// it. Hardcoded offsets meant the calendar header ended up behind the header bar and
// floating over the first few rows. Measure the real heights instead.

function syncStickyOffsets() {
  const header = document.querySelector('header');
  const nav = document.querySelector('nav.tabs');
  if (!header || !nav) return;
  const h = Math.round(header.getBoundingClientRect().height);
  const n = Math.round(nav.getBoundingClientRect().height);
  const root = document.documentElement.style;
  root.setProperty('--header-h', `${h}px`);
  root.setProperty('--nav-h', `${n}px`);
  root.setProperty('--sticky-top', `${h + n}px`);
}

// ResizeObserver catches the chip row wrapping, which a resize event alone does not: the
// window stays the same width while the header grows a line.
if (window.ResizeObserver) {
  const ro = new ResizeObserver(syncStickyOffsets);
  ro.observe(document.querySelector('header'));
  ro.observe(document.querySelector('nav.tabs'));
}
window.addEventListener('resize', syncStickyOffsets);

// --- tabs and boot ----------------------------------------------------------

let mapModule = null;

async function showTab(name) {
  $$('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  $$('main > section').forEach((s) => s.classList.toggle('hide', s.id !== `tab-${name}`));
  location.hash = name;

  if (name === 'near') await renderNear(+($('#nearRange .active')?.dataset.d ?? 7));
  if (name === 'stands') { const m = await import('/stands.js'); await m.mount(); }
  if (name === 'map') { mapModule ??= await import('/map.js'); await mapModule.mount(); }
  if (name === 'log') { const m = await import('/log.js'); await m.mount(); }
  if (name === 'model') { const m = await import('/model.js'); await m.mount(); }
}

async function boot() {
  state = await api('/api/state');
  $('#propTag').textContent = `${state.property.name} · ${state.property.county} · ${state.season.label}`;
  renderChips();
  calendar = await api('/api/calendar');
  renderHighlights();
  renderCalendar();
  syncAvailButtons();
  renderChips();
}

// --- event wiring -----------------------------------------------------------

$$('#tabs button').forEach((b) => { b.onclick = () => showTab(b.dataset.tab); });

$$('#calFilter button').forEach((b) => {
  b.onclick = () => {
    $$('#calFilter button').forEach((x) => x.classList.remove('active'));
    b.classList.add('active');
    calFilter = b.dataset.f;
    renderCalendar();
  };
});

$$('#nearRange button').forEach((b) => {
  b.onclick = async () => {
    $$('#nearRange button').forEach((x) => x.classList.remove('active'));
    b.classList.add('active');
    await renderNear(+b.dataset.d);
  };
});

$('#markWeekends').onclick = async (e) => {
  const clear = e.target.dataset.clear === '1';
  const r = await api('/api/availability/weekends', { method: 'POST', body: JSON.stringify({ clear }) });
  calendar = await api('/api/calendar');
  renderCalendar();
  e.target.textContent = clear ? `Cleared ${r.cleared} weekend days` : `Marked ${r.marked} weekend days`;
  setTimeout(syncAvailButtons, 2000);
};

$('#clearAvail').onclick = async (e) => {
  if (!confirm('Clear every day you have marked available this season?')) return;
  const r = await api('/api/availability', { method: 'DELETE' });
  calendar = await api('/api/calendar');
  renderCalendar();
  e.target.textContent = `Cleared ${r.cleared}`;
  setTimeout(syncAvailButtons, 2000);
};

// Published before the first showTab() so the lazily-imported tab modules can read it.
window.__dh = { get state() { return state; }, get calendar() { return calendar; }, api, boot, renderCalendar };

await boot();
await showTab(location.hash.slice(1) || 'calendar');
