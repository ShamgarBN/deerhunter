// Sit log. Kept to four fields on purpose: Ben said he wanted logging to be quick, and a
// form nobody fills in produces no data to learn from. The conditions snapshot is
// attached server-side from the tool's own weather history.
//
// Sighting detail is deliberately NOT part of that form. It hangs off a logged sit and is
// added afterwards, because the four-field path has to stay something you can finish with
// cold hands before climbing down. Everything in it is optional, and a sit with none is
// exactly as valid as it was before the feature existed.

import { api, $, $$, esc, scoreClass, fmtScore, DIRS } from '/util.js';

let slot = 'AM';
let open = new Set();   // sit ids with the detail form showing

const degFor = (name) => DIRS.indexOf(name) * 22.5;

/** "+14" reads as minutes after first light; the sign is the whole point, so keep it. */
function anchorOffset(g, sitSlot) {
  if (g.minutes_from_anchor == null) return '';
  const v = g.minutes_from_anchor;
  const ref = sitSlot === 'AM' ? 'sunrise' : 'sunset';
  return `<span class="dim" title="${esc(`${Math.abs(v)} minutes ${v < 0 ? 'before' : 'after'} ${ref}`)}">${v >= 0 ? '+' : ''}${v}m</span>`;
}

function sightingLine(g, sitSlot) {
  const bits = [];
  if (g.at_time) bits.push(`<span class="mono">${esc(g.at_time)}</span> ${anchorOffset(g, sitSlot)}`);
  bits.push(`${g.deer_count} deer${g.buck_count ? ` (${g.buck_count}B)` : ''}`);
  const where = [];
  if (g.bearing_deg != null) where.push(DIRS[Math.round(((g.bearing_deg % 360) + 360) % 360 / 22.5) % 16]);
  if (g.distance_yards != null) where.push(`${g.distance_yards}yd`);
  if (where.length) bits.push(where.join(' '));
  // The watched distance is shown with the arrow because it is the honest caveat on it:
  // 30 yards of cover is a very different observation from 200 yards of open field.
  if (g.travel_deg != null) {
    const watched = (g.seen_before_yards ?? 0) + (g.seen_after_yards ?? 0);
    bits.push(`&rarr; ${DIRS[Math.round(((g.travel_deg % 360) + 360) % 360 / 22.5) % 16]}`
      + (watched ? ` <span class="dim">(${watched}yd seen)</span>` : ''));
  }
  if (g.behavior) bits.push(esc(g.behavior));
  if (g.notes) bits.push(`<span class="muted">${esc(g.notes)}</span>`);
  return `<div class="sighting">
    <span>${bits.join(' <span class="dim">&middot;</span> ')}</span>
    <button class="btn sm danger" data-delsight="${g.id}" title="Delete this sighting">x</button>
  </div>`;
}

function detailForm(sit, behaviors) {
  return `<div class="sightform" data-form="${sit.id}">
    <input type="time" data-f="at_time" title="Clock time you saw it">
    <input type="number" data-f="deer_count" min="1" value="1" style="width:58px" title="How many deer">
    <input type="number" data-f="buck_count" min="0" value="0" style="width:58px" title="How many of them were bucks">
    <select data-f="bearing" title="Direction from the stand to the deer">
      <option value="">dir</option>
      ${DIRS.map((d) => `<option value="${d}">${d}</option>`).join('')}
    </select>
    <input type="number" data-f="distance_yards" min="0" placeholder="yd" style="width:70px" title="Distance in yards">
    <select data-f="travel" title="Which way it was HEADED. Different from the direction you saw it in.">
      <option value="">heading</option>
      ${DIRS.map((d) => `<option value="${d}">&rarr; ${d}</option>`).join('')}
    </select>
    <input type="number" data-f="seen_before_yards" min="0" placeholder="yd before" style="width:86px"
      title="How many yards you could watch it BEFORE the point you logged. Leave blank if it stepped straight out.">
    <input type="number" data-f="seen_after_yards" min="0" placeholder="yd after" style="width:80px"
      title="How many yards you could watch it AFTER, before cover took it. This bounds the arrow: nothing is extrapolated past what you saw.">
    <select data-f="behavior" title="What it was doing">
      <option value="">doing what</option>
      ${(behaviors ?? []).map((b) => `<option value="${esc(b)}">${esc(b)}</option>`).join('')}
    </select>
    <input type="text" data-f="notes" placeholder="note" title="Anything else worth remembering">
    <button class="btn sm" data-addsight="${sit.id}">Add</button>
    <span class="sightmsg muted"></span>
  </div>`;
}

