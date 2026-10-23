// Express server: JSON API plus the static dashboard.
//
// No auth, by design. Single hunter, private tailnet, and the threat model for "someone
// on Ben's Tailscale learns where the bean field is" does not justify a login screen on
// a tool he opens one-handed from a tree at 6am.

import express from 'express';
import path from 'path';
import { pathToFileURL } from 'url';
import fs from 'fs';
import cron from 'node-cron';
import { ROOT, loadConfig, loadScoring, loadMap, saveMap, saveConfig, saveScoring } from './config.js';
import { getDb } from './db.js';
import { refresh, checkAlerts, lastHuntedByStand } from './jobs.js';
import { runReweight, resetToPriors, adjustmentHistory } from './reweight.js';
import { calibrate, distribution } from './calibrate.js';
import { sunMoonFor, minutesFromLightAnchor } from './astro.js';
import { rutFor, seasonHighlights } from './rut.js';
import { loadSeasons, seasonsOn, strictnessOn, normalizeSeason, WEAPON_PROFILES } from './seasons.js';
import { updateDrought, droughtHistory, countyFips } from './drought.js';
import { safeWindSectors, standVerdict, thermalNotes } from './wind.js';
import { ringCentroid, ringAcres, pathMidpoint, pathLengthYards, distanceToFeatureYards, destinationPoint, degToCompass } from './geo.js';
import { coverForStand, coverForPoints, manualCoverAt, describe, sampleNlcd, wmsInfo, NLCD_CLASSES } from './cover.js';
import { testWebhook } from './discord.js';
import { writeBackup, latestBackup, BACKUP_DIR } from './backup.js';
import { beddingGaps } from './bedding.js';
import { calibration, skill } from './skill.js';
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

