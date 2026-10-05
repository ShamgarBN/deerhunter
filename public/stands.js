// Per-stand breakdown: which stand, on which day, at which time.
//
// Both scores live in one view rather than behind a toggle. Buck and general activity
// routinely disagree about which stand to sit, and making you flip between two views to
// notice that hides exactly the tradeoff the two-score design exists to expose. Every
// cell carries both numbers, and each row names a pick for each.
//
// The honest framing matters here, so the tab states it rather than implying a daily
// decision exists where none does: rut phase and weather are shared by every stand and
// move them together. What separates stands is scent safety on that day's wind, days
// since you last sat it, and distance to food and water. Only the first two change day
// to day, and wind only exists inside the forecast window.

import { api, $, $$, esc, scoreClass, fmtScore, compass, collapsible, wireCollapsibles } from '/util.js';

let onlyAvailable = false;
let data = null;

const MARK = { safe: '●', caution: '◐', unsafe: '○', unknown: '·', unreliable: '?' };

const VERDICT_HELP = {
  safe: 'Scent clears every nearby bedding and food point by more than the safety angle.',
  caution: 'Scent grazes a bedding area, or blows directly at a food source. Huntable, with risk.',
  unsafe: 'Scent blows straight into bedding. This stand is blown out on this wind.',
  unknown: 'No wind forecast for this slot, so scent safety cannot be computed. Expected past the forecast horizon.',
  unreliable: 'Wind too light or variable to call scent from a forecast bearing. Below about 3 mph thermals decide where your scent goes.',
};

function cellHtml(cell) {
  if (cell.buck == null && cell.general == null) return '<td class="dim">--</td>';
  const dim = cell.verdict === 'unsafe';
  const title = [
    `Buck ${fmtScore(cell.buck)} · Deer ${fmtScore(cell.general)}`,
    `Scent: ${cell.verdict} — ${VERDICT_HELP[cell.verdict] ?? ''}`,
    cell.conflicts.length ? `Scent reaches: ${cell.conflicts.join(', ')}` : null,
    cell.daysSinceHunted != null ? `${cell.daysSinceHunted} days since you last sat it` : 'Never hunted this season',
  ].filter(Boolean).join('\n');
  return `<td class="mcell ${cell.verdict}" title="${esc(title)}">
    <span class="${dim ? 'sc s0' : scoreClass(cell.buck)}">${fmtScore(cell.buck)}</span><span
     class="${dim ? 'sc s0' : scoreClass(cell.general)}">${fmtScore(cell.general)}</span><span
     class="vm ${cell.verdict}">${MARK[cell.verdict]}</span>
  </td>`;
}

const standName = (id) => data.stands.find((s) => s.id === id)?.label ?? '';

function pickHtml(row) {
  const b = row.pickBuck;
  const g = row.pickGeneral;
  if (!b && !g) return '<span class="dim">--</span>';
  const same = b && g && b.standId === g.standId;
  if (same) {
    return `<span class="pick"><b>${esc(standName(b.standId))}</b> <span class="dim">both</span></span>`;
  }
  return `<span class="pick"><i class="pb">B</i> ${esc(standName(b?.standId))}</span>
          <span class="pick"><i class="pg">D</i> ${esc(standName(g?.standId))}</span>`;
}

