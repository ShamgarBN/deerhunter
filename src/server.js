// Express server: JSON API plus the static dashboard.
//
// No auth, by design. Single hunter, private tailnet, and the threat model for "someone
// on Ben's Tailscale learns where the bean field is" does not justify a login screen on
// a tool he opens one-handed from a tree at 6am.

import express from 'express';
import path from 'path';
import fs from 'fs';
import cron from 'node-cron';
import { ROOT, loadConfig, loadScoring, loadMap, saveMap, saveConfig, saveScoring } from './config.js';
import { getDb } from './db.js';
import { refresh, checkAlerts, lastHuntedByStand } from './jobs.js';
import { runReweight, resetToPriors, adjustmentHistory } from './reweight.js';
import { calibrate, distribution } from './calibrate.js';
import { sunMoonFor } from './astro.js';
import { rutFor, seasonHighlights } from './rut.js';
import { loadSeasons, seasonsOn, strictnessOn, normalizeSeason, WEAPON_PROFILES } from './seasons.js';
import { safeWindSectors, standVerdict, thermalNotes } from './wind.js';
import { ringCentroid, ringAcres, pathMidpoint, pathLengthYards, distanceToFeatureYards } from './geo.js';
import { coverForStand, coverForPoints, manualCoverAt, describe, sampleNlcd, wmsInfo, NLCD_CLASSES } from './cover.js';
import { testWebhook } from './discord.js';
import { todayLocal, addDays, dateRange, nowIso, weekday, daysBetween } from './timeutil.js';

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(ROOT, 'public')));
// Leaflet is served from node_modules rather than a CDN so the dashboard keeps working
// if Ben's tailnet has no route to the open internet. Map TILES still need the internet;
// the client caches the last scores so the page is useful without them.
app.use('/vendor/leaflet', express.static(path.join(ROOT, 'node_modules/leaflet/dist')));

const wrap = (fn) => (req, res) => {
  Promise.resolve(fn(req, res)).catch((err) => {
    console.error(`[api] ${req.method} ${req.path}:`, err);
    res.status(500).json({ error: err.message });
  });
};

// --- state ------------------------------------------------------------------

app.get('/api/state', wrap((req, res) => {
  const cfg = loadConfig();
  const scoring = loadScoring();
  const map = loadMap();
  const db = getDb();
  const today = todayLocal(cfg.property.timezone);
  const inSeason = today >= cfg.season.start && today <= cfg.season.end;

  const lastRefresh = db.prepare('SELECT MAX(computed_at) AS t FROM scores').get()?.t ?? null;
  const sitCount = db.prepare('SELECT COUNT(*) AS n FROM sits').get().n;

  res.json({
    property: cfg.property,
    season: cfg.season,
    seasons: loadSeasons(cfg),
    openToday: seasonsOn(today, loadSeasons(cfg)).map((x) => ({ id: x.id, label: x.label, color: x.color, weapon: x.weapon })),
    today,
    inSeason,
    daysToSeason: inSeason ? 0 : daysBetween(today, cfg.season.start),
    rutToday: rutFor(today, scoring),
    highlights: seasonHighlights(scoring, cfg.season),
    peakRutDate: scoring.peakRutDate,
    drought: cfg.drought,
    alerts: cfg.alerts,
    forecast: cfg.forecast,
    mapConfig: { center: map.center, defaultZoom: map.defaultZoom, markerTypes: map.markerTypes, terrainPositions: map.terrainPositions, imageOverlay: map.imageOverlay },
    counts: {
      stands: map.points.filter((p) => p.type === 'stand').length,
      food: map.points.filter((p) => p.type === 'food').length,
      water: map.points.filter((p) => p.type === 'water' && p.active !== false).length,
      waterDry: map.points.filter((p) => p.type === 'water' && p.active === false).length,
      bedding: map.points.filter((p) => p.type === 'bedding').length,
      sits: sitCount,
    },
    calibrated: !(scoring.calibration?.buck?.offset === 0 && scoring.calibration?.buck?.gain === 1),
    calibration: scoring.calibration,
    lastRefresh,
    serverTime: nowIso(),
  });
}));

// --- calendar and forecast --------------------------------------------------

