// Sit log. Kept to four fields on purpose: Ben said he wanted logging to be quick, and a
// form nobody fills in produces no data to learn from. The conditions snapshot is
// attached server-side from the tool's own weather history.

import { api, $, $$, esc, scoreClass, fmtScore } from '/util.js';

let slot = 'AM';

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
  $('#sitList').innerHTML = `<table class="data">
    <thead><tr><th>Date</th><th>Slot</th><th>Stand</th><th>Saw</th><th>Predicted</th><th>Conditions</th><th></th></tr></thead>
    <tbody>${sits.map((s) => `
      <tr>
        <td class="mono">${s.date.slice(5)}</td>
        <td>${s.slot}</td>
        <td>${esc(s.stand_label ?? '--')}</td>
        <td>${s.saw_deer ? `<span style="color:var(--green)">${s.deer_count}${s.buck_count ? ` (${s.buck_count}B)` : ''}</span>` : '<span class="dim">none</span>'}</td>
        <td>${s.buck_score != null ? `<span class="${scoreClass(s.buck_score)}">${fmtScore(s.buck_score)}</span> <span class="${scoreClass(s.general_score)}">${fmtScore(s.general_score)}</span>` : '<span class="dim">--</span>'}</td>
        <td>${factorSummary(s.raw)}</td>
        <td><button class="btn sm danger" data-del="${s.id}">x</button></td>
      </tr>${s.notes ? `<tr><td colspan="7" class="muted" style="font-size:12px;padding-top:0">${esc(s.notes)}</td></tr>` : ''}`).join('')}
    </tbody></table>`;

  $$('#sitList [data-del]').forEach((b) => {
    b.onclick = async () => {
      if (!confirm('Delete this sit?')) return;
      await api(`/api/sits/${b.dataset.del}`, { method: 'DELETE' });
      await renderList();
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