function renderMatrix() {
  let rows = data.matrix;
  if (onlyAvailable) rows = rows.filter((r) => r.available);
  if (!rows.length) {
    $('#standMatrix').innerHTML = '<div class="banner empty">No slots match. Mark days available on the Season tab, or switch the filter off.</div>';
    return;
  }

  const stands = data.stands;
  let lastPhase = null;
  const body = rows.map((r) => {
    let phaseRow = '';
    if (r.rutPhase !== lastPhase) {
      phaseRow = `<tr class="phaserow"><td colspan="${stands.length + 4}">${esc(r.rutPhase)}</td></tr>`;
      lastPhase = r.rutPhase;
    }
    return `${phaseRow}<tr class="${r.available ? 'avail' : ''}">
      <td class="mono" style="font-size:11.5px">${r.date.slice(5)}</td>
      <td class="wd ${r.weekday === 'Sat' || r.weekday === 'Sun' ? 'wk' : ''}">${r.weekday}</td>
      <td class="mono" style="font-size:11.5px">${r.slot}</td>
      ${r.cells.map(cellHtml).join('')}
      <td class="pickcell">
        <span class="mono dim" style="font-size:10.5px">${r.wind ? `${Math.round(r.wind.mph ?? 0)} ${compass(r.wind.deg) ?? ''}` : 'no wind'}</span>
        ${pickHtml(r)}
      </td>
    </tr>`;
  }).join('');

  $('#standMatrix').innerHTML = `<div class="card flush">
    <table class="caltable matrix">
      <thead><tr>
        <th style="width:52px">Date</th><th style="width:34px"></th><th style="width:30px"></th>
        ${stands.map((s) => `<th title="${esc(s.label)}">${esc(s.label)}<br><span class="dim" style="font-weight:400">buck deer</span></th>`).join('')}
        <th style="width:172px">Wind &middot; pick</th>
      </tr></thead>
      <tbody>${body}</tbody>
    </table>
  </div>`;
}

function slotRow(s) {
  return `<div class="kv">
    <span>${s.date.slice(5)} ${s.slot}
      <span class="vm ${s.verdict}" title="scent ${s.verdict}">${MARK[s.verdict]}</span>
      ${s.available ? '<span class="badge manual" style="margin-left:4px">free</span>' : ''}
    </span>
    <span><span class="${scoreClass(s.buck)}">${fmtScore(s.buck)}</span><span class="${scoreClass(s.general)}">${fmtScore(s.general)}</span></span>
  </div>`;
}