function hydrate(row) {
  return {
    date: row.date,
    slot: row.slot,
    weekday: weekday(row.date),
    buckScore: row.buck_score,
    generalScore: row.general_score,
    rutOffset: row.rut_offset,
    rutPhase: row.rut_phase,
    confidence: row.confidence,
    available: row.slot === 'AM' ? !!row.avail_am : !!row.avail_pm,
    weather: {
      source: row.source,
      tempF: row.temp_f,
      tempNormalF: row.temp_normal_f,
      departureF: row.temp_f != null && row.temp_normal_f != null ? +(row.temp_f - row.temp_normal_f).toFixed(1) : null,
      windMph: row.wind_mph,
      windDirDeg: row.wind_dir_deg,
      gustMph: row.gust_mph,
      windSteadiness: row.wind_steadiness,
      windConfidence: row.wind_confidence,
      windConfidenceLabel: row.wind_confidence_label,
      tempChange24h: row.temp_change_24h,
      pressureHpa: row.pressure_hpa,
      pressureChange24h: row.pressure_change_24h,
      precipProb: row.precip_prob,
      precipMm: row.precip_mm,
      skyCover: row.sky_cover,
      humidity: row.humidity,
      tempMinF: row.temp_min_f,
      tempMaxF: row.temp_max_f,
      windowStart: row.window_start,
      windowEnd: row.window_end,
    },
  };
}

const CAL_SQL = `
  SELECT s.*, w.source, w.temp_f, w.temp_normal_f, w.temp_min_f, w.temp_max_f,
         w.wind_mph, w.wind_dir_deg, w.gust_mph, w.wind_steadiness,
         w.wind_confidence, w.wind_confidence_label,
         w.precip_prob, w.precip_mm, w.sky_cover, w.humidity,
         w.pressure_hpa, w.pressure_change_24h, w.pressure_delta_window,
         w.temp_change_24h, w.temp_change_48h, w.window_start, w.window_end,
         a.am AS avail_am, a.pm AS avail_pm
    FROM scores s
    LEFT JOIN weather w ON w.date = s.date AND w.slot = s.slot
    LEFT JOIN availability a ON a.date = s.date
   WHERE s.date >= ? AND s.date <= ?
   ORDER BY s.date, s.slot`;

app.get('/api/calendar', wrap((req, res) => {
  const cfg = loadConfig();
  const scoring = loadScoring();
  const allSeasons = loadSeasons(cfg);
  const rows = getDb().prepare(CAL_SQL).all(cfg.season.start, cfg.season.end);

  const byDate = new Map();
  for (const r of rows) {
    if (!byDate.has(r.date)) {
      byDate.set(r.date, {
        date: r.date,
        weekday: weekday(r.date),
        rutOffset: r.rut_offset,
        rutPhase: r.rut_phase,
        seasons: seasonsOn(r.date, allSeasons).map((x) => ({ id: x.id, label: x.label, color: x.color, weapon: x.weapon })),
        scent: strictnessOn(r.date, allSeasons),
        available: { AM: !!r.avail_am, PM: !!r.avail_pm },
        moon: sunMoonFor(r.date, cfg.property.lat, cfg.property.lon, cfg.property.timezone).moon,
        slots: {},
      });
    }
    byDate.get(r.date).slots[r.slot] = hydrate(r);
  }

  // Sits already logged, so the calendar can mark days he has hunted.
  const sits = getDb().prepare('SELECT date, slot, saw_deer, deer_count, buck_count FROM sits WHERE date >= ? AND date <= ?').all(cfg.season.start, cfg.season.end);
  for (const s of sits) {
    const d = byDate.get(s.date);
    if (d) (d.hunted ??= {})[s.slot] = { sawDeer: !!s.saw_deer, deerCount: s.deer_count, buckCount: s.buck_count };
  }

  res.json({
    season: cfg.season,
    seasons: allSeasons,
    phases: scoring.rutCurve.phases,
    highlights: seasonHighlights(scoring, cfg.season),
    peakRutDate: scoring.peakRutDate,
    days: [...byDate.values()],
  });
}));

app.get('/api/forecast', wrap((req, res) => {
  const cfg = loadConfig();
  const days = Math.min(+(req.query.days ?? cfg.forecast.nearTermDays), 30);
  const today = todayLocal(cfg.property.timezone);
  // Before the season opens, show the opening stretch instead of an empty list.
  const start = today < cfg.season.start ? cfg.season.start : today;
  const end = addDays(start, days - 1);

  const rows = getDb().prepare(CAL_SQL).all(start, end > cfg.season.end ? cfg.season.end : end);
  const out = rows.map((r) => {
    const base = hydrate(r);
    const astro = sunMoonFor(r.date, cfg.property.lat, cfg.property.lon, cfg.property.timezone);
    return {
      ...base,
      astro: {
        sunrise: astro.sunriseLocal, sunset: astro.sunsetLocal,
        legalStart: astro.legalStartLocal, legalEnd: astro.legalEndLocal,
        moon: astro.moon,
      },
      factors: JSON.parse(r.factors_json || '{}'),
      stands: JSON.parse(r.stands_json || '[]'),
    };
  });
  res.json({ start, end, forecastConfidenceDays: cfg.forecast.forecastConfidenceDays, slots: out });
}));

