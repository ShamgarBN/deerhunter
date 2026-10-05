// National Weather Service client (api.weather.gov). Free, keyless, US-only, which is
// all this needs. NWS asks for a descriptive User-Agent with contact info; that lives
// in config.nws.userAgent.
//
// Horizon, measured against one mid-Atlantic grid point in September 2026. Expect the
// same shape elsewhere; the exact day counts vary by office and season:
//   temperature / windSpeed / windDirection / skyCover  ~8 days
//   probabilityOfPrecipitation                          ~7 days
//   quantitativePrecipitation                           ~4 days
//   pressure                                            ~3 days, and unitless in the payload
// So anything past ~7 days is thin, and past ~8 days there is nothing. That is why
// scoring falls back to climate normals with a 'climatology' confidence label rather
// than pretending to forecast New Year's Day in November.

import { loadNormals } from './config.js';
import { monthDay } from './timeutil.js';

const BASE = 'https://api.weather.gov';

let lastRequest = 0;

async function get(url, cfg) {
  const gap = cfg.nws.minRequestIntervalMs - (Date.now() - lastRequest);
  if (gap > 0) await new Promise((r) => setTimeout(r, gap));

  let lastErr;
  for (let attempt = 0; attempt <= cfg.nws.maxRetries; attempt++) {
    try {
      lastRequest = Date.now();
      const res = await fetch(url, {
        headers: { 'User-Agent': cfg.nws.userAgent, Accept: 'application/geo+json' },
        signal: AbortSignal.timeout(30000),
      });
      if (res.status === 429 || res.status === 503 || res.status >= 500) {
        throw new Error(`NWS ${res.status} on ${url}`);
      }
      if (!res.ok) throw new Error(`NWS ${res.status} ${await res.text().catch(() => '')} on ${url}`);
      return await res.json();
    } catch (err) {
      lastErr = err;
      if (attempt < cfg.nws.maxRetries) {
        await new Promise((r) => setTimeout(r, cfg.nws.backoffBaseMs * 2 ** attempt));
      }
    }
  }
  throw lastErr;
}

// Resolve lat/lon to a forecast grid. Cached by `npm run setup` so this runs once, not
// daily; NWS explicitly asks callers not to re-resolve points every request.
export async function resolveGrid(cfg) {
  const { lat, lon } = cfg.property;
  const j = await get(`${BASE}/points/${lat.toFixed(4)},${lon.toFixed(4)}`, cfg);
  const p = j.properties;
  return {
    gridId: p.gridId,
    gridX: p.gridX,
    gridY: p.gridY,
    county: p.county,
    timeZone: p.timeZone,
    city: p.relativeLocation?.properties?.city,
    state: p.relativeLocation?.properties?.state,
  };
}

export async function nearestStations(cfg) {
  const { gridId, gridX, gridY } = cfg.nws;
  const j = await get(`${BASE}/gridpoints/${gridId}/${gridX},${gridY}/stations`, cfg);
  return j.features.map((f) => ({
    id: f.properties.stationIdentifier,
    name: f.properties.name,
    lat: f.geometry.coordinates[1],
    lon: f.geometry.coordinates[0],
  }));
}

// --- unit helpers -----------------------------------------------------------
const cToF = (c) => (c == null ? null : (c * 9) / 5 + 32);
const kmhToMph = (k) => (k == null ? null : k * 0.621371);

// NWS gridpoint values are ISO 8601 intervals: "2026-11-14T06:00:00+00:00/PT3H".
// Expand each into the hours it covers so an arbitrary instant can be looked up.
function expandSeries(layer, convert = (v) => v) {
  const out = [];
  if (!layer?.values) return out;
  for (const v of layer.values) {
    const [startStr, durStr] = v.validTime.split('/');
    const start = Date.parse(startStr);
    const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?$/.exec(durStr || 'PT1H');
    const hours = m ? (+(m[1] || 0) * 24) + (+(m[2] || 0)) + (m[3] ? +m[3] / 60 : 0) : 1;
    out.push({ start, end: start + hours * 3600000, value: convert(v.value) });
  }
  return out;
}

const sampleAt = (series, t) => series.find((s) => t >= s.start && t < s.end)?.value ?? null;