function renderSummary() {
  $('#standSummary').innerHTML = data.summary.map((st) => {
    const total = st.counts.safe + st.counts.caution + st.counts.unsafe + st.counts.unknown;
    const pct = (n) => (total ? Math.round((n / total) * 100) : 0);
    const cover = st.cover;
    return `<div class="card">
      <h3>${esc(st.label)}
        <span class="muted" style="font-weight:400;font-size:12px;margin-left:7px">
          ${st.terrain ? esc(st.terrain) : '<span style="color:var(--amber)">no terrain tag</span>'}
          ${st.safeWinds.length ? ` · ${st.safeWinds.length} winds` : ' · <span style="color:var(--amber)">no winds tagged</span>'}
        </span>
        <span class="right">
          <span class="${scoreClass(st.buck.peak)}" title="best buck score">${fmtScore(st.buck.peak)}</span><span
           class="${scoreClass(st.general.peak)}" title="best deer-activity score">${fmtScore(st.general.peak)}</span>
        </span>
      </h3>
      ${cover ? `<div class="kv"><span>Cover</span><span>${esc(cover.label)}${cover.edge ? ` · <span style="color:var(--green)">edge</span>` : ''}${cover.source === 'manual' ? ' <span class="dim">(yours)</span>' : ''}</span></div>` : ''}
      <div class="kv"><span>Season average</span><span>${fmtScore(st.buck.avg)} buck · ${fmtScore(st.general.avg)} deer</span></div>
      <div class="kv"><span>Last hunted</span><span>${st.lastHunted ?? 'never'}</span></div>
      <div class="kv"><span>Scent</span><span>${st.counts.safe} safe · ${st.counts.caution} caution · ${st.counts.unsafe} blown (${pct(st.counts.unsafe)}%)</span></div>
      ${st.counts.unknown ? `<div class="kv"><span>Wind unknown</span><span>${st.counts.unknown} slots past the forecast</span></div>` : ''}

      <h4>Best for a buck</h4>
      ${st.buck.best.length ? st.buck.best.map(slotRow).join('') : '<div class="note">Nothing scoreable yet.</div>'}
      <h4>Best for seeing deer</h4>
      ${st.general.best.length ? st.general.best.map(slotRow).join('') : '<div class="note">Nothing scoreable yet.</div>'}
      ${st.buck.bestAvailable.length ? `<h4>Best on days you're free</h4>${st.buck.bestAvailable.map(slotRow).join('')}` : ''}
    </div>`;
  }).join('');
}

export async function mount() {
  data = await api('/api/stands');

  if (!data.stands.length) {
    $('#standsBody').innerHTML = '<div class="banner empty">No stands marked yet. Add them on the Map tab and this fills in.</div>';
    return;
  }

  const untagged = data.summary.filter((s) => !s.safeWinds.length).length;
  const noBedding = !data.marked?.bedding;

  // Without bedding the scent check has only food and water to test against, and a food
  // conflict is a caution rather than a blown stand. Nothing ever gets ruled out, so the
  // same stand wins every slot. That is the difference between this tab being a ranking
  // and being a recommendation.
  const beddingWarn = noBedding ? collapsible('stands-bedding',
    '<b style="color:var(--amber)">No bedding marked</b><span class="sum-note">the daily pick can\'t move until you add some</span>',
    `Scent safety is what makes one stand beat another on a given day, and bedding is what makes a verdict come
     back <b>blown</b> rather than merely <b>caution</b>. With none marked, the check has only food and water to
     measure against, nothing is ever ruled out, and the same stand wins every slot &mdash; which is exactly what
     you see below.<br><br>
     Mark bedding on the Map tab, even as rough guesses, and draw it as areas or lines rather than pins: a thicket
     subtends a wide angle from a nearby stand, and treating it as a point understates how exposed you are.`,
    { open: true, cls: 'warn' }) : '';

  const explainer = collapsible('stands-explainer',
    `<b>What separates one stand from another</b><span class="sum-note">scent safety, rest days, food and water distance &mdash; not rut or weather</span>`,
    `Rut phase and weather are shared by the whole property, so they move every stand together and never change
     which one is best. Three things do: <b>scent safety on that day's wind</b>, <b>days since you last sat it</b>,
     and its <b>distance to food and water</b>. Only the first two change day to day, and wind only exists inside
     the ${data.forecastConfidenceDays}-day forecast window. Past that the wind column reads empty and this becomes
     a ranking rather than a daily pick.
     ${untagged ? `<br><br><span style="color:var(--amber)">${untagged} of your ${data.stands.length} stands have no safe winds tagged.</span>
       Until they do, their scent verdicts come from map geometry alone, which is only as good as your bedding markers.` : ''}`,
    { open: false });

  $('#standsBody').innerHTML = `
    ${beddingWarn}
    ${explainer}
    <div class="toolbar">
      <label class="check" style="margin:0"><input type="checkbox" id="onlyAvail" ${onlyAvailable ? 'checked' : ''}> Only days I'm free</label>
      <span class="right muted mono" style="font-size:10.5px">
        each cell: <span class="sc s8">buck</span><span class="sc s5">deer</span> &nbsp;
        scent <span class="vm safe help" title="${esc(VERDICT_HELP.safe)}">●</span>safe
        <span class="vm caution help" title="${esc(VERDICT_HELP.caution)}">◐</span>caution
        <span class="vm unsafe help" title="${esc(VERDICT_HELP.unsafe)}">○</span>blown
        <span class="vm unknown help" title="${esc(VERDICT_HELP.unknown)}">·</span>no wind
      </span>
    </div>
    <div id="standMatrix"></div>
    <h4 style="margin:18px 0 8px">Stand by stand</h4>
    <div class="grid2" id="standSummary"></div>`;

  wireCollapsibles($('#standsBody'));
  renderMatrix();
  renderSummary();
  $('#onlyAvail').onchange = (e) => { onlyAvailable = e.target.checked; renderMatrix(); };
}