// What a deer was doing when it appeared. A fixed list rather than free text so the
// annual review can group on it, served from /api/state so the form offering the options
// and the endpoint validating them cannot drift apart.
const BEHAVIORS = ['feeding', 'travelling', 'cruising', 'chasing', 'bedded', 'alert'];

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
    behaviors: BEHAVIORS,
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
    // height is recorded but deliberately unscored: see ANNUAL_REVIEW.md, "Raised with
    // Ben and declined". Stands within a couple of feet of each other give the variable
    // no spread to discriminate on. Do not wire it into scoring without asking first.
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
  const sightings = getDb().prepare('SELECT * FROM sightings ORDER BY minutes_from_anchor IS NULL, minutes_from_anchor, id').all();
  const bySit = new Map();
  for (const g of sightings) {
    if (!bySit.has(g.sit_id)) bySit.set(g.sit_id, []);
    bySit.get(g.sit_id).push(g);
  }
  res.json(rows.map((r) => ({
    ...r,
    saw_deer: !!r.saw_deer,
    factors: r.factors_json ? JSON.parse(r.factors_json) : null,
    raw: r.raw_json ? JSON.parse(r.raw_json) : null,
    sightings: bySit.get(r.id) ?? [],
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
  db.prepare('DELETE FROM sightings WHERE sit_id = ?').run(req.params.id);
  const r = db.prepare('DELETE FROM sits WHERE id = ?').run(req.params.id);
  res.json({ deleted: r.changes });
}));

// --- sightings --------------------------------------------------------------
//
// Detail inside a sit, all of it optional. Nothing here feeds scoring: it is recorded now
// so the annual review has something a deer count cannot give it, in the same way land
// cover is sampled and left unweighted until there is data to justify a weight.

app.post('/api/sits/:id/sightings', wrap((req, res) => {
  const db = getDb();
  const cfg = loadConfig();
  const sit = db.prepare('SELECT * FROM sits WHERE id = ?').get(req.params.id);
  if (!sit) return res.status(404).json({ error: 'no such sit' });

  const b = req.body ?? {};
  const deer = Math.max(1, Math.round(+(b.deer_count ?? 1) || 1));
  const bucks = Math.min(deer, Math.max(0, Math.round(+(b.buck_count ?? 0) || 0)));

  const bearing = b.bearing_deg == null || b.bearing_deg === '' ? null
    : ((+b.bearing_deg % 360) + 360) % 360;
  if (bearing != null && Number.isNaN(bearing)) return res.status(400).json({ error: 'bearing must be a number of degrees' });

  const dist = b.distance_yards == null || b.distance_yards === '' ? null
    : Math.max(0, Math.round(+b.distance_yards));
  if (dist != null && Number.isNaN(dist)) return res.status(400).json({ error: 'distance must be a number of yards' });

  const behavior = b.behavior && BEHAVIORS.includes(b.behavior) ? b.behavior : null;

  // Which way it was going, and how much of that walk was actually visible. These are
  // kept apart from bearing_deg on purpose: bearing_deg is where the animal was standing
  // when first seen, travel_deg is where it was headed, and the two are routinely
  // unrelated. The before/after pair is what the cover allowed, so it is a floor on the
  // distance travelled and never a claim about the whole route.
  const travel = b.travel_deg == null || b.travel_deg === '' ? null
    : ((+b.travel_deg % 360) + 360) % 360;
  const yards = (v) => (v == null || v === '' ? null : Math.max(0, Math.round(+v) || 0));
  const beforeYards = yards(b.seen_before_yards);
  const afterYards = yards(b.seen_after_yards);
  const travelYards = beforeYards == null && afterYards == null
    ? null : (beforeYards ?? 0) + (afterYards ?? 0);

  // A time that cannot be placed against the light anchor is kept anyway: the raw clock
  // reading is still worth having, it just cannot join the when-in-the-window analysis.
  const atTime = (b.at_time ?? '').trim() || null;
  const minutes = atTime
    ? minutesFromLightAnchor(sit.date, sit.slot, atTime, cfg.property.lat, cfg.property.lon, cfg.property.timezone)
    : null;

  const info = db.prepare(`
    INSERT INTO sightings (sit_id, at_time, minutes_from_anchor, deer_count, buck_count,
                           bearing_deg, distance_yards, travel_deg, travel_yards,
                           seen_before_yards, seen_after_yards, behavior, notes, created_at)
    VALUES (@sit_id,@at_time,@minutes,@deer,@bucks,@bearing,@dist,@travel,@travelYards,
            @beforeYards,@afterYards,@behavior,@notes,@created_at)
  `).run({
    sit_id: sit.id, at_time: atTime, minutes, deer, bucks,
    bearing, dist, travel, travelYards, beforeYards, afterYards, behavior,
    notes: (b.notes ?? '').trim() || null,
    created_at: nowIso(),
  });

  // The sit's own totals stay the headline number and are never silently overwritten,
  // but a detail row that pushes past them means the summary was low. Report it rather
  // than guessing which one Ben meant.
  const totals = db.prepare('SELECT SUM(deer_count) d, SUM(buck_count) b FROM sightings WHERE sit_id = ?').get(sit.id);
  res.json({
    id: info.lastInsertRowid,
    minutesFromAnchor: minutes,
    anchor: sit.slot === 'AM' ? 'sunrise' : 'sunset',
    timeUnplaced: !!atTime && minutes == null,
    detailTotals: { deer: totals.d ?? 0, bucks: totals.b ?? 0 },
    mappable: bearing != null && dist != null,
    exceedsSitTotal: (totals.d ?? 0) > sit.deer_count,
  });
}));

/**
 * Sightings as drawable geometry.
 *
 * The client gets coordinates, not polar pairs: the projection needs the stand's position
 * and the great-circle maths already live here, and duplicating either in the browser is
 * how the map and the model start disagreeing.
 *
 * The drawn segment covers ONLY what was actually watched. It runs from seen_before_yards
 * back along the reverse of the travel bearing to seen_after_yards forward along it,
 * through the point where the deer was first seen. Nothing is extrapolated: a deer watched
 * for 30 yards in thick cover draws a 30-yard line, not a guess at where it came from.
 */
app.get('/api/sightings/vectors', wrap((req, res) => {
  const map = loadMap();
  const stands = new Map(map.points.filter((p) => p.type === 'stand').map((p) => [p.id, p]));

  const rows = getDb().prepare(`
    SELECT g.*, s.date, s.slot, s.stand_id, s.stand_label
      FROM sightings g JOIN sits s ON s.id = g.sit_id
     ORDER BY s.date, s.slot, g.minutes_from_anchor IS NULL, g.minutes_from_anchor
  `).all();

  const out = [];
  for (const r of rows) {
    const stand = r.stand_id ? stands.get(r.stand_id) : null;
    // Without a stand there is no origin to measure from, and without a bearing and
    // distance there is no point to place. Those sightings are still real and still in
    // the log; they just cannot be drawn, and the count is reported so the map can say so.
    if (!stand || r.bearing_deg == null || r.distance_yards == null) continue;
    const origin = { lat: stand.lat, lon: stand.lon };
    const seen = destinationPoint(origin, r.bearing_deg, r.distance_yards);
    if (!seen) continue;

    const hasTravel = r.travel_deg != null && ((r.seen_before_yards ?? 0) + (r.seen_after_yards ?? 0)) > 0;
    out.push({
      id: r.id,
      date: r.date, slot: r.slot,
      standId: r.stand_id, standLabel: r.stand_label,
      standAt: origin,
      seenAt: seen,
      bearingDeg: r.bearing_deg, bearingCompass: degToCompass(r.bearing_deg),
      distanceYards: r.distance_yards,
      travelDeg: r.travel_deg, travelCompass: r.travel_deg == null ? null : degToCompass(r.travel_deg),
      from: hasTravel ? destinationPoint(seen, (r.travel_deg + 180) % 360, r.seen_before_yards ?? 0) : null,
      to: hasTravel ? destinationPoint(seen, r.travel_deg, r.seen_after_yards ?? 0) : null,
      watchedYards: hasTravel ? (r.seen_before_yards ?? 0) + (r.seen_after_yards ?? 0) : null,
      deerCount: r.deer_count, buckCount: r.buck_count,
      behavior: r.behavior, atTime: r.at_time, minutesFromAnchor: r.minutes_from_anchor,
      notes: r.notes,
    });
  }

  const total = rows.length;
  res.json({
    vectors: out,
    total,
    unmappable: total - out.length,
    note: 'A sighting needs a stand, a bearing and a distance to be placed. Ones without are still in the sit log.',
  });
}));

app.delete('/api/sightings/:id', wrap((req, res) => {
  const r = getDb().prepare('DELETE FROM sightings WHERE id = ?').run(req.params.id);
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

// Manual override. Setting a value by hand switches the mode to manual, because silently
// letting the next refresh overwrite a deliberate judgement would be worse than either
// behaviour on its own.
app.post('/api/drought', wrap((req, res) => {
  const { severity, note, mode } = req.body;
  const cfg = loadConfig();

  if (mode === 'auto') {
    cfg.drought = { ...cfg.drought, mode: 'auto' };
    saveConfig(cfg);
    return res.json({ drought: loadConfig().drought, note: 'Switched to automatic. Refresh to pull the current US Drought Monitor reading.' });
  }

  if (severity == null || severity < 0 || severity > 1) return res.status(400).json({ error: 'severity must be between 0 and 1' });
  cfg.drought = {
    ...cfg.drought,
    mode: 'manual',
    severity: +severity,
    asOf: todayLocal(cfg.property.timezone),
    source: 'manual',
    note: note ?? 'Set by hand.',
  };
  saveConfig(cfg);
  res.json({ drought: loadConfig().drought, note: 'Pinned to manual. USDM is still checked each refresh and logged, but will not overwrite this.' });
}));

// --- grading the model against what actually happened ----------------------

/**
 * Both halves of the self-assessment in one call, for both targets.
 *
 * Buck and deer-activity are scored separately by the model, so they are graded
 * separately: a tool that is good at one and useless at the other would otherwise average
 * out to looking mediocre at both and tell you nothing about which to fix.
 */
app.get('/api/skill', wrap((req, res) => {
  res.json({
    general: { calibration: calibration({ target: 'general' }), skill: skill({ target: 'general' }) },
    buck: { calibration: calibration({ target: 'buck' }), skill: skill({ target: 'buck' }) },
    note: 'Fitted and graded leave-one-out, so nothing is scored on data it was fitted to. Early-season numbers are dominated by sample size, not by the model.',
  });
}));

app.get('/api/bedding/gaps', wrap((req, res) => {
  const tolerance = req.query.tolerance ? +req.query.tolerance : undefined;
  const min = req.query.min ? +req.query.min : undefined;
  res.json(beddingGaps({
    toleranceDeg: Number.isFinite(tolerance) ? tolerance : undefined,
    minSightings: Number.isFinite(min) ? min : undefined,
  }));
}));

// --- backups ---------------------------------------------------------------

app.get('/api/backup', wrap((req, res) => {
  res.json({ latest: latestBackup(), dir: BACKUP_DIR });
}));

app.post('/api/backup', wrap((req, res) => {
  const cfg = loadConfig();
  const r = writeBackup({ keep: cfg.backup?.keep ?? 30 });
  res.json({ name: path.basename(r.jsonPath), counts: r.counts, pruned: r.pruned });
}));

// Download the most recent backup. Served as an attachment so a browser saves it instead
// of rendering 2 MB of JSON, and resolved against BACKUP_DIR rather than anything the
// caller supplies, so there is no path for a request to name a file outside it.
app.get('/api/backup/download', wrap((req, res) => {
  const latest = latestBackup();
  if (!latest) return res.status(404).json({ error: 'no backup has been written yet' });
  res.download(latest.path, latest.name);
}));

app.get('/api/drought', wrap((req, res) => {
  const cfg = loadConfig();
  res.json({ drought: cfg.drought, countyFips: countyFips(cfg), history: droughtHistory(20) });
}));

// Force a check now rather than waiting for the nightly refresh.
app.post('/api/drought/check', wrap(async (req, res) => {
  const lines = [];
  const r = await updateDrought({ log: (m) => { lines.push(m); console.log(`[drought] ${m}`); }, force: req.body?.force === true });
  res.json({ ...r, log: lines, drought: loadConfig().drought });
}));

app.post('/api/calibrate', wrap((req, res) => {
  const cfg = loadConfig();
  const scoring = loadScoring();
  const map = loadMap();
  const cal = calibrate({ cfg, scoring, map });
  if (req.body?.apply !== false) {
    scoring.calibration = { buck: cal.buck, general: cal.general };
    if (cal.proximity) scoring.proximityCurves = cal.proximity;
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
  const next = { ...cfg.alerts, ...req.body };
  for (const k of ['buckThreshold', 'generalThreshold']) {
    if (next[k] != null) next[k] = Math.max(0, Math.min(10, +next[k]));
  }
  // Nested object, so a shallow spread would drop the _comment and _daysNote that explain
  // what the setting is for. Merge it, and keep the window somewhere sane.
  if (req.body?.heartbeat) {
    next.heartbeat = { ...cfg.alerts?.heartbeat, ...req.body.heartbeat };
    if (next.heartbeat.days != null) next.heartbeat.days = Math.max(1, Math.min(90, Math.round(+next.heartbeat.days) || 7));
  }
  delete next.scoreThreshold; // superseded by the per-score pair
  cfg.alerts = next;
  saveConfig(cfg);
  res.json(loadConfig().alerts);
}));

/**
 * What each threshold would actually catch, against the scores already stored.
 *
 * A threshold is meaningless without knowing how often it fires. This reports the hit
 * rate for the current settings and the value at each percentile, so a cut-off can be
 * chosen from the real distribution rather than guessed and regretted in November.
 */
app.get('/api/alerts/preview', wrap((req, res) => {
  const cfg = loadConfig();
  const db = getDb();
  const lastPost = db.prepare('SELECT kind, sent_at FROM webhook_log ORDER BY sent_at DESC LIMIT 1').get() ?? null;
  const rows = db.prepare('SELECT buck_score b, general_score g, confidence FROM scores').all();
  // Two scopes, because they answer different questions and conflating them misleads.
  //
  // The whole season is what a threshold should be CHOSEN against: it is the distribution
  // you will actually live with. The forecast window is what the alert would fire on
  // RIGHT NOW, which in late October is a fortnight of pre-rut and says almost nothing
  // about how often you will be pinged in the second week of November.
  const forecastOnly = rows.filter((r) => r.confidence !== 'climatology');

  const pct = (arr, p) => {
    if (!arr.length) return null;
    const s = [...arr].sort((x, y) => x - y);
    return +s[Math.min(s.length - 1, Math.floor(s.length * p))].toFixed(2);
  };
  const stat = (vals, threshold) => ({
    n: vals.length,
    over: vals.filter((v) => v >= threshold).length,
    share: vals.length ? +(vals.filter((v) => v >= threshold).length / vals.length).toFixed(3) : 0,
    percentiles: Object.fromEntries([0.75, 0.85, 0.9, 0.95].map((p) => [`p${Math.round(p * 100)}`, pct(vals, p)])),
  });

  const bt = cfg.alerts.buckThreshold ?? cfg.alerts.scoreThreshold ?? 8.5;
  const gt = cfg.alerts.generalThreshold ?? cfg.alerts.scoreThreshold ?? 7.5;
  res.json({
    alerts: cfg.alerts,
    season: {
      buck: { threshold: bt, ...stat(rows.map((r) => r.b), bt) },
      general: { threshold: gt, ...stat(rows.map((r) => r.g), gt) },
    },
    forecastWindow: {
      buck: { threshold: bt, ...stat(forecastOnly.map((r) => r.b), bt) },
      general: { threshold: gt, ...stat(forecastOnly.map((r) => r.g), gt) },
    },
    lastPost: lastPost && {
      kind: lastPost.kind,
      sentAt: lastPost.sent_at,
      daysAgo: +((Date.now() - Date.parse(lastPost.sent_at)) / 86400000).toFixed(1),
    },
    note: 'Choose a threshold against the whole season: that is the distribution you live with. The forecast-window figure is only what would fire today, and early in the season that is a fortnight of pre-rut.',
  });
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

  // Backups run on their own schedule rather than after a refresh: a refresh that throws
  // is exactly when you most want yesterday's copy to have been taken already.
  if (cfg.schedule.backupCron) {
    cron.schedule(cfg.schedule.backupCron, () => {
      try { writeBackup({ keep: cfg.backup?.keep ?? 30, log: (m) => console.log(`[backup] ${m}`) }); }
      catch (err) { console.error('[cron] backup failed:', err.message); }
    }, { timezone: tz });
  }

  console.log(`Scheduler armed (${tz}): refresh ${cfg.schedule.refreshCron}, alerts ${cfg.schedule.alertCron}`
    + (cfg.schedule.backupCron ? `, backup ${cfg.schedule.backupCron}` : ''));
}

/**
 * Start listening and arm the scheduler.
 *
 * Exported rather than run on import so the desktop build can await a real port before
 * pointing a window at it. Port 0 asks the OS for a free one, which the packaged app uses:
 * a fixed port would collide with a copy already running from the checkout.
 */
export function start({ port, host } = {}) {
  const cfg = loadConfig();
  getDb();
  return new Promise((resolve, reject) => {
    const srv = app.listen(port ?? cfg.server.port, host ?? cfg.server.host, () => {
      const actual = srv.address().port;
      console.log(`DeerHunter listening on http://${host ?? cfg.server.host}:${actual}`);
      console.log(`Property: ${cfg.property.name} (${cfg.property.county}) at ${cfg.property.lat}, ${cfg.property.lon}`);
      console.log(`Season: ${cfg.season.start} to ${cfg.season.end}, peak rut ${loadScoring().peakRutDate}`);
      startScheduler(cfg);
      resolve({ server: srv, port: actual, cfg });
    });
    srv.on('error', reject);
  });
}

// Run directly (npm start, the launchd agent, the CLI) and it still starts itself, so
// nothing outside the desktop build had to change.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  start().catch((err) => {
    console.error('Failed to start:', err.message);
    process.exit(1);
  });
}
