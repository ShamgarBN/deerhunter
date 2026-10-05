// Hourly weather, merged from two free sources.
//
// NWS alone could not support the model Ben asked for. Its gridpoint `pressure` series
// comes back with unit "None" and values near zero, so the barometric factor was dead in
// every forecast slot: measured at 0 of 168. It also publishes no wind-gust series, which
// is what tells you whether a wind direction is trustworthy.
//
// So:
//   NWS (api.weather.gov)      temperature, precipitation, sky cover - authoritative US
//                              forecast, and what the tool was specified around
//   Open-Meteo                 ALL WIND (speed, direction, gusts), PRESSURE, and coverage
//                              past the NWS horizon (16 days hourly vs about 8)
//
// Wind moved to Open-Meteo wholesale, which is a deliberate call. NWS publishes direction
// in multi-hour blocks: measured over 24 hours at this grid point it gave 5 distinct
// directions where Open-Meteo gave 17. Blocky direction makes the steadiness metric below
// read a constant 1.0 and therefore useless, and mixing an NWS direction with an
// Open-Meteo gust would describe a wind neither model actually forecast.
//
// Both are free and keyless. Where both have a variable, NWS wins. Every value carries
// its provenance so the UI can say which source a number came from rather than implying
// one authority.

import { fetchGridForecast, sampleForecast, climatologyFor, normalFor } from './nws.js';

const OM = 'https://api.open-meteo.com/v1/forecast';
const OM_ARCHIVE = 'https://archive-api.open-meteo.com/v1/archive';

const OM_VARS = [
  'temperature_2m', 'pressure_msl', 'surface_pressure',
  'wind_speed_10m', 'wind_direction_10m', 'wind_gusts_10m',
  'precipitation', 'precipitation_probability', 'cloud_cover', 'relative_humidity_2m',
];

export async function fetchOpenMeteo(cfg, { days = 16 } = {}) {
  const qs = new URLSearchParams({
    latitude: String(cfg.property.lat),
    longitude: String(cfg.property.lon),
    hourly: OM_VARS.join(','),
    temperature_unit: 'fahrenheit',
    wind_speed_unit: 'mph',
    precipitation_unit: 'inch',
    timezone: cfg.property.timezone,
    forecast_days: String(days),
    past_days: '2',
  });
  const res = await fetch(`${OM}?${qs}`, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`Open-Meteo ${res.status}`);
  const j = await res.json();

  // Open-Meteo returns local wall-clock times with no offset when timezone is set.
  // Parse them as instants using the offset it reports alongside.
  const offsetMs = (j.utc_offset_seconds ?? 0) * 1000;
  const byHour = new Map();
  j.hourly.time.forEach((t, i) => {
    const ms = Date.parse(`${t}:00Z`) - offsetMs;
    byHour.set(ms, {
      t: ms,
      tempF: j.hourly.temperature_2m[i],
      pressureHpa: j.hourly.pressure_msl[i] ?? j.hourly.surface_pressure[i],
      windMph: j.hourly.wind_speed_10m[i],
      windDirDeg: j.hourly.wind_direction_10m[i],
      gustMph: j.hourly.wind_gusts_10m[i],
      precipIn: j.hourly.precipitation[i],
      precipProb: j.hourly.precipitation_probability[i],
      skyCover: j.hourly.cloud_cover[i],
      humidity: j.hourly.relative_humidity_2m[i],
    });
  });
  return { byHour, generated: j.generationtime_ms, range: [j.hourly.time[0], j.hourly.time.at(-1)] };
}

const HOUR = 3600000;

/**
 * One merged hourly record. NWS wins on the variables it publishes well; Open-Meteo
 * supplies pressure and gusts always, and everything else once NWS runs out.
 */
function mergeHour(ms, nws, om) {
  const o = om?.byHour.get(Math.floor(ms / HOUR) * HOUR) ?? null;
  const n = nws ? sampleForecast(nws, new Date(ms)) : null;
  if (!n && !o) return null;

  return {
    t: ms,
    tempF: n?.tempF ?? o?.tempF ?? null,
    // Wind comes from one source so speed, direction and gust describe the same forecast.
    windMph: o?.windMph ?? n?.windMph ?? null,
    windDirDeg: o?.windDirDeg ?? n?.windDirDeg ?? null,
    gustMph: o?.gustMph ?? null,
    pressureHpa: o?.pressureHpa ?? null,
    precipProb: n?.precipProb ?? o?.precipProb ?? null,
    precipIn: o?.precipIn ?? (n?.precipMm != null ? n.precipMm / 25.4 : null),
    skyCover: n?.skyCover ?? o?.skyCover ?? null,
    humidity: n?.humidity ?? o?.humidity ?? null,
    sources: {
      temp: n?.tempF != null ? 'nws' : o?.tempF != null ? 'open-meteo' : null,
      wind: o?.windMph != null ? 'open-meteo' : n?.windMph != null ? 'nws' : null,
      pressure: o?.pressureHpa != null ? 'open-meteo' : null,
    },
  };
}