// --- per-stand breakdown ----------------------------------------------------
//
// The season calendar answers "is this slot worth hunting". This answers the next
// question: "given that, which stand do I sit."
//
// Worth understanding before reading the output: rut phase and weather are shared by
// every stand on the property, so they shift all stands together and do not separate
// them. What actually separates one stand from another on a given day is
//   1. scent safety on that day's forecast wind  <- the big one, and it changes daily
//   2. days since that stand was last hunted     <- changes as you hunt
//   3. distance to food and water                <- fixed until the map changes
// Past the forecast horizon there is no wind, so (1) drops out and the ranking goes
// nearly static. The UI labels that rather than implying a daily decision exists where
// none does.
app.get('/api/stands', wrap(async (req, res) => {
  const cfg = loadConfig();
  const map = loadMap();
  const db = getDb();
  const today = todayLocal(cfg.property.timezone);

  const stands = map.points.filter((p) => p.type === 'stand');
  const rows = db.prepare(`
    SELECT s.date, s.slot, s.rut_phase, s.rut_offset, s.confidence, s.stands_json,
           w.wind_dir_deg, w.wind_mph, w.temp_f, w.temp_normal_f, w.precip_prob,
           a.am AS avail_am, a.pm AS avail_pm
      FROM scores s
      LEFT JOIN weather w ON w.date = s.date AND w.slot = s.slot
      LEFT JOIN availability a ON a.date = s.date
     WHERE s.date >= ? AND s.date <= ?
     ORDER BY s.date, s.slot
  `).all(cfg.season.start, cfg.season.end);

  const perStand = Object.fromEntries(stands.map((s) => [s.id, {
    id: s.id, label: s.label, terrain: s.terrain ?? null,
    safeWinds: s.safeWinds ?? [],
    slots: [], safe: 0, caution: 0, unsafe: 0, unknown: 0,
  }]));

  const matrix = [];
  for (const r of rows) {
    const detail = JSON.parse(r.stands_json || '[]');
    const byId = Object.fromEntries(detail.map((d) => [d.id, d]));
    const available = r.slot === 'AM' ? !!r.avail_am : !!r.avail_pm;

    const cells = stands.map((st) => {
      const d = byId[st.id] ?? {};
      const cell = {
        standId: st.id,
        buck: d.buckScore ?? null,
        general: d.generalScore ?? null,
        verdict: d.verdict ?? 'unknown',
        daysSinceHunted: d.daysSinceHunted ?? null,
        conflicts: (d.conflicts ?? []).slice(0, 2).map((c) => c.label),
        thermal: (d.thermalNotes ?? []).length > 0,
      };
      const ps = perStand[st.id];
      if (ps) {
        ps.slots.push({ date: r.date, slot: r.slot, buck: cell.buck, general: cell.general, verdict: cell.verdict, available, confidence: r.confidence });
        ps[cell.verdict] = (ps[cell.verdict] ?? 0) + 1;
      }
      return cell;
    });

    // The pick for each score, excluding stands the wind has blown out. Buck and deer
    // frequently land on different stands, which is the whole reason both are shown.
    const pickFor = (m) => {
      const ok = cells.filter((c) => c[m] != null && c.verdict !== 'unsafe');
      if (!ok.length) return null;
      const top = ok.reduce((a, b) => (b[m] > a[m] ? b : a));
      return { standId: top.standId, score: top[m], verdict: top.verdict };
    };

    matrix.push({
      date: r.date, slot: r.slot, weekday: weekday(r.date),
      rutPhase: r.rut_phase, rutOffset: r.rut_offset, confidence: r.confidence,
      available,
      wind: r.wind_dir_deg == null ? null : { deg: r.wind_dir_deg, mph: r.wind_mph },
      cells,
      pickBuck: pickFor('buck'),
      pickGeneral: pickFor('general'),
    });
  }

  // Per-stand top slots, computed for BOTH scores rather than one at a time. The two
  // answer different questions and often disagree about which stand to sit, so showing
  // them together is the point; making the user toggle back and forth to compare hides
  // exactly the tradeoff the two-score design exists to expose.
  //
  // Restricted to scent-safe, caution or unknown: a 9.6 on a wind that blows straight
  // into bedding is not a recommendation.
  const rank = (slots, m) => [...slots].sort((a, b) => (b[m] ?? 0) - (a[m] ?? 0));
  const lastHunted = lastHuntedByStand();

  const summary = stands.map((st) => {
    const ps = perStand[st.id];
    const future = ps.slots.filter((x) => x.date >= today);
    const huntable = future.filter((x) => x.verdict !== 'unsafe');
    const free = huntable.filter((x) => x.available);
    const agg = (m) => {
      const scored = future.filter((x) => x[m] != null);
      return {
        avg: scored.length ? +(scored.reduce((a, x) => a + x[m], 0) / scored.length).toFixed(2) : null,
        peak: scored.length ? Math.max(...scored.map((x) => x[m])) : null,
        best: rank(huntable, m).slice(0, 4),
        bestAvailable: rank(free, m).slice(0, 3),
      };
    };
    return {
      ...st,
      slots: undefined,
      buck: agg('buck'),
      general: agg('general'),
      counts: { safe: ps.safe, caution: ps.caution, unsafe: ps.unsafe, unknown: ps.unknown },
      lastHunted: lastHunted[st.id] ?? null,
    };
  }).sort((a, b) => (b.buck.peak ?? 0) - (a.buck.peak ?? 0));

  // Land cover per stand. Enrichment only: a failed lookup leaves cover null and every
  // other number on the page is unaffected.
  await Promise.all(summary.map(async (st) => {
    const full = stands.find((x) => x.id === st.id);
    try { st.cover = full ? await coverForStand(full, map) : null; }
    catch { st.cover = null; }
  }));

  res.json({
    today,
    forecastConfidenceDays: cfg.forecast.forecastConfidenceDays,
    marked: {
      bedding: map.points.filter((p) => p.type === 'bedding').length,
      food: map.points.filter((p) => p.type === 'food').length,
      water: map.points.filter((p) => p.type === 'water' && p.active !== false).length,
    },
    stands: stands.map((s) => ({ id: s.id, label: s.label, terrain: s.terrain ?? null, safeWinds: s.safeWinds ?? [] })),
    summary,
    matrix,
  });
}));