export async function fetchGridForecast(cfg) {
  const { gridId, gridX, gridY } = cfg.nws;
  const j = await get(`${BASE}/gridpoints/${gridId}/${gridX},${gridY}`, cfg);
  const p = j.properties;
  return {
    updateTime: p.updateTime,
    temp: expandSeries(p.temperature, cToF),
    windSpeed: expandSeries(p.windSpeed, kmhToMph),
    windDir: expandSeries(p.windDirection),
    precipProb: expandSeries(p.probabilityOfPrecipitation),
    precipAmt: expandSeries(p.quantitativePrecipitation),
    skyCover: expandSeries(p.skyCover),
    humidity: expandSeries(p.relativeHumidity),
    pressure: expandSeries(p.pressure),
  };
}

// Pull the value of every variable at one instant (the center of an AM or PM slot).
export function sampleForecast(grid, when) {
  const t = when instanceof Date ? when.getTime() : Date.parse(when);
  const temp = sampleAt(grid.temp, t);
  if (temp == null) return null; // outside the forecast horizon entirely
  return {
    source: 'forecast',
    tempF: temp,
    windMph: sampleAt(grid.windSpeed, t),
    windDirDeg: sampleAt(grid.windDir, t),
    precipProb: sampleAt(grid.precipProb, t),
    precipMm: sampleAt(grid.precipAmt, t),
    skyCover: sampleAt(grid.skyCover, t),
    humidity: sampleAt(grid.humidity, t),
    pressurePa: sampleAt(grid.pressure, t),
  };
}

// Actual observations for a past day. These overwrite the stored forecast so that sit
// snapshots settle on what really happened, not what was predicted three days earlier.
export async function fetchObservations(cfg, startIso, endIso) {
  const station = cfg.nws.observationStation;
  const url = `${BASE}/stations/${station}/observations?start=${encodeURIComponent(startIso)}&end=${encodeURIComponent(endIso)}&limit=500`;
  const j = await get(url, cfg);
  return j.features
    .map((f) => {
      const p = f.properties;
      const cloud = p.cloudLayers?.length
        ? Math.max(...p.cloudLayers.map((c) => ({ CLR: 0, SKC: 0, FEW: 15, SCT: 40, BKN: 75, OVC: 100, VV: 100 }[c.amount] ?? 0)))
        : null;
      return {
        t: Date.parse(p.timestamp),
        tempF: cToF(p.temperature?.value),
        windMph: kmhToMph(p.windSpeed?.value),
        windDirDeg: p.windDirection?.value,
        precipMm: p.precipitationLastHour?.value,
        skyCover: cloud,
        humidity: p.relativeHumidity?.value,
        pressurePa: p.barometricPressure?.value ?? p.seaLevelPressure?.value,
      };
    })
    .filter((o) => o.tempF != null)
    .sort((a, b) => a.t - b.t);
}

// Nearest observation to a slot center, within a tolerance. Returns null rather than
// reaching for something two hours away, which would quietly poison a snapshot.
export function nearestObservation(obs, when, toleranceMinutes = 75) {
  const t = when instanceof Date ? when.getTime() : Date.parse(when);
  let best = null;
  let bestDist = Infinity;
  for (const o of obs) {
    const d = Math.abs(o.t - t);
    if (d < bestDist) { bestDist = d; best = o; }
  }
  if (!best || bestDist > toleranceMinutes * 60000) return null;
  return { ...best, source: 'observation' };
}

// --- climatology ------------------------------------------------------------
// Real NOAA 1991-2020 daily normals for KRDU, cached in data/normals-rdu.json.
// Used for two things: the temperature-departure factor on every day, and as the
// entire weather input for days past the forecast horizon.

let normalsCache;

export function normalFor(dateStr) {
  if (normalsCache === undefined) normalsCache = loadNormals();
  const n = normalsCache?.normals?.[monthDay(dateStr)];
  if (!n) return null;
  return { tmaxF: n.tmaxF, tminF: n.tminF, meanF: +((n.tmaxF + n.tminF) / 2).toFixed(1) };
}

// Slot-level normal temperature. Dawn sits run near the daily low; the evening slot
// is well off the afternoon high but still in the warm half of the day.
export function climatologyFor(dateStr, slot) {
  const n = normalFor(dateStr);
  if (!n) return null;
  const tempF = slot === 'AM' ? n.tminF + 2 : n.tmaxF - 6;
  return {
    source: 'climatology',
    tempF: +tempF.toFixed(1),
    windMph: null,
    windDirDeg: null,
    precipProb: null,
    precipMm: null,
    skyCover: null,
    humidity: null,
    pressurePa: null,
  };
}