function factorSummary(raw) {
  if (!raw) return '<span class="dim">no snapshot</span>';
  const bits = [];
  if (raw.departureF != null) bits.push(`${raw.departureF > 0 ? '+' : ''}${raw.departureF}&deg;`);
  if (raw.windMph != null) bits.push(`${Math.round(raw.windMph)}mph`);
  if (raw.precipProb != null) bits.push(`${Math.round(raw.precipProb)}% rain`);
  if (raw.moonIllumination != null) bits.push(`moon ${Math.round(raw.moonIllumination)}%`);
  if (raw.rutOffset != null) bits.push(`day ${raw.rutOffset >= 0 ? '+' : ''}${raw.rutOffset}`);
  return `<span class="mono" style="font-size:11px">${bits.join(' · ')}</span>`;
}

async function renderList() {
  const sits = await api('/api/sits');
  if (!sits.length) {
    $('#sitList').innerHTML = `<div class="banner empty">
      No sits logged yet. Each one attaches a conditions snapshot automatically, and once there are
      enough of them the Model tab can start fitting weights to what you actually see on this property.
    </div>`;
    return;
  }
  const behaviors = window.__dh.state.behaviors ?? [];
  $('#sitList').innerHTML = `<table class="data">
    <thead><tr><th>Date</th><th>Slot</th><th>Stand</th><th>Saw</th><th>Predicted</th><th>Conditions</th><th></th></tr></thead>
    <tbody>${sits.map((s) => {
      const detail = s.sightings ?? [];
      const showing = open.has(s.id);
      return `
      <tr>
        <td class="mono">${s.date.slice(5)}</td>
        <td>${s.slot}</td>
        <td>${esc(s.stand_label ?? '--')}</td>
        <td>${s.saw_deer ? `<span style="color:var(--green)">${s.deer_count}${s.buck_count ? ` (${s.buck_count}B)` : ''}</span>` : '<span class="dim">none</span>'}</td>
        <td>${s.buck_score != null ? `<span class="${scoreClass(s.buck_score)}">${fmtScore(s.buck_score)}</span> <span class="${scoreClass(s.general_score)}">${fmtScore(s.general_score)}</span>` : '<span class="dim">--</span>'}</td>
        <td>${factorSummary(s.raw)}</td>
        <td style="white-space:nowrap">
          <button class="btn sm ${detail.length ? 'has' : ''}" data-detail="${s.id}"
            title="Where and when the deer appeared. Optional, and not scored: it is recorded for the annual review.">${detail.length ? `${detail.length} detail` : '+ detail'}</button>
          <button class="btn sm danger" data-del="${s.id}">x</button>
        </td>
      </tr>${s.notes ? `<tr><td colspan="7" class="muted" style="font-size:12px;padding-top:0">${esc(s.notes)}</td></tr>` : ''}${
        detail.length || showing ? `<tr class="detailrow"><td colspan="7">
          ${detail.map((g) => sightingLine(g, s.slot)).join('')}
          ${showing ? detailForm(s, behaviors) : ''}
        </td></tr>` : ''}`;
    }).join('')}
    </tbody></table>`;

  $$('#sitList [data-del]').forEach((b) => {
    b.onclick = async () => {
      if (!confirm('Delete this sit?')) return;
      await api(`/api/sits/${b.dataset.del}`, { method: 'DELETE' });
      await renderList();
    };
  });

  $$('#sitList [data-detail]').forEach((b) => {
    b.onclick = () => {
      const id = +b.dataset.detail;
      if (open.has(id)) open.delete(id); else open.add(id);
      renderList();
    };
  });

  $$('#sitList [data-delsight]').forEach((b) => {
    b.onclick = async () => {
      await api(`/api/sightings/${b.dataset.delsight}`, { method: 'DELETE' });
      await renderList();
    };
  });

  $$('#sitList [data-addsight]').forEach((b) => {
    b.onclick = async () => {
      const form = b.closest('.sightform');
      const get = (f) => form.querySelector(`[data-f="${f}"]`).value.trim();
      const msg = form.querySelector('.sightmsg');
      const dir = get('bearing');
      try {
        const r = await api(`/api/sits/${b.dataset.addsight}/sightings`, {
          method: 'POST',
          body: JSON.stringify({
            at_time: get('at_time') || null,
            deer_count: +get('deer_count') || 1,
            buck_count: +get('buck_count') || 0,
            bearing_deg: dir ? degFor(dir) : null,
            distance_yards: get('distance_yards') === '' ? null : +get('distance_yards'),
            travel_deg: get('travel') ? degFor(get('travel')) : null,
            seen_before_yards: get('seen_before_yards') === '' ? null : +get('seen_before_yards'),
            seen_after_yards: get('seen_after_yards') === '' ? null : +get('seen_after_yards'),
            behavior: get('behavior') || null,
            notes: get('notes') || null,
          }),
        });
        // Both of these are worth saying out loud rather than silently storing something
        // that will read as a contradiction at review time.
        if (r.exceedsSitTotal) {
          msg.innerHTML = '<span style="color:var(--amber)">Saved. Detail now totals more deer than the sit does, so update the sit count.</span>';
        } else if (!r.mappable) {
          msg.innerHTML = '<span style="color:var(--amber)">Saved, but with no direction and distance it cannot go on the map.</span>';
        } else if (r.timeUnplaced) {
          msg.innerHTML = '<span style="color:var(--amber)">Saved, but that time could not be placed against first light.</span>';
        } else {
          msg.innerHTML = '<span style="color:var(--green)">Saved.</span>';
        }
        setTimeout(() => renderList(), 900);
      } catch (err) {
        msg.innerHTML = `<span style="color:var(--red)">${esc(err.message)}</span>`;
      }
    };
  });
}