// --- map --------------------------------------------------------------------

app.get('/api/map', wrap(async (req, res) => {
  const map = loadMap();
  const cfg = loadConfig();
  const lastHunted = lastHuntedByStand();
  const today = todayLocal(cfg.property.timezone);

  // Cover for every marked feature. Cached to disk, so this is a handful of network
  // calls the first time and none afterwards.
  let coverById = {};
  try { coverById = await coverForPoints(map.points.filter((p) => p.type !== 'woods' && p.type !== 'field'), map); }
  catch { coverById = {}; }

  const stands = map.points.filter((x) => x.type === 'stand');
  const points = map.points.map((p) => {
    if (p.type !== 'stand') {
      // How far this feature is from each stand, measured to the boundary for an area.
      // Useful in the editor to sanity-check a drawn field against the stands near it.
      return {
        ...p,
        cover: coverById[p.id] ?? null,
        isArea: p.shape?.type === 'polygon',
        isLine: p.shape?.type === 'line',
        acres: p.shape?.acres ?? null,
        lengthYards: p.shape?.lengthYards ?? null,
        standDistances: stands.map((s) => ({
          id: s.id, label: s.label,
          yards: Math.round(distanceToFeatureYards(s, p) ?? -1),
        })).filter((x) => x.yards >= 0).sort((a, b) => a.yards - b.yards),
      };
    }
    const sectors = safeWindSectors(p, map, cfg);
    const last = lastHunted[p.id] ?? null;
    return {
      ...p,
      cover: coverById[p.id] ?? null,
      computedWinds: sectors,
      lastHunted: last,
      daysSinceHunted: last ? daysBetween(last, today) : null,
      thermalAM: thermalNotes(p, map, 'AM', cfg, map.terrainPositions),
      thermalPM: thermalNotes(p, map, 'PM', cfg, map.terrainPositions),
    };
  });
  res.json({ ...map, points });
}));

// A feature is a pin, a drawn area, or a drawn line. A creek is a line, a field is an
// area, a seep is a pin, and each one measures differently. For a shape, the stored
// lat/lon are derived (ring centroid, or the midpoint by distance along a path) and used
// only for the map label; all scoring and scent geometry works off the shape itself.
function normalizeShape(p) {
  const ring = p.shape?.ring;
  if (Array.isArray(ring) && ring.length >= 3) {
    const c = ringCentroid(ring);
    return { shape: { type: 'polygon', ring, acres: ringAcres(ring) }, lat: c.lat, lon: c.lon };
  }
  const path = p.shape?.path;
  if (Array.isArray(path) && path.length >= 2) {
    const m = pathMidpoint(path);
    return { shape: { type: 'line', path, lengthYards: pathLengthYards(path) }, lat: m.lat, lon: m.lon };
  }
  return { shape: null, lat: p.lat == null ? null : +p.lat, lon: p.lon == null ? null : +p.lon };
}

