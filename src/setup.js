// First-run setup: point the tool at a property.
//
// Everything location-specific is derived from one pair of coordinates. Nothing in the
// scoring model is tied to North Carolina except the season dates and the rut peak, and
// both of those are plain config values.
//
// What this resolves:
//   NWS forecast grid        from /points/{lat},{lon}
//   nearest observation stn  from the grid's station list
//   county                   from the FCC census-block lookup, which matters because
//                            season dates and zones are set by county nearly everywhere
//   climate normals          30-year daily means, used by the temperature-departure factor
//
// Results are written to config/config.local.json, which is gitignored and deep-merged
// over the tracked config.json. That keeps a shared checkout generic while each person's
// actual property stays on their own machine.

import fs from 'fs';
import path from 'path';
import { CONFIG_DIR, DATA_DIR, loadConfig } from './config.js';
import { resolveGrid, nearestStations } from './nws.js';

const ARCHIVE = 'https://archive-api.open-meteo.com/v1/archive';

/**
 * County from coordinates, which matters because season dates and zones are drawn by
 * county nearly everywhere.
 *
 * Two sources, tried in order. The Census Bureau's own geocoder is authoritative and is
 * tried first. The FCC block API is the fallback; it was the original choice and was
 * observed returning HTTP 400 with a backend Postgres authentication error during this
 * build, which is a reminder that a single free endpoint is a single point of failure.
 * Both failing is non-fatal: setup says so and you set the county by hand.
 */
export async function lookupCounty(lat, lon) {
  try {
    const url = `https://geocoding.geo.census.gov/geocoder/geographies/coordinates`
      + `?x=${lon}&y=${lat}&benchmark=Public_AR_Current&vintage=Current_Current&layers=Counties&format=json`;
    const res = await fetch(url, { signal: AbortSignal.timeout(25000) });
    if (res.ok) {
      const j = await res.json();
      const geos = j?.result?.geographies ?? {};
      const key = Object.keys(geos).find((k) => /count/i.test(k));
      const c = key ? geos[key]?.[0] : null;
      if (c?.NAME) return { name: c.NAME, fips: `${c.STATE ?? ''}${c.COUNTY ?? ''}`, state: c.STATE ?? null, source: 'census' };
    }
  } catch { /* fall through */ }

  try {
    const res = await fetch(`https://geo.fcc.gov/api/census/block/find?latitude=${lat}&longitude=${lon}&format=json`, { signal: AbortSignal.timeout(20000) });
    if (!res.ok) return null;
    const j = await res.json();
    return j?.County?.name ? { name: j.County.name, fips: j.County.FIPS, state: j.State?.code, source: 'fcc' } : null;
  } catch { return null; }
}

/**
 * Climate normals from 30 years of Open-Meteo reanalysis.
 *
 * Works for any coordinates on earth, needs no station lookup, and comes from the same
 * model family as the forecast, so the two share their biases and the DEPARTURE between
 * them stays meaningful.
 *
 * It is not the same thing as NOAA station normals. Compared against NOAA's KRDU record,
 * reanalysis ran roughly 1-6F cooler on daily maxima and 1-6F warmer on minima: gridded
 * models smooth the diurnal range that a thermometer in a field actually sees. US users
 * who would rather have station normals can run `npm run normals -- --station <GHCN id>`.
 */
export async function computeNormals(lat, lon, { from = 1991, to = 2020 } = {}) {
  const qs = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lon),
    start_date: `${from}-01-01`,
    end_date: `${to}-12-31`,
    daily: 'temperature_2m_max,temperature_2m_min',
    temperature_unit: 'fahrenheit',
    timezone: 'auto',
  });
  const res = await fetch(`${ARCHIVE}?${qs}`, { signal: AbortSignal.timeout(120000) });
  if (!res.ok) throw new Error(`Open-Meteo archive ${res.status}`);
  const j = await res.json();
  if (j.error) throw new Error(j.reason ?? 'archive error');

  const acc = {};
  j.daily.time.forEach((day, i) => {
    const mx = j.daily.temperature_2m_max[i];
    const mn = j.daily.temperature_2m_min[i];
    if (mx == null || mn == null) return;
    const md = day.slice(5);
    (acc[md] ??= { mx: [], mn: [] });
    acc[md].mx.push(mx);
    acc[md].mn.push(mn);
  });

  const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const normals = {};
  for (const [md, v] of Object.entries(acc)) {
    if (!v.mx.length) continue;
    normals[md] = { tmaxF: +mean(v.mx).toFixed(1), tminF: +mean(v.mn).toFixed(1) };
  }

  return {
    _source: `Open-Meteo historical reanalysis, ${from}-${to} daily means at ${lat}, ${lon}`,
    _note: 'Computed, not NOAA station normals. Reanalysis smooths the diurnal range: against NOAA KRDU it ran about 1-6F cooler on maxima and 1-6F warmer on minima. It shares a model family with the forecast, so the departure between them stays consistent. For NOAA station normals in the US: npm run normals -- --station <GHCN id>',
    _fetched: new Date().toISOString().slice(0, 10),
    lat, lon, years: [from, to],
    normals,
  };
}

/**
 * Coordinates from a US zip code. Keyless.
 * A zip centroid is good to a few miles, which is close enough to pick the right NWS
 * grid and county but not to place a stand. Drop real pins on the Map tab afterwards.
 */