/** Merged hourly series covering [fromMs, toMs]. */
export async function hourlySeries(cfg, fromMs, toMs, cached = {}) {
  const nws = cached.nws ?? await fetchGridForecast(cfg).catch(() => null);
  const om = cached.om ?? await fetchOpenMeteo(cfg).catch(() => null);
  const out = [];
  for (let t = Math.floor(fromMs / HOUR) * HOUR; t <= toMs; t += HOUR) {
    const h = mergeHour(t, nws, om);
    if (h) out.push(h);
  }
  return { hours: out, nws, om };
}

/**
 * Historical hourly weather for a past date range, from the Open-Meteo archive.
 *
 * Nothing calls this today. It is kept because the annual review needs it: comparing what
 * the tool predicted against what actually happened requires real weather for past dates,
 * and the forecast endpoints only reach a couple of days back. Free, keyless, complete
 * hourly record including real pressure. See ANNUAL_REVIEW.md.
 */
export async function fetchArchive(cfg, startDate, endDate) {
  const qs = new URLSearchParams({
    latitude: String(cfg.property.lat),
    longitude: String(cfg.property.lon),
    start_date: startDate,
    end_date: endDate,
    hourly: 'temperature_2m,pressure_msl,wind_speed_10m,wind_direction_10m,wind_gusts_10m,cloud_cover,precipitation,relative_humidity_2m',
    temperature_unit: 'fahrenheit',
    wind_speed_unit: 'mph',
    precipitation_unit: 'inch',
    timezone: cfg.property.timezone,
  });
  const res = await fetch(`${OM_ARCHIVE}?${qs}`, { signal: AbortSignal.timeout(45000) });
  if (!res.ok) throw new Error(`Open-Meteo archive ${res.status}`);
  const j = await res.json();
  if (j.error) throw new Error(j.reason ?? 'archive error');

  const offsetMs = (j.utc_offset_seconds ?? 0) * 1000;
  const hours = [];
  j.hourly.time.forEach((t, i) => {
    const ms = Date.parse(`${t}:00Z`) - offsetMs;
    hours.push({
      t: ms,
      tempF: j.hourly.temperature_2m[i],
      pressureHpa: j.hourly.pressure_msl[i],
      windMph: j.hourly.wind_speed_10m[i],
      windDirDeg: j.hourly.wind_direction_10m[i],
      gustMph: j.hourly.wind_gusts_10m?.[i] ?? null,
      skyCover: j.hourly.cloud_cover[i],
      precipIn: j.hourly.precipitation[i],
      precipProb: null,
      humidity: j.hourly.relative_humidity_2m[i],
      sources: { temp: 'open-meteo-archive', wind: 'open-meteo-archive', pressure: 'open-meteo-archive' },
    });
  });
  return hours.filter((h) => h.tempF != null);
}

// --- aggregation over a sit window ------------------------------------------
//
// A sit is four hours, not an instant. The old model sampled one moment 45 minutes after
// sunrise and called that the morning, which meant a front arriving at 9am did not exist.
// These aggregate across the whole window the way the hunt actually experiences it.

const toRad = (d) => (d * Math.PI) / 180;
const toDeg = (r) => (r * 180) / Math.PI;

/**
 * Vector mean wind, plus steadiness.
 *
 * Arithmetic averaging of compass bearings is simply wrong: 350 and 10 average to 180,
 * the exact opposite of the truth. So directions are summed as unit vectors weighted by
 * speed.
 *
 * `steadiness` is the resultant length over the scalar sum, 0 to 1. Near 1 the wind held
 * one direction for the whole sit. Near 0 it boxed the compass, and the mean direction is
 * a number with no meaning behind it. This is what the scent check needed and never had.
 */
export function aggregateWind(hours) {
  let sx = 0; let sy = 0; let scalar = 0; let n = 0;
  let maxGust = null; let maxSpeed = null;
  for (const h of hours) {
    if (h.windDirDeg == null || h.windMph == null) continue;
    const s = Math.max(h.windMph, 0.1);
    sx += s * Math.sin(toRad(h.windDirDeg));
    sy += s * Math.cos(toRad(h.windDirDeg));
    scalar += s;
    n++;
    if (h.gustMph != null) maxGust = Math.max(maxGust ?? 0, h.gustMph);
    maxSpeed = Math.max(maxSpeed ?? 0, h.windMph);
  }
  if (!n) return { dirDeg: null, meanMph: null, steadiness: null, maxGust: null, gustRatio: null };

  const resultant = Math.hypot(sx, sy);
  const dir = (toDeg(Math.atan2(sx, sy)) + 360) % 360;
  const meanMph = scalar / n;
  return {
    dirDeg: +dir.toFixed(0),
    meanMph: +meanMph.toFixed(1),
    maxMph: maxSpeed == null ? null : +maxSpeed.toFixed(1),
    steadiness: +(resultant / scalar).toFixed(3),
    maxGust: maxGust == null ? null : +maxGust.toFixed(1),
    gustRatio: maxGust != null && meanMph > 0.5 ? +(maxGust / meanMph).toFixed(2) : null,
  };
}

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