app.post('/api/map/points', wrap((req, res) => {
  const map = loadMap();
  const p = req.body;
  const geom = normalizeShape(p);
  if (!p.type || geom.lat == null || geom.lon == null) {
    return res.status(400).json({ error: 'type plus one of: lat/lon, shape.ring (3+ points), or shape.path (2+ points)' });
  }
  const point = {
    id: p.id || `${p.type}-${Date.now().toString(36)}`,
    type: p.type,
    label: p.label || map.markerTypes[p.type]?.label || p.type,
    lat: geom.lat,
    lon: geom.lon,
    ...(geom.shape ? { shape: geom.shape } : {}),
    notes: p.notes ?? '',
    ...(p.type === 'water' ? { active: p.active !== false } : {}),
    ...(p.type === 'stand' ? { terrain: p.terrain ?? null, safeWinds: p.safeWinds ?? [], height: p.height ?? null } : {}),
    ...(p.type === 'bedding' ? { terrain: p.terrain ?? null } : {}),
    createdAt: nowIso(),
  };
  const i = map.points.findIndex((x) => x.id === point.id);
  if (i >= 0) map.points[i] = { ...map.points[i], ...point };
  else map.points.push(point);
  saveMap(map);
  res.json(point);
}));

app.patch('/api/map/points/:id', wrap((req, res) => {
  const map = loadMap();
  const i = map.points.findIndex((x) => x.id === req.params.id);
  if (i < 0) return res.status(404).json({ error: 'point not found' });
  const merged = { ...map.points[i], ...req.body, id: map.points[i].id };

  if (req.body.shape === null) {
    // Converting an area back to a pin: keep the centroid as the pin location.
    delete merged.shape;
  } else if (req.body.shape?.ring || req.body.shape?.path) {
    const geom = normalizeShape(merged);
    merged.shape = geom.shape;
    merged.lat = geom.lat;
    merged.lon = geom.lon;
  }
  map.points[i] = merged;
  saveMap(map);
  res.json(merged);
}));

app.delete('/api/map/points/:id', wrap((req, res) => {
  const map = loadMap();
  const before = map.points.length;
  map.points = map.points.filter((x) => x.id !== req.params.id);
  saveMap(map);
  res.json({ deleted: before - map.points.length });
}));

app.post('/api/map/lines', wrap((req, res) => {
  const map = loadMap();
  const l = req.body;
  if (!Array.isArray(l.coords) || l.coords.length < 2) return res.status(400).json({ error: 'coords must have at least two points' });
  const line = {
    id: l.id || `${l.type || 'trail'}-${Date.now().toString(36)}`,
    type: l.type || 'trail',
    label: l.label || 'Trail',
    coords: l.coords,
    notes: l.notes ?? '',
    createdAt: nowIso(),
  };
  const i = map.lines.findIndex((x) => x.id === line.id);
  if (i >= 0) map.lines[i] = line; else map.lines.push(line);
  saveMap(map);
  res.json(line);
}));

app.delete('/api/map/lines/:id', wrap((req, res) => {
  const map = loadMap();
  const before = map.lines.length;
  map.lines = map.lines.filter((x) => x.id !== req.params.id);
  saveMap(map);
  res.json({ deleted: before - map.lines.length });
}));

// Wind rose for one stand: every compass sector with its verdict.
app.get('/api/stands/:id/winds', wrap((req, res) => {
  const map = loadMap();
  const cfg = loadConfig();
  const stand = map.points.find((p) => p.id === req.params.id && p.type === 'stand');
  if (!stand) return res.status(404).json({ error: 'stand not found' });
  const sectors = safeWindSectors(stand, map, cfg);
  const detail = sectors.ranked.map((r) => ({ ...r, ...standVerdict(stand, map, (['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'].indexOf(r.wind)) * 22.5, cfg) }));
  res.json({ stand, sectors, detail });
}));

// --- seasons ----------------------------------------------------------------

app.get('/api/seasons', wrap((req, res) => {
  const cfg = loadConfig();
  res.json({
    seasons: loadSeasons(cfg),
    weapons: WEAPON_PROFILES,
    today: todayLocal(cfg.property.timezone),
    note: 'Weapon is not cosmetic: it scales the scent-safety threshold. Where seasons overlap, the strictest open weapon governs.',
  });
}));

// Replaces the whole list, which keeps delete and reorder trivial and avoids a per-season
// id scheme that would have to survive renames.
app.post('/api/seasons', wrap((req, res) => {
  const incoming = req.body?.seasons;
  if (!Array.isArray(incoming)) return res.status(400).json({ error: 'send { seasons: [...] }' });

  const bad = incoming.find((s) => !s.start || !s.end || s.start > s.end);
  if (bad) return res.status(400).json({ error: `"${bad.label ?? 'a season'}" needs a start and end date, with start no later than end` });

  const cfg = loadConfig();
  cfg.seasons = incoming.map((s, i) => normalizeSeason(s, i));
  delete cfg.season; // derived at load; never persisted
  saveConfig(cfg);
  res.json({ seasons: loadSeasons(loadConfig()), note: 'Run a refresh to rescore against the new dates.' });
}));

