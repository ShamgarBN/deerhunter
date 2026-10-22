// Model tab: the weights, where they came from, what the data has moved, and the controls
// that should be adjusted rather than buried in a config file.
//
// The point of showing all of this is auditability. The reweighting system changes the
// model over time, and a model that changes silently underneath the person relying on it
// is worse than one that never learns at all.

import { api, $, $$, esc } from '/util.js';

const CONF_COLOR = { high: 'var(--green)', medium: 'var(--amber)', low: 'var(--red)' };

function weightBar(cur, prior) {
  const max = Math.max(Math.abs(prior) * 1.35, Math.abs(cur) * 1.15, 0.4);
  const pc = (Math.abs(cur) / max) * 100;
  const pp = (Math.abs(prior) / max) * 100;
  return `<div class="track" style="position:relative;height:13px;background:var(--panel2);border:1px solid #151c26;border-radius:3px">
    <div style="position:absolute;top:2px;bottom:2px;left:0;width:${pc}%;background:${cur >= prior ? 'var(--green-dim)' : 'var(--red-dim)'};border-radius:2px"></div>
    <div style="position:absolute;top:0;bottom:0;left:${pp}%;width:1px;background:var(--accent)" title="research prior: ${prior}"></div>
  </div>`;
}

export async function mount() {
  const w = await api('/api/weights');
  const sn = await api('/api/seasons');
  const dr = await api('/api/drought');
  const st = window.__dh.state;

  const factorRows = Object.entries(w.factors).map(([k, f]) => `
    <tr>
      <td>
        <b>${esc(f.label)}</b>
        ${f.frozen ? '<span class="badge unknown" title="Reported but never written by reweighting">frozen</span>' : ''}
        ${f.droughtScaled ? '<span class="badge caution" title="Scaled by drought severity">drought</span>' : ''}
        ${f.reweightCandidate ? '<span class="badge manual" title="Least research consensus; best candidate to move">contested</span>' : ''}
        <div class="muted" style="font-size:11.5px;margin-top:3px;line-height:1.5">${esc(f.research)}</div>
        ${f.note ? `<div class="dim" style="font-size:11px;margin-top:4px;line-height:1.5">${esc(f.note)}</div>` : ''}
      </td>
      <td style="width:118px">
        <div class="mono" style="font-size:11px">buck ${f.buck.current}${f.buck.current !== f.buck.prior ? ` <span class="dim">(was ${f.buck.prior})</span>` : ''}</div>
        ${weightBar(f.buck.current, f.buck.prior)}
        <div class="mono" style="font-size:11px;margin-top:5px">deer ${f.general.current}${f.general.current !== f.general.prior ? ` <span class="dim">(was ${f.general.prior})</span>` : ''}</div>
        ${weightBar(f.general.current, f.general.prior)}
        ${f.droughtScaled ? `<div class="dim mono" style="font-size:10px;margin-top:4px">effective ${f.effectiveBuck} / ${f.effectiveGeneral}</div>` : ''}
      </td>
      <td style="width:62px;color:${CONF_COLOR[f.confidence] ?? 'var(--muted)'};font-size:11px;text-transform:uppercase">${esc(f.confidence)}</td>
    </tr>`).join('');

  const history = w.history.length ? `<table class="data">
      <thead><tr><th>When</th><th>Factor</th><th>Target</th><th>Change</th><th>n</th><th>Why</th></tr></thead>
      <tbody>${w.history.map((h) => `<tr>
        <td class="mono">${h.created_at.slice(0, 10)}</td>
        <td>${esc(h.factor)}</td><td>${h.target}</td>
        <td class="mono">${h.old_weight} &rarr; ${h.new_weight} ${h.clipped ? '<span class="badge caution">clipped</span>' : ''}</td>
        <td class="mono">${h.sample_n ?? '--'}</td>
        <td class="muted" style="font-size:11.5px">${esc(h.reason ?? '')}</td>
      </tr>`).join('')}</tbody></table>`
    : '<div class="banner empty">No adjustments yet. Weights are still exactly at their research priors.</div>';

  const weaponOpts = (sel) => Object.entries(sn.weapons)
    .map(([k, v]) => `<option value="${k}" ${k === sel ? 'selected' : ''}>${esc(v.label)}</option>`).join('');

  const seasonRow = (s2, i) => `<div class="seasonrow" data-i="${i}">
    <input type="checkbox" class="s-en" ${s2.enabled ? 'checked' : ''} title="Enabled. Disabled seasons are not scored.">
    <input type="text" class="s-label" value="${esc(s2.label)}" placeholder="Season name">
    <select class="s-weapon">${weaponOpts(s2.weapon)}</select>
    <input type="date" class="s-start" value="${s2.start}">
    <input type="date" class="s-end" value="${s2.end}">
    <input type="color" class="s-color" value="${s2.color}" title="Colour on the calendar">
    <button class="del" title="Remove">&times;</button>
  </div>`;

  $('#modelBody').innerHTML = `
    <div class="banner">
      <h4>How this model is grounded</h4>
      ${esc(w.methodology)}
    </div>

    <div class="card">
      <h3>Seasons</h3>
      <p class="muted" style="font-size:12.5px;margin-top:0">
        Define as many as you hunt. The tool scores the union of every enabled season and skips the gaps
        between them. Dates are set by state and usually by county, so check your own regs rather than
        trusting a default.
      </p>
      <p class="muted" style="font-size:12.5px">
        <b>Weapon is not cosmetic.</b> It scales the scent-safety threshold, because an archer needs the
        deer inside about 35 yards while a rifle hunter does not, so the deer spends far longer in your
        scent cone before you can act. Archery tightens the ${'' /* threshold */}safe-angle threshold by 25%,
        muzzleloader and slug by 10%, rifle is the baseline. Where seasons overlap the strictest open
        weapon governs, which is why the same morning can read safe for gun and blown for bow.
      </p>
      <div class="seasonhead" style="margin-top:12px">
        <span></span><span>Name</span><span>Weapon</span><span>Opens</span><span>Closes</span><span>Colour</span><span></span>
      </div>
      <div id="seasonList">${sn.seasons.map(seasonRow).join('')}</div>
      <div style="margin-top:10px;display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <button class="btn" id="addSeason">Add season</button>
        <button class="btn primary" id="saveSeasons">Save &amp; rescore</button>
        <span class="muted" style="font-size:12px" id="seasonMsg"></span>
      </div>
      <div id="weaponNotes" class="note" style="margin-top:9px"></div>
    </div>

    <div class="grid2">
      <div class="card">
        <h3>Peak breeding date</h3>
        <p class="muted" style="font-size:12.5px;margin-top:0">
          The single value the whole rut curve hangs on. Change it and every day in the season re-shapes.
        </p>
        <div class="row">
          <div><input type="date" id="peakDate" value="${w.peakRutDate}"></div>
          <div style="flex:0 0 auto"><button class="btn primary" id="savePeak">Save &amp; rescore</button></div>
        </div>
        <div class="note" id="peakMsg">Currently ${w.peakRutDate}. Regional estimates for Central NC span about Nov 15&ndash;20 and shift year to year.</div>
      </div>

      <div class="card">
        <h3>Drought severity
          <span class="badge ${dr.drought.mode === 'auto' ? 'safe' : 'manual'}" style="margin-left:7px">${dr.drought.mode === 'auto' ? 'auto' : 'manual'}</span>
        </h3>
        <p class="muted" style="font-size:12.5px;margin-top:0">
          Scales the food and water proximity weights. In <b>auto</b> it updates from the US Drought Monitor on
          every refresh, area-weighted across your county rather than taking the worst category present.
        </p>
        <div class="kv"><span>Severity</span><span><b>${dr.drought.severity ?? 0}</b> &times;${(1 + w.droughtBoost * (dr.drought.severity ?? 0)).toFixed(2)} on food &amp; water</span></div>
        <div class="kv"><span>Category</span><span>${esc(dr.drought.dominant ? dr.drought.dominant.toUpperCase() : '--')}${dr.drought.trend ? ` &middot; ${esc(dr.drought.trend)}` : ''}</span></div>
        <div class="kv"><span>USDM map</span><span>${esc(dr.drought.asOf ?? 'never checked')}</span></div>
        <div class="kv"><span>County</span><span>${dr.countyFips ? `FIPS ${esc(dr.countyFips)}` : '<span style="color:var(--amber)">not resolved — run setup</span>'}</span></div>
        <div class="note">${esc(dr.drought.note ?? '')}</div>

        <h4>Override</h4>
        <input type="range" id="droughtRange" min="0" max="1" step="0.05" value="${dr.drought.severity ?? 0}" style="width:100%">
        <div class="kv"><span>Manual value</span><span id="droughtVal">${dr.drought.severity ?? 0}</span></div>
        <div style="display:flex;gap:8px;margin-top:9px;flex-wrap:wrap">
          <button class="btn" id="saveDrought">Pin this value</button>
          <button class="btn ${dr.drought.mode === 'auto' ? '' : 'primary'}" id="autoDrought" ${dr.drought.mode === 'auto' ? 'disabled' : ''}>Back to auto</button>
          <button class="btn sm right" id="checkDrought">Check USDM now</button>
        </div>
        <div class="note" id="droughtMsg">Pinning switches to manual. USDM keeps getting checked and logged each refresh, it just stops overwriting you &mdash; the right call if you know your own water better than a county map does.</div>
        ${dr.history?.length ? `<h4>Recent checks</h4>${dr.history.slice(0, 6).map((h) => `<div class="kv"><span>${esc(h.map_date ?? h.created_at.slice(0, 10))} ${esc((h.dominant ?? '').toUpperCase())}</span><span class="mono">${h.old_severity} &rarr; ${h.new_severity}</span></div>`).join('')}` : ''}
      </div>

    <div class="card">
      <h3>Scale calibration</h3>
      <p class="muted" style="font-size:12.5px;margin-top:0">
        Maps the raw weighted sum onto the visible 0&ndash;10 scale by simulating the whole season
        against a spread of plausible weather and pressure. It changes what the numbers look like,
        never how days rank against each other. Re-run it after the map changes materially.
      </p>
      <div class="two">
        <div>
          <div class="kv"><span>Buck</span><span>offset ${w.calibration?.buck?.offset ?? 0}, gain ${w.calibration?.buck?.gain ?? 1}</span></div>
          <div class="kv"><span>Deer activity</span><span>offset ${w.calibration?.general?.offset ?? 0}, gain ${w.calibration?.general?.gain ?? 1}</span></div>
          <div class="kv"><span>Status</span><span>${st.calibrated ? 'calibrated' : 'identity (not yet run)'}</span></div>
        </div>
        <div>
          <button class="btn primary" id="doCalibrate">Run calibration</button>
          <div class="note" id="calMsg">${st.calibrated ? '' : 'Mark at least two stands on the Map tab first; calibration needs the property geometry to mean anything.'}</div>
        </div>
      </div>
    </div>

    <div class="card">
      <h3>Factor weights</h3>
      <p class="muted" style="font-size:12.5px;margin-top:0">
        The blue tick on each bar is the research prior, which never changes. The filled bar is the
        current weight, which drifts as the sit log accumulates. Weights are in score points at full effect.
      </p>
      <table class="data"><tbody>${factorRows}</tbody></table>
    </div>

    <div class="card">
      <h3>Reweighting</h3>
      <p class="muted" style="font-size:12.5px;margin-top:0">
        Buckets your logged sits by each factor's value, compares actual sighting rates between the
        buckets, and shrinks the fitted change by sample size: <span class="mono">n / (n + ${w.reweighting.shrinkageK})</span>.
        Ten sits gets about a third weight on the data, sixty about three-quarters. No factor moves more
        than ${Math.round(w.reweighting.maxDriftFraction * 100)}% from its prior in one season.
      </p>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn" id="dryRun">Preview fit</button>
        <button class="btn primary" id="applyFit">Apply</button>
        <button class="btn danger right" id="resetFit">Reset to priors</button>
      </div>
      <div id="fitOut"></div>
    </div>

    <div class="card">
      <h3>Change history</h3>
      ${history}
    </div>`;

  // --- seasons ---
  const readSeasons = () => $$('#seasonList .seasonrow').map((row) => ({
    label: row.querySelector('.s-label').value.trim() || 'Season',
    weapon: row.querySelector('.s-weapon').value,
    start: row.querySelector('.s-start').value,
    end: row.querySelector('.s-end').value,
    color: row.querySelector('.s-color').value,
    enabled: row.querySelector('.s-en').checked,
  }));

  const showWeaponNotes = () => {
    const used = [...new Set(readSeasons().filter((x) => x.enabled).map((x) => x.weapon))];
    $('#weaponNotes').innerHTML = used.map((k) => {
      const v = sn.weapons[k];
      return v ? `<div style="margin:4px 0"><b>${esc(v.label)}</b> &middot; effective range ~${v.effectiveRangeYards} yd &middot; scent threshold &times;${v.scentStrictness}<br><span class="dim">${esc(v.note)}</span></div>` : '';
    }).join('');
  };

  const wireRows = () => {
    $$('#seasonList .del').forEach((b) => {
      b.onclick = () => { b.closest('.seasonrow').remove(); showWeaponNotes(); };
    });
    $$('#seasonList .s-weapon, #seasonList .s-en').forEach((el) => { el.onchange = showWeaponNotes; });
  };
  wireRows();
  showWeaponNotes();

  $('#addSeason').onclick = () => {
    const i = $$('#seasonList .seasonrow').length;
    const yr = new Date().getFullYear();
    const blank = { label: '', weapon: 'rifle', start: `${yr}-10-01`, end: `${yr}-12-31`, color: '#8b9bb0', enabled: true };
    $('#seasonList').insertAdjacentHTML('beforeend', seasonRow(blank, i));
    wireRows();
  };

  $('#saveSeasons').onclick = async (e) => {
    const seasons = readSeasons();
    const bad = seasons.find((x) => !x.start || !x.end || x.start > x.end);
    if (bad) { $('#seasonMsg').innerHTML = `<span style="color:var(--amber)">"${esc(bad.label)}" needs a start and end, with start no later than end.</span>`; return; }
    e.target.disabled = true;
    $('#seasonMsg').textContent = 'Saving and rescoring...';
    try {
      await api('/api/seasons', { method: 'POST', body: JSON.stringify({ seasons }) });
      await api('/api/refresh', { method: 'POST', body: '{}' });
      await window.__dh.boot();
      await mount();
    } catch (err) {
      $('#seasonMsg').innerHTML = `<span style="color:var(--red)">${esc(err.message)}</span>`;
    } finally { e.target.disabled = false; }
  };

  // --- handlers ---
  $('#savePeak').onclick = async () => {
    const date = $('#peakDate').value;
    await api('/api/weights/peak-rut', { method: 'POST', body: JSON.stringify({ date }) });
    $('#peakMsg').textContent = 'Saved. Rescoring the season...';
    await api('/api/refresh', { method: 'POST', body: '{}' });
    await window.__dh.boot();
    $('#peakMsg').textContent = `Peak breeding now ${date}, season rescored.`;
  };

  $('#droughtRange').oninput = (e) => {
    $('#droughtVal').textContent = e.target.value;
  };
  $('#saveDrought').onclick = async () => {
    await api('/api/drought', { method: 'POST', body: JSON.stringify({ severity: +$('#droughtRange').value, mode: 'manual' }) });
    await api('/api/refresh', { method: 'POST', body: '{}' });
    await mount();
  };
  $('#autoDrought').onclick = async () => {
    await api('/api/drought', { method: 'POST', body: JSON.stringify({ mode: 'auto' }) });
    await api('/api/drought/check', { method: 'POST', body: '{}' });
    await api('/api/refresh', { method: 'POST', body: '{}' });
    await mount();
  };
  $('#checkDrought').onclick = async (e) => {
    e.target.disabled = true;
    $('#droughtMsg').textContent = 'Checking the US Drought Monitor...';
    try {
      const r = await api('/api/drought/check', { method: 'POST', body: '{}' });
      $('#droughtMsg').innerHTML = esc((r.log ?? []).join(' '));
      if (r.changed) { await api('/api/refresh', { method: 'POST', body: '{}' }); await mount(); }
    } catch (err) { $('#droughtMsg').textContent = err.message; }
    finally { e.target.disabled = false; }
  };

  $('#doCalibrate').onclick = async (e) => {
    e.target.disabled = true; $('#calMsg').textContent = 'Simulating the season...';
    try {
      const r = await api('/api/calibrate', { method: 'POST', body: '{}' });
      const d = r.distribution;
      const warn = [r.diagnostics?.buck?.warning, r.diagnostics?.general?.warning].filter(Boolean);
      $('#calMsg').innerHTML = `Calibrated. Expected spread &mdash;
        buck median ${d.buck.p50}, 5th&ndash;95th ${d.buck.p05}&ndash;${d.buck.p95};
        deer median ${d.general.p50}, ${d.general.p05}&ndash;${d.general.p95}.
        ${warn.map((x) => `<div class="note thermal">${esc(x)}</div>`).join('')}`;
      await api('/api/refresh', { method: 'POST', body: '{}' });
      await window.__dh.boot();
    } catch (err) { $('#calMsg').textContent = `Failed: ${err.message}`; }
    finally { e.target.disabled = false; }
  };

  const runFit = async (apply) => {
    const r = await api('/api/weights/reweight', { method: 'POST', body: JSON.stringify({ apply }) });
    if (!r.totalSits) {
      $('#fitOut').innerHTML = '<div class="banner empty">No logged sits with a conditions snapshot yet, so there is nothing to fit against.</div>';
      return;
    }
    $('#fitOut').innerHTML = `<div class="note" style="margin-top:11px">
        ${r.totalSits} sits considered. ${apply ? `${r.applied} weight(s) written.` : 'Preview only, nothing written.'}
      </div>
      <table class="data" style="margin-top:7px">
        <thead><tr><th>Factor</th><th>Target</th><th>n</th><th>Sighting rate hi/lo</th><th>Prior &rarr; new</th><th></th></tr></thead>
        <tbody>${r.results.map((x) => {
          if (x.skipped) return `<tr><td>${esc(x.factor)}</td><td>${x.target}</td><td>${x.n ?? 0}</td><td colspan="3" class="muted" style="font-size:11.5px">skipped: ${esc(x.reason)}</td></tr>`;
          if (x.frozen) return `<tr><td>${esc(x.factor)}</td><td>${x.target}</td><td>${x.n}</td><td class="mono">${(x.rateHigh * 100).toFixed(0)}% / ${(x.rateLow * 100).toFixed(0)}%</td><td class="muted">frozen</td><td class="dim" style="font-size:11px">would have been ${x.wouldHaveBeen}</td></tr>`;
          return `<tr><td>${esc(x.factor)}</td><td>${x.target}</td><td>${x.n}</td>
            <td class="mono">${(x.rateHigh * 100).toFixed(0)}% / ${(x.rateLow * 100).toFixed(0)}%</td>
            <td class="mono">${x.prior} &rarr; ${x.current}</td>
            <td>${x.clipped ? '<span class="badge caution">clipped</span>' : ''}</td></tr>`;
        }).join('')}</tbody></table>`;
    if (apply) await mount();
  };

  $('#dryRun').onclick = () => runFit(false);
  $('#applyFit').onclick = async () => {
    if (!confirm('Write the fitted weights to the scoring config? Every change is logged and reversible with Reset to priors.')) return;
    await runFit(true);
  };
  $('#resetFit').onclick = async () => {
    if (!confirm('Reset every weight to its research prior?')) return;
    await api('/api/weights/reset', { method: 'POST', body: '{}' });
    await mount();
  };
}
