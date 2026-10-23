// Property map: a real Leaflet slippy map over free aerial imagery, not a static
// screenshot with percentage offsets on top.
//
// That choice is what makes the rest of the tool honest. Points carry true WGS84
// coordinates, so stand-to-bedding bearings are real compass bearings and distances are
// real yards. The scent geometry and the drought-weighted food/water scoring both depend
// on that being true rather than approximately true.
//
// Every basemap below is keyless and was reachable on 2026-09-18. USGS Topo is the one
// with contour lines, which is how you tag a stand ridge/midslope/valley without guessing.

import { api, $, $$, esc, DIRS } from '/util.js';

let map = null;
let layerGroup = null;
let sightingGroup = null;   // the Sightings overlay, rebuilt on every mount
let layerControl = null;
let data = null;
let placing = null;       // marker type awaiting a map click
let placeMode = 'pin';    // 'pin' | 'area' - how the next feature gets drawn
let lineDraft = null;     // in-progress trail
let areaDraft = null;     // in-progress polygon or scoring line: { type, mode, coords: [[lat,lon],...] }
let selectedId = null;

const ATTRIB = {
  esri: 'Imagery &copy; Esri, Maxar, Earthstar Geographics',
  usgs: 'USGS The National Map',
  osm: '&copy; OpenStreetMap contributors',
  mrlc: 'Land cover: NLCD 2021 / MRLC',
};

// Land cover as a toggleable OVERLAY rather than a basemap, so it can sit translucent
// over the aerial and you can see both the satellite and what NLCD thinks it is. 30 m
// pixels look blocky next to z18 imagery; that blockiness is honest about the resolution.
function coverOverlay() {
  return L.tileLayer.wms('https://www.mrlc.gov/geoserver/mrlc_display/wms', {
    layers: 'NLCD_2021_Land_Cover_L48',
    format: 'image/png',
    transparent: true,
    opacity: 0.45,
    version: '1.1.1',
    attribution: ATTRIB.mrlc,
  });
}

// maxNativeZoom is the important setting here, and leaving it off is what made the two
// USGS layers go blank when you zoomed in.
//
// Both USGS services stop publishing tiles above z16 for this area: z17 and beyond return
// 404, verified directly against the property coordinates. Without maxNativeZoom, Leaflet
// keeps requesting tiles at the current zoom, gets nothing back, and renders an empty
// layer. With it, Leaflet stops requesting at the native limit and upscales those tiles
// for deeper zooms. The result goes soft past z16 rather than disappearing, which is the
// right tradeoff: a blurry contour line still tells you where the ridge is.
function basemaps() {
  return {
    'Aerial (Esri)': L.tileLayer('https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
      maxZoom: 19, maxNativeZoom: 19, attribution: ATTRIB.esri,
    }),
    'Aerial (USGS)': L.tileLayer('https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}', {
      maxZoom: 19, maxNativeZoom: 16, attribution: ATTRIB.usgs,
    }),
    'Topo (contours)': L.tileLayer('https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile/{z}/{y}/{x}', {
      maxZoom: 19, maxNativeZoom: 16, attribution: ATTRIB.usgs,
    }),
    'Streets': L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19, maxNativeZoom: 19, attribution: ATTRIB.osm,
    }),
  };
}