// --- land cover -------------------------------------------------------------

app.get('/api/cover/legend', wrap((req, res) => {
  res.json({
    wms: wmsInfo,
    classes: NLCD_CLASSES,
    note: 'NLCD 2021, 30 m pixels, via MRLC. Context and validation only: no scoring weight. Manual woods/field areas you draw override it.',
  });
}));

// Point lookup, used by the map to answer "what does the satellite think this is".
app.get('/api/cover/at', wrap(async (req, res) => {
  const lat = +req.query.lat;
  const lon = +req.query.lon;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return res.status(400).json({ error: 'lat and lon required' });
  const map = loadMap();
  const manual = manualCoverAt(lat, lon, map);
  const nlcd = describe(await sampleNlcd(lat, lon));
  res.json({ manual, nlcd, effective: manual ?? nlcd });
}));

// --- sit log ----------------------------------------------------------------

app.get('/api/sits', wrap((req, res) => {
  const rows = getDb().prepare(`
    SELECT s.*, sn.factors_json, sn.raw_json, sn.buck_score, sn.general_score, sn.source AS snapshot_source
      FROM sits s LEFT JOIN sit_snapshots sn ON sn.sit_id = s.id
     ORDER BY s.date DESC, s.slot DESC
  `).all();
  res.json(rows.map((r) => ({
    ...r,
    saw_deer: !!r.saw_deer,
    factors: r.factors_json ? JSON.parse(r.factors_json) : null,
    raw: r.raw_json ? JSON.parse(r.raw_json) : null,
  })));
}));

// Logging a sit is four fields. Everything else is attached from the tool's own weather
// and score history, which is the only way the snapshot stays trustworthy enough to
// reweight against months later.
app.post('/api/sits', wrap((req, res) => {
  const db = getDb();
  const cfg = loadConfig();
  const map = loadMap();
  const b = req.body;
  if (!b.date || !b.slot) return res.status(400).json({ error: 'date and slot are required' });

  const stand = b.stand_id ? map.points.find((p) => p.id === b.stand_id) : null;
  const season = cfg.season.label;

  const info = db.prepare(`
    INSERT INTO sits (date, slot, stand_id, stand_label, saw_deer, deer_count, buck_count, notes, season, created_at)
    VALUES (@date,@slot,@stand_id,@stand_label,@saw_deer,@deer_count,@buck_count,@notes,@season,@created_at)
    ON CONFLICT(date, slot, stand_id) DO UPDATE SET
      saw_deer=excluded.saw_deer, deer_count=excluded.deer_count,
      buck_count=excluded.buck_count, notes=excluded.notes
  `).run({
    date: b.date, slot: b.slot,
    stand_id: b.stand_id ?? null,
    stand_label: stand?.label ?? b.stand_label ?? null,
    saw_deer: b.saw_deer ? 1 : 0,
    deer_count: +(b.deer_count ?? 0),
    buck_count: +(b.buck_count ?? 0),
    notes: b.notes ?? null,
    season,
    created_at: nowIso(),
  });

  const sitId = info.lastInsertRowid || db.prepare('SELECT id FROM sits WHERE date=? AND slot=? AND (stand_id IS ? OR stand_id = ?)').get(b.date, b.slot, b.stand_id ?? null, b.stand_id ?? null)?.id;

  // Attach the conditions snapshot from stored history.
  const score = db.prepare('SELECT * FROM scores WHERE date=? AND slot=?').get(b.date, b.slot);
  const wx = db.prepare('SELECT * FROM weather WHERE date=? AND slot=?').get(b.date, b.slot);
  if (sitId && score) {
    const factors = JSON.parse(score.factors_json || '{}');
    const effects = {};
    for (const [k, v] of Object.entries(factors.buck ?? {})) effects[k] = v.effect;
    const astro = sunMoonFor(b.date, cfg.property.lat, cfg.property.lon, cfg.property.timezone);
    db.prepare(`
      INSERT INTO sit_snapshots (sit_id, factors_json, raw_json, buck_score, general_score, source, created_at)
      VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(sit_id) DO UPDATE SET
        factors_json=excluded.factors_json, raw_json=excluded.raw_json,
        buck_score=excluded.buck_score, general_score=excluded.general_score, source=excluded.source
    `).run(
      sitId,
      JSON.stringify(effects),
      JSON.stringify({
        rutOffset: score.rut_offset, rutPhase: score.rut_phase,
        tempF: wx?.temp_f, tempNormalF: wx?.temp_normal_f,
        departureF: wx?.temp_f != null && wx?.temp_normal_f != null ? +(wx.temp_f - wx.temp_normal_f).toFixed(1) : null,
        windMph: wx?.wind_mph, windDirDeg: wx?.wind_dir_deg,
        precipProb: wx?.precip_prob, precipMm: wx?.precip_mm,
        skyCover: wx?.sky_cover,
        tempChange24h: wx?.temp_change_24h, pressureHpa: wx?.pressure_hpa,
        pressureChange24h: wx?.pressure_change_24h,
        gustMph: wx?.gust_mph, windSteadiness: wx?.wind_steadiness,
        windConfidence: wx?.wind_confidence, windConfidenceLabel: wx?.wind_confidence_label,
        moonIllumination: astro.moon.illumination, moonPhase: astro.moon.phaseName,
        weatherSource: wx?.source,
      }),
      score.buck_score, score.general_score, wx?.source ?? 'unknown', nowIso(),
    );
  }

  res.json({ id: sitId, snapshotAttached: !!score, note: score ? null : 'No stored score for that date/slot, so no conditions snapshot was attached. This sit still counts, but it will be skipped by the reweighting pass.' });
}));