export function aggregateWindow(hours) {
  const have = (k) => hours.map((h) => h[k]).filter((v) => v != null);
  const temps = have('tempF');
  const press = have('pressureHpa');
  const wind = aggregateWind(hours);

  return {
    hours: hours.length,
    tempF: temps.length ? +mean(temps).toFixed(1) : null,
    tempMinF: temps.length ? +Math.min(...temps).toFixed(1) : null,
    tempMaxF: temps.length ? +Math.max(...temps).toFixed(1) : null,
    windMph: wind.meanMph,
    windDirDeg: wind.dirDeg,
    windSteadiness: wind.steadiness,
    windMaxMph: wind.maxMph,
    gustMph: wind.maxGust,
    gustRatio: wind.gustRatio,
    // Peak probability across the window, not the mean: a 70% hour inside an otherwise
    // dry sit is a wet sit.
    precipProb: have('precipProb').length ? Math.max(...have('precipProb')) : null,
    precipIn: have('precipIn').length ? +have('precipIn').reduce((a, b) => a + b, 0).toFixed(3) : null,
    skyCover: have('skyCover').length ? Math.round(mean(have('skyCover'))) : null,
    humidity: have('humidity').length ? Math.round(mean(have('humidity'))) : null,
    pressureHpa: press.length ? +mean(press).toFixed(1) : null,
    // Change across the sit itself. A barometer falling through the morning is a
    // different animal from one that fell yesterday and flattened out.
    pressureDeltaWindow: press.length >= 2 ? +(press.at(-1) - press[0]).toFixed(2) : null,
    sources: hours[0]?.sources ?? null,
  };
}

// --- wind trustworthiness ---------------------------------------------------
//
// The scent check used to take a wind direction and render a confident verdict from it,
// at any speed. This week's forecast had 1 and 2 mph mornings; at that speed thermals
// decide where your scent goes and the compass bearing means close to nothing. The tool
// was most confidently wrong exactly on the calm mornings you would most want to hunt.
//
// Three things make a direction trustworthy, and all three are now available:
//   speed       below about 3 mph, thermal flow dominates outright
//   steadiness  how much the direction held across the sit (vector resultant, 0-1)
//   gustiness   gusts far above the sustained speed mean turbulent, mixing air
export function windConfidence({ windMph, windSteadiness, gustRatio }, cfg = {}) {
  if (windMph == null) return { score: 0, label: 'unknown', reasons: ['no wind forecast for this slot'] };

  const calmFloor = cfg.calmFloorMph ?? 3;
  const reliableAt = cfg.reliableMph ?? 8;
  const reasons = [];

  // Speed term: 0 at or below the calm floor, 1 at the reliable threshold.
  const speed = Math.max(0, Math.min(1, (windMph - calmFloor) / (reliableAt - calmFloor)));
  if (windMph < calmFloor) reasons.push(`${windMph.toFixed(1)} mph is below the ${calmFloor} mph floor where thermals take over from wind`);
  else if (speed < 0.6) reasons.push(`${windMph.toFixed(1)} mph is light enough that thermals compete with the forecast direction`);

  // Steadiness term, passed straight through. Squared so a wind that wandered is punished
  // harder than one that held.
  const steady = windSteadiness == null ? 0.7 : windSteadiness ** 2;
  if (windSteadiness != null && windSteadiness < 0.85) reasons.push(`direction swung through the sit (steadiness ${windSteadiness.toFixed(2)})`);

  // Gust term: a 3x gust ratio is turbulent air, not a clean plume.
  const gust = gustRatio == null ? 1 : Math.max(0.35, Math.min(1, 1 - (gustRatio - 2) / 3));
  if (gustRatio != null && gustRatio > 2.5) reasons.push(`gusts run ${gustRatio.toFixed(1)}x the sustained speed, so air is mixing rather than flowing`);

  const score = +(speed * steady * gust).toFixed(3);
  const label = score >= 0.6 ? 'reliable' : score >= 0.3 ? 'marginal' : 'unreliable';
  return { score, label, speed: +speed.toFixed(2), steady: +steady.toFixed(2), gust: +gust.toFixed(2), reasons };
}

export { climatologyFor, normalFor };