export async function mount() {
  const map = await api('/api/map');
  const stands = map.points.filter((p) => p.type === 'stand');
  $('#sitStand').innerHTML = `<option value="">-- no stand / still hunt --</option>` +
    stands.map((s) => `<option value="${s.id}">${esc(s.label)}</option>`).join('');

  if (!$('#sitDate').value) $('#sitDate').value = window.__dh.state.today;

  $$('#sitSlot button').forEach((b) => {
    b.onclick = () => { $$('#sitSlot button').forEach((x) => x.classList.remove('active')); b.classList.add('active'); slot = b.dataset.s; };
  });

  $('#sitSaw').onchange = () => {
    // Saying you saw deer but leaving the count at zero is the common slip; nudge it to 1.
    if ($('#sitSaw').checked && +$('#sitCount').value === 0) $('#sitCount').value = 1;
  };

  $('#saveSit').onclick = async () => {
    const body = {
      date: $('#sitDate').value,
      slot,
      stand_id: $('#sitStand').value || null,
      saw_deer: $('#sitSaw').checked,
      deer_count: +$('#sitCount').value || 0,
      buck_count: +$('#sitBucks').value || 0,
      notes: $('#sitNotes').value.trim() || null,
    };
    if (!body.date) { $('#sitMsg').textContent = 'Pick a date.'; return; }
    try {
      const r = await api('/api/sits', { method: 'POST', body: JSON.stringify(body) });
      $('#sitMsg').innerHTML = r.snapshotAttached
        ? '<span style="color:var(--green)">Saved with conditions snapshot.</span>'
        : `<span style="color:var(--amber)">Saved, but ${esc(r.note)}</span>`;
      $('#sitNotes').value = ''; $('#sitSaw').checked = false;
      $('#sitCount').value = 0; $('#sitBucks').value = 0;
      await renderList();
      setTimeout(() => { $('#sitMsg').textContent = ''; }, 6000);
    } catch (err) {
      $('#sitMsg').innerHTML = `<span style="color:var(--red)">${esc(err.message)}</span>`;
    }
  };

  await renderList();
}