app.delete('/api/sits/:id', wrap((req, res) => {
  const db = getDb();
  db.prepare('DELETE FROM sit_snapshots WHERE sit_id = ?').run(req.params.id);
  const r = db.prepare('DELETE FROM sits WHERE id = ?').run(req.params.id);
  res.json({ deleted: r.changes });
}));

// --- availability -----------------------------------------------------------

app.get('/api/availability', wrap((req, res) => {
  res.json(getDb().prepare('SELECT * FROM availability ORDER BY date').all());
}));

app.post('/api/availability', wrap((req, res) => {
  const { date, am, pm, note } = req.body;
  if (!date) return res.status(400).json({ error: 'date required' });
  getDb().prepare(`
    INSERT INTO availability (date, am, pm, note, updated_at) VALUES (?,?,?,?,?)
    ON CONFLICT(date) DO UPDATE SET am=excluded.am, pm=excluded.pm, note=excluded.note, updated_at=excluded.updated_at
  `).run(date, am ? 1 : 0, pm ? 1 : 0, note ?? null, nowIso());
  res.json({ ok: true });
}));

// Bulk weekend marking, both directions. Marking every weekend is the common opening
// move and tedious by hand; so is undoing it, which the first version had no way to do
// short of clicking 40 buttons.
app.post('/api/availability/weekends', wrap((req, res) => {
  const cfg = loadConfig();
  const db = getDb();
  const clear = req.body?.clear === true;

  const set = db.prepare(`
    INSERT INTO availability (date, am, pm, note, updated_at) VALUES (?,1,1,'weekend',?)
    ON CONFLICT(date) DO UPDATE SET am=1, pm=1, updated_at=excluded.updated_at
  `);
  // Clearing removes the row outright rather than writing zeros, so a cleared day is
  // indistinguishable from one never touched.
  const unset = db.prepare('DELETE FROM availability WHERE date = ?');

  let n = 0;
  const tx = db.transaction(() => {
    for (const d of dateRange(cfg.season.start, cfg.season.end)) {
      const wd = weekday(d);
      if (wd !== 'Sat' && wd !== 'Sun') continue;
      if (clear) unset.run(d); else set.run(d, nowIso());
      n++;
    }
  });
  tx();
  res.json({ [clear ? 'cleared' : 'marked']: n, clear });
}));

// Clear every availability mark in the season.
app.delete('/api/availability', wrap((req, res) => {
  const cfg = loadConfig();
  const r = getDb().prepare('DELETE FROM availability WHERE date >= ? AND date <= ?')
    .run(cfg.season.start, cfg.season.end);
  res.json({ cleared: r.changes });
}));

// --- weights and calibration ------------------------------------------------