export async function lookupZip(zip) {
  try {
    const res = await fetch(`https://api.zippopotam.us/us/${encodeURIComponent(zip)}`, { signal: AbortSignal.timeout(20000) });
    if (!res.ok) return null;
    const j = await res.json();
    const p = j.places?.[0];
    if (!p) return null;
    return {
      lat: parseFloat(p.latitude),
      lon: parseFloat(p.longitude),
      label: `${p['place name']}, ${p['state abbreviation']} ${j['post code']}`,
      approximate: true,
    };
  } catch { return null; }
}

/** Coordinates from a place name. Keyless and global. */
export async function lookupPlace(name, country = 'US') {
  try {
    const qs = new URLSearchParams({ name, count: '5', ...(country ? { country } : {}) });
    const res = await fetch(`https://geocoding-api.open-meteo.com/v1/search?${qs}`, { signal: AbortSignal.timeout(20000) });
    if (!res.ok) return [];
    const j = await res.json();
    return (j.results ?? []).map((r) => ({
      lat: r.latitude, lon: r.longitude,
      label: [r.name, r.admin2, r.admin1, r.country_code].filter(Boolean).join(', '),
      approximate: true,
    }));
  } catch { return []; }
}

/** Resolve whatever the user gave us into coordinates. */
export async function resolveLocation({ lat, lon, zip, place }) {
  if (Number.isFinite(lat) && Number.isFinite(lon)) return { lat, lon, label: `${lat}, ${lon}`, approximate: false };
  if (zip) {
    const r = await lookupZip(zip);
    if (r) return r;
    throw new Error(`No match for zip ${zip}`);
  }
  if (place) {
    const hits = await lookupPlace(place);
    if (!hits.length) throw new Error(`No match for "${place}"`);
    return hits[0];
  }
  throw new Error('give --lat/--lon, --zip, or --place');
}

export async function runSetup({ lat, lon, name = 'My property', seasonStart, seasonEnd, peakRut, log = console.log } = {}) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    throw new Error('latitude and longitude are required');
  }

  const base = loadConfig();
  const cfg = { property: { ...base.property, name, lat, lon }, nws: { ...base.nws } };

  log(`Resolving ${lat}, ${lon}...`);

  const county = await lookupCounty(lat, lon);
  if (county) {
    cfg.property.county = [county.name, county.state].filter(Boolean).join(', ') + (county.fips ? ` (FIPS ${county.fips})` : '');
    // Stored separately because the drought lookup is keyed by it, and parsing it back
    // out of a display string is the kind of thing that breaks when someone edits the label.
    if (county.fips) cfg.property.countyFips = county.fips;
    log(`  County: ${cfg.property.county}`);
    log('  Check this against your state\'s season dates and zone map. Zones are set by county nearly everywhere.');
  } else {
    log('  County lookup failed; set property.county by hand.');
  }

  // NWS grid. US-only, and the tool degrades to Open-Meteo plus climatology without it.
  try {
    const probe = { ...base, property: { ...base.property, lat, lon } };
    const grid = await resolveGrid(probe);
    cfg.nws.gridId = grid.gridId;
    cfg.nws.gridX = grid.gridX;
    cfg.nws.gridY = grid.gridY;
    cfg.property.timezone = grid.timeZone ?? base.property.timezone;
    cfg.property.nearestTown = [grid.city, grid.state].filter(Boolean).join(', ');
    log(`  NWS grid: ${grid.gridId}/${grid.gridX},${grid.gridY} near ${cfg.property.nearestTown}`);

    const stations = await nearestStations({ ...probe, nws: cfg.nws });
    if (stations.length) {
      cfg.nws.observationStation = stations[0].id;
      log(`  Observation station: ${stations[0].id} (${stations[0].name})`);
    }
  } catch (err) {
    log(`  NWS lookup failed (${err.message}). Outside the US this is expected: wind, pressure and temperature still come from Open-Meteo.`);
    cfg.nws.gridId = null;
  }

  log('Computing 30-year climate normals (one archive request, give it a moment)...');
  const normals = await computeNormals(lat, lon);
  const normalsFile = 'normals.json';
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(path.join(DATA_DIR, normalsFile), `${JSON.stringify(normals, null, 1)}\n`);
  cfg.climate = { normalsFile };
  log(`  ${Object.keys(normals.normals).length} days written to data/${normalsFile}`);

  if (seasonStart || seasonEnd || peakRut) {
    cfg.season = { ...base.season };
    if (seasonStart) cfg.season.start = seasonStart;
    if (seasonEnd) cfg.season.end = seasonEnd;
    if (peakRut) cfg.scoringPeakRut = peakRut;
  }

  const localPath = path.join(CONFIG_DIR, 'config.local.json');
  const existing = fs.existsSync(localPath) ? JSON.parse(fs.readFileSync(localPath, 'utf8')) : {};
  const merged = {
    _comment: 'Your property, your secrets, your machine. Gitignored and deep-merged over config.json at load. Never commit this file.',
    ...existing,
    ...cfg,
    discord: { ...(existing.discord ?? {}) },
  };
  fs.writeFileSync(localPath, `${JSON.stringify(merged, null, 2)}\n`);
  log(`\nWrote config/config.local.json. It overrides config.json and stays out of git.`);

  return { config: merged, normalsDays: Object.keys(normals.normals).length, county };
}