function pinIcon(type, types, selected) {
  const t = types[type] ?? { color: '#888', glyph: '?' };
  const size = type === 'stand' ? 22 : 17;
  return L.divIcon({
    className: '',
    html: `<div class="pin${selected ? ' placing' : ''}" style="width:${size}px;height:${size}px;background:${t.color}">${t.glyph}</div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
}

function draw() {
  layerGroup.clearLayers();
  const types = data.markerTypes;

  // Cover areas (woods, field) draw first and deliberately dim. They are background
  // context, not targets, and rendering them as loud as a food plot would bury the things
  // you actually navigate by. No centre pin either: a 20-acre block of timber does not
  // need a marker in the middle of it.
  for (const p of data.points) {
    if (!(p.type === 'woods' || p.type === 'field')) continue;
    const ring = p.shape?.ring;
    if (!ring || ring.length < 3) continue;
    const color = types[p.type]?.color ?? '#555';
    L.polygon(ring, {
      color, weight: 1, opacity: p.id === selectedId ? 0.8 : 0.4,
      fillColor: color, fillOpacity: p.id === selectedId ? 0.22 : 0.10,
      interactive: true,
    }).addTo(layerGroup)
      .on('click', () => { selectedId = p.id; draw(); renderEditor(); })
      .bindTooltip(`${esc(p.label)}${p.shape.acres ? ` · ${p.shape.acres} ac` : ''}`, { sticky: true });
  }

  // Areas render as a filled boundary with the label pin at the centroid, so a drawn
  // field reads as a field rather than as a pin sitting in the middle of one.
  for (const p of data.points) {
    if (p.type === 'woods' || p.type === 'field') continue;
    const ring = p.shape?.ring;
    if (!ring || ring.length < 3) continue;
    const color = types[p.type]?.color ?? '#888';
    const dry = p.type === 'water' && p.active === false;
    L.polygon(ring, {
      color, weight: 2, opacity: dry ? 0.45 : 0.9,
      fillColor: color, fillOpacity: p.id === selectedId ? 0.28 : 0.13,
      dashArray: dry ? '5,5' : null,
    }).addTo(layerGroup)
      .on('click', () => { selectedId = p.id; draw(); renderEditor(); })
      .bindTooltip(`${esc(p.label)}${p.shape.acres ? ` · ${p.shape.acres} ac` : ''}${dry ? ' (dry)' : ''}`, { sticky: true });
  }

  // Scoring lines: a creek, a drainage, a hedgerow. Drawn heavier than a game trail so
  // the two read differently at a glance, since one moves the score and one does not.
  for (const p of data.points) {
    const path = p.shape?.path;
    if (!path || path.length < 2) continue;
    const color = types[p.type]?.color ?? '#888';
    const dry = p.type === 'water' && p.active === false;
    L.polyline(path, {
      color, weight: p.id === selectedId ? 6 : 4, opacity: dry ? 0.45 : 0.9,
      dashArray: dry ? '6,6' : null, lineCap: 'round',
    }).addTo(layerGroup)
      .on('click', () => { selectedId = p.id; draw(); renderEditor(); })
      .bindTooltip(`${esc(p.label)}${p.shape.lengthYards ? ` · ${p.shape.lengthYards} yd` : ''}${dry ? ' (dry)' : ''}`, { sticky: true });
  }

  for (const p of data.points) {
    if (types[p.type]?.backgroundOnly) continue;
    const isArea = p.shape?.ring?.length >= 3;
    const hasShape = !!p.shape;
    const m = L.marker([p.lat, p.lon], { icon: pinIcon(p.type, types, p.id === selectedId), draggable: !hasShape })
      .addTo(layerGroup)
      .bindTooltip(`${esc(p.label)}${p.shape?.acres ? ` · ${p.shape.acres} ac` : ''}${p.shape?.lengthYards ? ` · ${p.shape.lengthYards} yd` : ''}${p.type === 'water' && p.active === false ? ' (dry)' : ''}`, { direction: 'top', offset: [0, -10] });
    m.on('click', () => { selectedId = p.id; draw(); renderEditor(); });
    // A shape's marker is a derived anchor (ring centroid, or path midpoint), so dragging
    // it would silently desync the label from the geometry that actually scores. Only true
    // pins drag; move a shape by redrawing it.
    if (!hasShape) {
      m.on('dragend', async (e) => {
        const { lat, lng } = e.target.getLatLng();
        await api(`/api/map/points/${p.id}`, { method: 'PATCH', body: JSON.stringify({ lat, lon: lng }) });
        await reload();
      });
    }
  }

  for (const ln of data.lines ?? []) {
    L.polyline(ln.coords, {
      color: types[ln.type]?.color ?? '#c084fc',
      weight: 3, opacity: 0.85,
      dashArray: ln.type === 'access' ? '6,6' : null,
    }).addTo(layerGroup).bindTooltip(esc(ln.label), { sticky: true });
  }

  if (lineDraft?.length) {
    L.polyline(lineDraft, { color: '#5ac8fa', weight: 3, dashArray: '4,6' }).addTo(layerGroup);
    for (const c of lineDraft) L.circleMarker(c, { radius: 3, color: '#5ac8fa' }).addTo(layerGroup);
  }

  if (areaDraft?.coords.length) {
    const color = types[areaDraft.type]?.color ?? '#5ac8fa';
    const closed = areaDraft.mode === 'area' && areaDraft.coords.length >= 3;
    if (closed) {
      L.polygon(areaDraft.coords, { color, weight: 2, dashArray: '5,5', fillColor: color, fillOpacity: 0.12 }).addTo(layerGroup);
    } else if (areaDraft.coords.length >= 2) {
      L.polyline(areaDraft.coords, { color, weight: 3, dashArray: '5,5' }).addTo(layerGroup);
    }
    for (const c of areaDraft.coords) L.circleMarker(c, { radius: 4, color, fillColor: color, fillOpacity: 1 }).addTo(layerGroup);
  }
}

async function reload() {
  data = await api('/api/map');
  draw();
  renderPointList();
  renderEditor();
}

function renderPointList() {
  const types = data.markerTypes;
  const groups = {};
  for (const p of data.points) (groups[p.type] ??= []).push(p);

  if (!data.points.length) {
    $('#pointList').innerHTML = `<div class="banner empty">
      Nothing marked yet. Pick a type above and click the map.<br><br>
      Start with your four stands, then bedding: bedding is what the scent-safety check
      measures against, so the wind verdicts stay guesses until at least one is marked.<br><br>
      Food, water and bedding can each be a <b>pin</b> or a drawn <b>area</b>. Draw the area
      when the thing has real extent: a field, a plot, a pond, a thicket. It changes the
      numbers, not just the picture, since distances then measure to the nearest edge and the
      scent check tests the whole boundary instead of one point in the middle.
    </div>`;
    return;
  }

  $('#pointList').innerHTML = Object.entries(groups).map(([type, pts]) => `
    <h4>${esc(types[type]?.label ?? type)} (${pts.length})</h4>
    ${pts.map((p) => `
      <div class="ptrow" data-id="${p.id}" style="cursor:pointer">
        <span class="swatch" style="background:${types[p.type]?.color};${p.shape ? 'border-radius:2px;outline:1px solid ' + types[p.type]?.color + ';outline-offset:1px' : ''}"></span>
        <span>${esc(p.label)}</span>
        ${p.shape?.acres ? `<span class="muted mono" style="font-size:10px">${p.shape.acres} ac</span>` : ''}
        ${p.type === 'water' && p.active === false ? '<span class="badge unsafe">dry</span>' : ''}
        ${p.type === 'stand' && p.terrain ? `<span class="badge unknown">${esc(p.terrain)}</span>` : ''}
        ${p.type === 'stand' && p.safeWinds?.length ? `<span class="badge manual">${p.safeWinds.length} winds tagged</span>` : ''}
        ${p.type === 'stand' && p.daysSinceHunted != null ? `<span class="muted mono right" style="font-size:11px">${p.daysSinceHunted}d</span>` : ''}
      </div>`).join('')}
  `).join('');

  $$('#pointList .ptrow').forEach((r) => {
    r.onclick = () => {
      selectedId = r.dataset.id;
      const p = data.points.find((x) => x.id === selectedId);
      if (p) map.panTo([p.lat, p.lon]);
      draw(); renderEditor();
    };
  });
}

function windRose(p) {
  const cw = p.computedWinds;
  if (!cw) return '';
  const tagged = new Set((p.safeWinds ?? []).map((w) => w.toUpperCase()));
  const cells = DIRS.map((d) => {
    const cls = cw.safe.includes(d) ? 'safe' : cw.caution.includes(d) ? 'caution' : 'unsafe';
    return `<div class="${cls}${tagged.has(d) ? ' tagged' : ''}" title="${d}: geometry says ${cls}${tagged.has(d) ? ', and you tagged it safe' : ''}">${d}</div>`;
  }).join('');
  const best = cw.best?.map((b) => b.wind).join(', ');
  return `<h4>Computed wind safety</h4>
    <div class="rose">${cells}</div>
    <div class="note">
      Green means scent clears every bedding and food point by more than the safety angle.
      ${cw.safe.length === 0 ? `Nothing is fully clear from this stand, which happens when it sits between bedding and food. Best available: <b>${esc(best)}</b>.` : ''}
      A blue outline marks the winds you tagged from experience; those always win over the geometry.
    </div>`;
}

function renderEditor() {
  const p = data.points.find((x) => x.id === selectedId);
  if (!p) { $('#editor').innerHTML = '<span class="muted" style="font-size:13px">Select a point on the map or in the list.</span>'; return; }
  const types = data.markerTypes;
  const terrains = data.terrainPositions ?? {};

  $('#editor').innerHTML = `
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">
      <span class="swatch" style="background:${types[p.type]?.color}"></span>
      <b>${esc(types[p.type]?.label ?? p.type)}</b>
      ${p.isArea ? `<span class="badge manual">area · ${p.acres ?? '?'} ac</span>`
        : p.isLine ? `<span class="badge manual">line · ${p.lengthYards ?? '?'} yd</span>`
        : '<span class="badge unknown">pin</span>'}
      <span class="muted mono right" style="font-size:11px">${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}</span>
    </div>
    <label>Label</label><input type="text" id="edLabel" value="${esc(p.label)}">

    ${p.isArea ? `<div class="note">
      Boundary has ${p.shape.ring.length} points covering about ${p.acres} acres. Distances measure to the
      nearest edge, and a stand inside the boundary reads zero. The marker sits at the computed centroid and
      is label-only, which is why it does not drag. To reshape it, delete and redraw.
    </div>` : ''}

    ${p.isLine ? `<div class="note">
      A ${p.lengthYards}-yard run drawn with ${p.shape.path.length} points. Distances measure to the nearest
      point anywhere along it, which is the whole reason to draw a creek rather than pin it: a stand partway
      down the run would otherwise report the distance to whichever end got dropped. The scent check samples
      the full length. The marker sits at the midpoint and is label-only, so it does not drag; to reshape,
      delete and redraw.
    </div>` : ''}

    ${p.cover ? `<h4>Land cover</h4>
      <div class="kv"><span>${p.cover.source === 'manual' ? 'Your marking' : 'NLCD 2021'}</span>
        <span>${esc(p.cover.label)}</span></div>
      ${p.cover.deer ? `<div class="note">${esc(p.cover.deer)}</div>` : ''}
      ${p.cover.edge ? '<div class="note" style="border-left:2px solid var(--green);padding-left:8px;color:#4fd0a0">Sits on an edge: both cover and open ground within about 70 yards.</div>' : ''}
      ${p.cover.nearby?.length ? `<div class="note dim">Within a bowshot: ${p.cover.nearby.map(esc).join(', ')}</div>` : ''}` : ''}

    ${p.standDistances?.length ? `<h4>Distance from stands</h4>
      ${p.standDistances.map((d) => `<div class="kv"><span>${esc(d.label)}</span><span>${d.yards} yd</span></div>`).join('')}` : ''}

    ${p.type === 'water' ? `
      <div class="check"><input type="checkbox" id="edActive" ${p.active !== false ? 'checked' : ''}>
        <label for="edActive" style="margin:0;text-transform:none;letter-spacing:0;font-size:13px;color:var(--text)">Still holding water</label></div>
      <div class="note">Water flagged dry contributes nothing to scoring. In a drought year this is the flag that matters most, so keep it current.</div>` : ''}

    ${p.type === 'stand' || p.type === 'bedding' ? `
      <label>Terrain position</label>
      <select id="edTerrain">
        <option value="">-- not set --</option>
        ${Object.entries(terrains).map(([k, t]) => `<option value="${k}" ${p.terrain === k ? 'selected' : ''}>${esc(t.label)}</option>`).join('')}
      </select>
      <div class="note">${p.terrain ? esc(terrains[p.terrain]?.note ?? '') : 'Switch the basemap to Topo to read contour lines, then tag this point.'}</div>` : ''}

    ${p.type === 'stand' ? `
      <label>Safe winds from experience</label>
      <div class="windpick" id="edWinds">
        ${DIRS.map((d) => `<button data-w="${d}" class="${(p.safeWinds ?? []).map((x) => x.toUpperCase()).includes(d) ? 'on' : ''}">${d}</button>`).join('')}
      </div>
      <div class="note">These override the computed geometry everywhere in the tool. Tag only the winds you have actually sat this stand on and not been busted.</div>
      ${windRose(p)}
      ${p.thermalAM?.length || p.thermalPM?.length ? `<h4>Thermal notes</h4>
        ${(p.thermalAM ?? []).map((t) => `<div class="note thermal">AM: ${esc(t)}</div>`).join('')}
        ${(p.thermalPM ?? []).map((t) => `<div class="note thermal">PM: ${esc(t)}</div>`).join('')}` : ''}
      <div class="kv" style="margin-top:9px"><span>Last hunted</span><span>${p.lastHunted ?? 'never'}${p.daysSinceHunted != null ? ` (${p.daysSinceHunted}d)` : ''}</span></div>` : ''}

    <label>Notes</label><textarea id="edNotes">${esc(p.notes ?? '')}</textarea>
    <div style="margin-top:11px;display:flex;gap:8px">
      <button class="btn primary" id="edSave">Save</button>
      <button class="btn danger right" id="edDelete">Delete</button>
    </div>`;

  $$('#edWinds button').forEach((b) => { b.onclick = () => b.classList.toggle('on'); });

  $('#edSave').onclick = async () => {
    const body = {
      label: $('#edLabel').value.trim() || p.label,
      notes: $('#edNotes').value,
    };
    if (p.type === 'water') body.active = $('#edActive').checked;
    if ($('#edTerrain')) body.terrain = $('#edTerrain').value || null;
    if ($('#edWinds')) body.safeWinds = $$('#edWinds button.on').map((b) => b.dataset.w);
    await api(`/api/map/points/${p.id}`, { method: 'PATCH', body: JSON.stringify(body) });
    await reload();
  };

  $('#edDelete').onclick = async () => {
    if (!confirm(`Delete "${p.label}"? This cannot be undone.`)) return;
    await api(`/api/map/points/${p.id}`, { method: 'DELETE' });
    selectedId = null;
    await reload();
  };
}

const AREA_CAPABLE = (type) => !!data.markerTypes[type]?.areaCapable;
const LINE_CAPABLE = (type) => !!data.markerTypes[type]?.lineCapable;
const SHAPE_CAPABLE = (type) => AREA_CAPABLE(type) || LINE_CAPABLE(type);
const MIN_POINTS = (mode) => (mode === 'area' ? 3 : 2);

function setPlacing(type) {
  placing = type;
  lineDraft = null;
  areaDraft = null;
  $('#cancelPlace').classList.toggle('hide', !type);
  $('#cancelPlace').textContent = 'Cancel';
  $$('#placeButtons button').forEach((b) => b.classList.toggle('active', b.dataset.t === type));
  $('#placeLine').classList.remove('active');

  // Food, water and bedding can be a pin, an area or a line. Everything else is a pin
  // only: a stand is a point by definition, and so is a parking spot.
  const shapeOk = type && SHAPE_CAPABLE(type);
  // Cover types are areas by definition: a single point of "woods" describes nothing, so
  // the pin option is hidden and area mode is forced.
  const bgOnly = type && data.markerTypes[type]?.backgroundOnly;
  $('#modeToggle').classList.toggle('hide', !shapeOk);
  if (!shapeOk) placeMode = 'pin';
  if (bgOnly) placeMode = 'area';
  if (placeMode === 'area' && !AREA_CAPABLE(type)) placeMode = 'pin';
  if (placeMode === 'line' && !LINE_CAPABLE(type)) placeMode = 'pin';
  $$('#modeToggle button').forEach((b) => {
    b.classList.toggle('active', b.dataset.m === placeMode);
    const ok = b.dataset.m === 'pin'
      ? !bgOnly
      : b.dataset.m === 'area' ? AREA_CAPABLE(type) : LINE_CAPABLE(type);
    b.classList.toggle('hide', !!type && !ok);
  });

  const label = type ? data.markerTypes[type].label.toLowerCase() : '';
  $('#mapHint').textContent = !type
    ? 'Pick a marker type, then click the map.'
    : placeMode === 'area'
      ? `Click around the edge of the ${label} area. Three points minimum, then press Finish.`
      : placeMode === 'line'
        ? `Click along the ${label} run, upstream to downstream. Two points minimum, then press Finish.`
        : `Click the map to drop a ${label} pin.`;
  if (map) map.getContainer().style.cursor = type ? 'crosshair' : '';
}

function setPlaceMode(mode) {
  placeMode = mode;
  areaDraft = null;
  draw();
  setPlacing(placing);
}

async function finishShape() {
  const draft = areaDraft;
  areaDraft = null;
  $('#cancelPlace').textContent = 'Cancel';
  if (!draft || draft.coords.length < MIN_POINTS(draft.mode)) {
    setPlacing(null);
    await reload();
    return;
  }
  const typeLabel = data.markerTypes[draft.type].label;
  const label = prompt(`Name this ${typeLabel.toLowerCase()}:`, typeLabel);
  if (label !== null) {
    // ring for an area, path for a line. The server derives the label anchor, acreage or
    // run length, and stores the shape type.
    const shape = draft.mode === 'area' ? { ring: draft.coords } : { path: draft.coords };
    const created = await api('/api/map/points', {
      method: 'POST',
      body: JSON.stringify({ type: draft.type, label: label || typeLabel, shape }),
    });
    selectedId = created.id;
  }
  setPlacing(null);
  await reload();
}

function startLine() {
  placing = null;
  lineDraft = [];
  $$('#placeButtons button').forEach((b) => b.classList.remove('active'));
  $('#placeLine').classList.add('active');
  $('#cancelPlace').classList.remove('hide');
  $('#mapHint').textContent = 'Click along the trail. Press Finish when done.';
  $('#cancelPlace').textContent = 'Finish trail';
  map.getContainer().style.cursor = 'crosshair';
}

async function finishLine() {
  if (lineDraft && lineDraft.length >= 2) {
    const label = prompt('Name this trail or access route:', 'Game trail');
    if (label) {
      const type = /access|walk|entry|route/i.test(label) ? 'access' : 'trail';
      await api('/api/map/lines', { method: 'POST', body: JSON.stringify({ type, label, coords: lineDraft }) });
    }
  }
  lineDraft = null;
  $('#cancelPlace').textContent = 'Cancel';
  $('#cancelPlace').classList.add('hide');
  $('#placeLine').classList.remove('active');
  map.getContainer().style.cursor = '';
  await reload();
}

/**
 * Sightings as arrows.
 *
 * Each one draws only the stretch that was actually watched: from where the deer was
 * picked up to where cover took it, through the point it was logged at. Nothing is
 * extrapolated. A deer seen for 30 yards gets a 30-yard arrow, and a sighting with no
 * watched distance gets a dot and no line at all, because a direction with no length
 * would imply knowledge of a route nobody saw.
 *
 * A faint spoke back to the stand is drawn too. Without it a cluster of arrows out in a
 * field says nothing about which stand produced them, and that is most of the value.
 */
function sightingLayer(vectors) {
  const group = L.layerGroup();
  for (const v of vectors) {
    const seen = [v.seenAt.lat, v.seenAt.lon];
    const bucks = v.buckCount > 0;
    const color = bucks ? 'var(--amber)' : '#86a85e';
    const hex = bucks ? '#d9a441' : '#86a85e';

    L.polyline([[v.standAt.lat, v.standAt.lon], seen],
      { color: hex, weight: 1, opacity: 0.25, dashArray: '3,5', interactive: false }).addTo(group);

    const when = v.atTime ? `${v.atTime}${v.minutesFromAnchor != null ? ` (${v.minutesFromAnchor >= 0 ? '+' : ''}${v.minutesFromAnchor}m)` : ''}` : 'time not logged';
    const label = [
      `<b>${esc(v.date)} ${esc(v.slot)}</b> from ${esc(v.standLabel ?? 'stand')}`,
      `${v.deerCount} deer${v.buckCount ? ` (${v.buckCount} buck)` : ''}${v.behavior ? `, ${esc(v.behavior)}` : ''}`,
      `${esc(v.bearingCompass ?? '?')} at ${v.distanceYards} yd &middot; ${esc(when)}`,
      v.travelCompass ? `heading ${esc(v.travelCompass)}, watched ${v.watchedYards} yd` : 'heading not logged',
      v.notes ? `<i>${esc(v.notes)}</i>` : '',
    ].filter(Boolean).join('<br>');

    if (v.from && v.to) {
      L.polyline([[v.from.lat, v.from.lon], [v.to.lat, v.to.lon]],
        { color: hex, weight: 3, opacity: 0.9 }).bindTooltip(label, { sticky: true }).addTo(group);
      for (const head of arrowHead(v.from, v.to)) {
        L.polyline(head, { color: hex, weight: 3, opacity: 0.9, interactive: false }).addTo(group);
      }
    }

    L.circleMarker(seen, {
      radius: 4, color: hex, weight: 2, fillColor: hex, fillOpacity: bucks ? 0.9 : 0.5,
    }).bindTooltip(label, { sticky: true }).addTo(group);
  }
  return group;
}

/**
 * Two short strokes at the far end of the arrow.
 *
 * Leaflet has no arrowhead primitive and the project vendors only Leaflet core, so this
 * is computed in screen space: converting the last leg to layer points means the head
 * keeps a constant size on screen instead of growing as you zoom, which is what makes a
 * 30-yard arrow readable at all.
 */
let lastVectors = [];

/** Rebuild the overlay's contents in place, so the layer toggle keeps its state. */
function fillSightings() {
  if (!sightingGroup) return;
  sightingGroup.clearLayers();
  for (const l of sightingLayer(lastVectors).getLayers()) sightingGroup.addLayer(l);
}

function arrowHead(from, to) {
  if (!map) return [];
  const a = map.latLngToLayerPoint([from.lat, from.lon]);
  const b = map.latLngToLayerPoint([to.lat, to.lon]);
  const ang = Math.atan2(b.y - a.y, b.x - a.x);
  const size = 9;
  return [25, -25].map((deg) => {
    const t = ang + Math.PI + (deg * Math.PI) / 180;
    const tip = L.point(b.x + Math.cos(t) * size, b.y + Math.sin(t) * size);
    return [map.layerPointToLatLng(b), map.layerPointToLatLng(tip)];
  });
}

export async function mount() {
  data = await api('/api/map');
  // Never fatal: a map that will not draw your stands because a sighting query failed is
  // a worse outcome than a map with no arrows on it.
  const sightings = await api('/api/sightings/vectors').catch(() => ({ vectors: [], total: 0, unmappable: 0 }));

  if (!map) {
    const center = [data.center.lat, data.center.lon];
    map = L.map('map', { center, zoom: data.defaultZoom ?? 16, zoomControl: true });
    const bases = basemaps();
    bases['Aerial (Esri)'].addTo(map);
    const overlays = { 'Land cover (NLCD)': coverOverlay() };
    // Sightings get their own toggle, off by default: on a property with a few seasons of
    // them they would otherwise bury the markers you are trying to edit.
    sightingGroup = L.layerGroup();
    overlays['Sightings'] = sightingGroup;
    layerControl = L.control.layers(bases, overlays, { position: 'topright' }).addTo(map);
    L.control.scale({ imperial: true, metric: false }).addTo(map);
    layerGroup = L.layerGroup().addTo(map);

    // Optional image overlay, for an onX or plat screenshot that shows boundaries the
    // aerial does not. Off unless configured in map.json.
    const ov = data.imageOverlay;
    if (ov?.enabled && ov.file && ov.bounds?.north != null) {
      L.imageOverlay(`/overlays/${ov.file}`, [[ov.bounds.south, ov.bounds.west], [ov.bounds.north, ov.bounds.east]], { opacity: ov.opacity ?? 0.6 }).addTo(map);
    }

    // Arrowheads are sized in screen space, so they have to be redrawn when the zoom
    // changes or they end up pointing at the wrong place at a different scale.
    map.on('zoomend', () => { if (map.hasLayer(sightingGroup)) fillSightings(); });

    map.on('click', async (e) => {
      if (lineDraft) { lineDraft.push([e.latlng.lat, e.latlng.lng]); draw(); return; }
      if (!placing) return;

      if ((placeMode === 'area' || placeMode === 'line') && SHAPE_CAPABLE(placing)) {
        areaDraft ??= { type: placing, mode: placeMode, coords: [] };
        areaDraft.coords.push([e.latlng.lat, e.latlng.lng]);
        const need = MIN_POINTS(areaDraft.mode);
        const ready = areaDraft.coords.length >= need;
        const verb = areaDraft.mode === 'area' ? 'Finish area' : 'Finish line';
        $('#cancelPlace').classList.remove('hide');
        $('#cancelPlace').textContent = ready ? verb : 'Cancel';
        $('#mapHint').textContent = ready
          ? `${areaDraft.coords.length} points. Keep clicking, or press ${verb}.`
          : `${need - areaDraft.coords.length} more point(s) needed.`;
        draw();
        return;
      }

      const label = prompt(`Name this ${data.markerTypes[placing].label.toLowerCase()}:`, data.markerTypes[placing].label);
      // eslint-disable-next-line no-unused-expressions
      if (label === null) return;
      const created = await api('/api/map/points', {
        method: 'POST',
        body: JSON.stringify({ type: placing, label: label || data.markerTypes[placing].label, lat: e.latlng.lat, lon: e.latlng.lng }),
      });
      selectedId = created.id;
      setPlacing(null);
      await reload();
    });

    // Exposed for debugging from the console: layer and zoom checks are far easier
    // against the real instance than by driving the controls.
    window.__dhMap = map;
    window.__dhBasemaps = bases;

    const entries = Object.entries(data.markerTypes).filter(([k]) => k !== 'access');
    const main = entries.filter(([, t]) => !t.backgroundOnly);
    const cover = entries.filter(([, t]) => t.backgroundOnly);
    const btn = ([k, t], dim) => `<button class="btn sm${dim ? ' cover-btn' : ''}" data-t="${k}" style="border-left:3px solid ${t.color}">${esc(t.label)}</button>`;
    $('#placeButtons').innerHTML = main.map((e) => btn(e, false)).join(' ')
      + (cover.length ? `<span class="cover-sep" title="Background cover. Drawn dim, and context only: these never move a score.">cover</span>${cover.map((e) => btn(e, true)).join(' ')}` : '');
    $$('#placeButtons button').forEach((b) => {
      b.onclick = () => setPlacing(placing === b.dataset.t ? null : b.dataset.t);
    });
    $('#placeLine').onclick = () => (lineDraft ? finishLine() : startLine());
    $('#cancelPlace').onclick = () => {
      if (lineDraft) return finishLine();
      if (areaDraft) return finishShape();
      return setPlacing(null);
    };
    $$('#modeToggle button').forEach((b) => { b.onclick = () => setPlaceMode(b.dataset.m); });
  }

  // Leaflet mis-sizes itself when its container was display:none at init.
  setTimeout(() => map.invalidateSize(), 50);
  lastVectors = sightings.vectors ?? [];
  fillSightings();
  if (sightings.unmappable) {
    // Say it rather than silently drawing fewer arrows than there are sightings.
    $('#mapHint').textContent =
      `${sightings.unmappable} of ${sightings.total} sightings have no stand, bearing or distance, so they are not on the map.`;
  }
  draw();
  renderPointList();
  renderEditor();
}