app.get('/api/weights', wrap((req, res) => {
  const scoring = loadScoring();
  const cfg = loadConfig();
  res.json({
    peakRutDate: scoring.peakRutDate,
    methodology: scoring._methodology,
    droughtBoost: scoring.droughtBoost,
    drought: cfg.drought,
    reweighting: scoring.reweighting,
    calibration: scoring.calibration,
    calibrationDiagnostics: scoring._calibrationDiagnostics ?? null,
    factors: Object.fromEntries(Object.entries(scoring.factors).map(([k, f]) => [k, {
      label: f.label, research: f.research, confidence: f.confidence, note: f.note,
      droughtScaled: !!f.droughtScaled, frozen: !!f.frozen, reweightCandidate: !!f.reweightCandidate,
      buck: f.buck, general: f.general,
      effectiveBuck: +(f.buck.current * (f.droughtScaled ? 1 + scoring.droughtBoost * (cfg.drought?.severity ?? 0) : 1)).toFixed(3),
      effectiveGeneral: +(f.general.current * (f.droughtScaled ? 1 + scoring.droughtBoost * (cfg.drought?.severity ?? 0) : 1)).toFixed(3),
    }])),
    history: adjustmentHistory(100),
  });
}));

app.post('/api/weights/reweight', wrap((req, res) => {
  res.json(runReweight({ dryRun: req.body?.apply !== true, season: req.body?.season ?? null }));
}));

app.post('/api/weights/reset', wrap((req, res) => res.json(resetToPriors())));

app.post('/api/weights/peak-rut', wrap((req, res) => {
  const { date } = req.body;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
  const scoring = loadScoring();
  scoring.peakRutDate = date;
  saveScoring(scoring);
  res.json({ peakRutDate: date, note: 'Run a refresh to rescore the season against the new peak date.' });
}));

app.post('/api/drought', wrap((req, res) => {
  const { severity, note } = req.body;
  if (severity == null || severity < 0 || severity > 1) return res.status(400).json({ error: 'severity must be between 0 and 1' });
  const cfg = loadConfig();
  cfg.drought.severity = +severity;
  cfg.drought.asOf = todayLocal(cfg.property.timezone);
  if (note != null) cfg.drought.note = note;
  saveConfig(cfg);
  res.json({ drought: cfg.drought, note: 'Food and water weights rescale immediately. Recalibrate and refresh to update the season.' });
}));

app.post('/api/calibrate', wrap((req, res) => {
  const cfg = loadConfig();
  const scoring = loadScoring();
  const map = loadMap();
  const cal = calibrate({ cfg, scoring, map });
  if (req.body?.apply !== false) {
    scoring.calibration = { buck: cal.buck, general: cal.general };
    scoring._calibrationDiagnostics = cal.diagnostics;
    saveScoring(scoring);
  }
  res.json({ ...cal, distribution: distribution({ cfg, scoring, map }) });
}));

// --- jobs -------------------------------------------------------------------

app.post('/api/refresh', wrap(async (req, res) => {
  const lines = [];
  const r = await refresh({ log: (m) => { lines.push(m); console.log(`[refresh] ${m}`); } });
  res.json({ ...r, log: lines });
}));

app.post('/api/alerts/check', wrap(async (req, res) => {
  const lines = [];
  const r = await checkAlerts({ log: (m) => { lines.push(m); console.log(`[alerts] ${m}`); }, force: req.body?.force === true });
  res.json({ ...r, log: lines });
}));

app.post('/api/alerts/test', wrap(async (req, res) => res.json(await testWebhook(loadConfig()))));

app.post('/api/alerts/config', wrap((req, res) => {
  const cfg = loadConfig();
  cfg.alerts = { ...cfg.alerts, ...req.body };
  saveConfig(cfg);
  res.json(cfg.alerts);
}));

// --- scheduler --------------------------------------------------------------

function startScheduler(cfg) {
  if (!cfg.schedule?.enabled) { console.log('Scheduler disabled in config.'); return; }
  const tz = cfg.property.timezone;

  cron.schedule(cfg.schedule.refreshCron, async () => {
    console.log('[cron] refresh starting');
    try { await refresh({ log: (m) => console.log(`[refresh] ${m}`) }); }
    catch (err) { console.error('[cron] refresh failed:', err.message); }
  }, { timezone: tz });

  cron.schedule(cfg.schedule.alertCron, async () => {
    console.log('[cron] alert check starting');
    try { await checkAlerts({ log: (m) => console.log(`[alerts] ${m}`) }); }
    catch (err) { console.error('[cron] alert check failed:', err.message); }
  }, { timezone: tz });

  console.log(`Scheduler armed (${tz}): refresh ${cfg.schedule.refreshCron}, alerts ${cfg.schedule.alertCron}`);
}

const cfg = loadConfig();
getDb();
app.listen(cfg.server.port, cfg.server.host, () => {
  console.log(`DeerHunter listening on http://${cfg.server.host}:${cfg.server.port}`);
  console.log(`Property: ${cfg.property.name} (${cfg.property.county}) at ${cfg.property.lat}, ${cfg.property.lon}`);
  console.log(`Season: ${cfg.season.start} to ${cfg.season.end}, peak rut ${loadScoring().peakRutDate}`);
  startScheduler(cfg);
});
