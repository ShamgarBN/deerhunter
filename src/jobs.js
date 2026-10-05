// The daily pipeline. One refresh job, one alert job.
//
// refresh():
//   1. Resolve the NWS grid once, if config does not already have it cached.
//   2. Pull the gridpoint forecast (~7 usable days).
//   3. Backfill yesterday's real observations, overwriting the forecast that was stored
//      for those slots. This is what makes sit snapshots reflect what actually happened.
//   4. Write a weather row for every AM and PM slot in the season, falling back to
//      climate normals past the forecast horizon.
//   5. Score every slot and store it, including per-stand scent verdicts.
//   6. Auto-calibrate the first time the map has enough marked to make it meaningful.
//
// alert(): read the stored scores, apply thresholds and dedupe, fire Discord.

import { loadConfig, loadScoring, loadMap, saveConfig, saveScoring } from './config.js';
import { getDb } from './db.js';
import {
  resolveGrid, fetchGridForecast, sampleForecast, fetchObservations,
  nearestObservation, climatologyFor, normalFor,
} from './nws.js';
import { hourlySeries, aggregateWindow, windConfidence, fetchOpenMeteo } from './weather.js';
import { sitWindow, slotTimes } from './astro.js';
import { scoreSlot } from './scoring.js';
import { standVerdict, thermalNotes } from './wind.js';
import { loadSeasons, strictnessOn, coveredDates } from './seasons.js';
import { calibrate } from './calibrate.js';
import { sendAlerts, filterAlreadySent } from './discord.js';
import { dateRange, todayLocal, addDays, nowIso, daysBetween } from './timeutil.js';

// Last time each stand was hunted, derived from the sit log rather than stored on the
// stand, so the two can never drift out of sync.
export function lastHuntedByStand() {
  const rows = getDb().prepare('SELECT stand_id, MAX(date) AS last FROM sits WHERE stand_id IS NOT NULL GROUP BY stand_id').all();
  return Object.fromEntries(rows.map((r) => [r.stand_id, r.last]));
}

// Weather derivatives: what CHANGED, not just what it is.
//
// Deer respond to the leading edge of a change at least as much as to the level, and the
// first build modeled only levels. These compare a slot against the same slot 24 and 48
// hours earlier, which is the comparison a hunter makes standing in the yard.
function computeDerivatives(byKey, date, slot) {
  const cur = byKey[`${date}|${slot}`];
  if (!cur) return {};
  const prev24 = byKey[`${addDays(date, -1)}|${slot}`];
  const prev48 = byKey[`${addDays(date, -2)}|${slot}`];

  const d = {};
  if (cur.tempF != null && prev24?.tempF != null) d.tempChange24h = +(cur.tempF - prev24.tempF).toFixed(1);
  if (cur.tempF != null && prev48?.tempF != null) d.tempChange48h = +(cur.tempF - prev48.tempF).toFixed(1);
  if (cur.pressureHpa != null && prev24?.pressureHpa != null) {
    d.pressureChange24h = +(cur.pressureHpa - prev24.pressureHpa).toFixed(2);
  }
  return d;
}

export async function refresh({ log = console.log } = {}) {
  const cfg = loadConfig();
  const scoring = loadScoring();
  const map = loadMap();
  const db = getDb();
  const today = todayLocal(cfg.property.timezone);

  // 1. Grid resolution, cached. NWS asks callers not to re-resolve points on every run.
  if (!cfg.nws.gridId) {
    const g = await resolveGrid(cfg);
    cfg.nws.gridId = g.gridId; cfg.nws.gridX = g.gridX; cfg.nws.gridY = g.gridY;
    saveConfig(cfg);
    log(`Resolved NWS grid: ${g.gridId}/${g.gridX},${g.gridY} (${g.city}, ${g.state})`);
  }

  // 2. Forecast.
  let grid = null;
  try {
    grid = await fetchGridForecast(cfg);
    log(`NWS gridpoint updated ${grid.updateTime}`);
  } catch (err) {
    log(`NWS forecast fetch failed (${err.message}). Falling back to climatology for all slots.`);
  }

  // 3. Yesterday's observations, so snapshots settle on actuals.
  let obs = [];
  try {
    const start = new Date(Date.parse(`${addDays(today, -2)}T00:00:00Z`)).toISOString();
    obs = await fetchObservations(cfg, start, new Date().toISOString());
    log(`Pulled ${obs.length} observations from ${cfg.nws.observationStation}`);
  } catch (err) {
    log(`Observation fetch failed (${err.message}); past slots keep their forecast values.`);
  }

  // 4. Weather for every slot, aggregated across the four-hour sit window.
  //
  // A sit is a window, not an instant. The first build sampled one moment per slot, so a
  // front arriving at 9am did not exist in the morning score. Now each slot aggregates
  // the merged hourly series across its whole window: mean temperature, VECTOR-mean wind
  // direction with a steadiness measure, peak precipitation probability, and the pressure
  // change across the sit itself.
  // Only days inside an enabled season. With several seasons defined there can be gaps
  // between them, and scoring a closed week is noise on the calendar.
  const seasons = loadSeasons(cfg);
  const dates = coveredDates(seasons, dateRange(cfg.season.start, cfg.season.end));
  const upsertWx = db.prepare(`
    INSERT INTO weather (date, slot, source, window_start, window_end,
                         temp_f, temp_min_f, temp_max_f, temp_normal_f,
                         wind_mph, wind_dir_deg, gust_mph, wind_steadiness,
                         wind_confidence, wind_confidence_label,
                         precip_prob, precip_mm, precip_in, sky_cover,
                         pressure_pa, pressure_hpa, pressure_delta_window,
                         pressure_trend_pa, humidity, fetched_at)
    VALUES (@date,@slot,@source,@window_start,@window_end,
            @temp_f,@temp_min_f,@temp_max_f,@temp_normal_f,
            @wind_mph,@wind_dir_deg,@gust_mph,@wind_steadiness,
            @wind_confidence,@wind_confidence_label,
            @precip_prob,@precip_mm,@precip_in,@sky_cover,
            @pressure_pa,@pressure_hpa,@pressure_delta_window,
            @pressure_trend_pa,@humidity,@fetched_at)
    ON CONFLICT(date, slot) DO UPDATE SET
      source=excluded.source, window_start=excluded.window_start, window_end=excluded.window_end,
      temp_f=excluded.temp_f, temp_min_f=excluded.temp_min_f, temp_max_f=excluded.temp_max_f,
      temp_normal_f=excluded.temp_normal_f,
      wind_mph=excluded.wind_mph, wind_dir_deg=excluded.wind_dir_deg, gust_mph=excluded.gust_mph,
      wind_steadiness=excluded.wind_steadiness, wind_confidence=excluded.wind_confidence,
      wind_confidence_label=excluded.wind_confidence_label,
      precip_prob=excluded.precip_prob, precip_mm=excluded.precip_mm, precip_in=excluded.precip_in,
      sky_cover=excluded.sky_cover, pressure_hpa=excluded.pressure_hpa,
      pressure_delta_window=excluded.pressure_delta_window, humidity=excluded.humidity,
      fetched_at=excluded.fetched_at
  `);

  // Pull the merged hourly series once, spanning everything the forecasts reach.
  let series = { hours: [] };
  try {
    const from = Date.parse(`${addDays(today, -2)}T00:00:00Z`);
    const to = Date.parse(`${addDays(today, 17)}T23:00:00Z`);
    series = await hourlySeries(cfg, from, to, { nws: grid });
    const withPressure = series.hours.filter((h) => h.pressureHpa != null).length;
    log(`Merged hourly series: ${series.hours.length} hours, ${withPressure} with real pressure`);
  } catch (err) {
    log(`Hourly merge failed (${err.message}); slots fall back to single-point sampling.`);
  }

  const hoursIn = (startMs, endMs) => series.hours.filter((h) => h.t >= startMs && h.t < endMs);

  const built = {};
  let nForecast = 0; let nObs = 0; let nClimo = 0;

  for (const date of dates) {
    for (const slot of ['AM', 'PM']) {
      const win = sitWindow(date, slot, cfg.property.lat, cfg.property.lon);
      const climo = climatologyFor(date, slot);
      let row = null;
      let source = 'climatology';

      // Observations win for slots already past.
      if (date <= today) {
        const o = nearestObservation(obs, new Date((win.start.getTime() + win.end.getTime()) / 2), 150);
        if (o) {
          row = {
            tempF: o.tempF, tempMinF: o.tempF, tempMaxF: o.tempF,
            windMph: o.windMph, windDirDeg: o.windDirDeg, windSteadiness: null,
            gustMph: null, precipProb: null, precipIn: o.precipMm != null ? o.precipMm / 25.4 : null,
            skyCover: o.skyCover, humidity: o.humidity,
            pressureHpa: o.pressurePa != null ? o.pressurePa / 100 : null,
            pressureDeltaWindow: null, pressurePa: o.pressurePa,
          };
          source = 'observation'; nObs++;
        }
      }

      if (!row) {
        const hrs = hoursIn(win.start.getTime(), win.end.getTime());
        if (hrs.length) {
          row = aggregateWindow(hrs);
          source = 'forecast'; nForecast++;
        }
      }

      if (!row) {
        row = {
          tempF: climo?.tempF ?? null, tempMinF: null, tempMaxF: null,
          windMph: null, windDirDeg: null, windSteadiness: null, gustMph: null,
          precipProb: null, precipIn: null, skyCover: null, humidity: null,
          pressureHpa: null, pressureDeltaWindow: null, pressurePa: null,
        };
        nClimo++;
      }

      const conf = windConfidence(
        { windMph: row.windMph, windSteadiness: row.windSteadiness, gustRatio: row.gustRatio },
        scoring.windConfidence ?? {},
      );

      built[`${date}|${slot}`] = { ...row, date, slot, source, win, climo, conf };
    }
  }

  log(`Weather built: ${nObs} observed, ${nForecast} forecast windows, ${nClimo} climatology`);

  // Derivatives need every slot present first, so this is a second pass.
  const writeWx = db.transaction(() => {
    for (const key of Object.keys(built)) {
      const b = built[key];
      const d = computeDerivatives(built, b.date, b.slot);
      b.derived = d;
      upsertWx.run({
        date: b.date, slot: b.slot, source: b.source,
        window_start: b.win.start.toISOString(), window_end: b.win.end.toISOString(),
        temp_f: b.tempF, temp_min_f: b.tempMinF ?? null, temp_max_f: b.tempMaxF ?? null,
        temp_normal_f: b.climo?.tempF ?? null,
        wind_mph: b.windMph ?? null, wind_dir_deg: b.windDirDeg ?? null,
        gust_mph: b.gustMph ?? null, wind_steadiness: b.windSteadiness ?? null,
        wind_confidence: b.conf.score, wind_confidence_label: b.conf.label,
        precip_prob: b.precipProb ?? null,
        precip_mm: b.precipIn != null ? +(b.precipIn * 25.4).toFixed(2) : null,
        precip_in: b.precipIn ?? null,
        sky_cover: b.skyCover ?? null,
        pressure_pa: b.pressurePa ?? null,
        pressure_hpa: b.pressureHpa ?? null,
        pressure_delta_window: b.pressureDeltaWindow ?? null,
        pressure_trend_pa: null,
        humidity: b.humidity ?? null,
        fetched_at: nowIso(),
      });
    }
    const setD = db.prepare('UPDATE weather SET temp_change_24h=?, temp_change_48h=?, pressure_change_24h=? WHERE date=? AND slot=?');
    for (const key of Object.keys(built)) {
      const b = built[key];
      setD.run(b.derived.tempChange24h ?? null, b.derived.tempChange48h ?? null, b.derived.pressureChange24h ?? null, b.date, b.slot);
    }
  });
  writeWx();

  const derivCount = Object.values(built).filter((b) => b.derived?.tempChange24h != null).length;
  const pressCount = Object.values(built).filter((b) => b.pressureHpa != null).length;
  log(`Derivatives: ${derivCount} slots with a 24h temperature change, ${pressCount} with real pressure`);

  // 5. Auto-calibrate once the map is worth calibrating against.
  const stands = map.points.filter((p) => p.type === 'stand');
  const isIdentity = (c) => !c || (c.offset === 0 && c.gain === 1);
  if (stands.length >= 2 && isIdentity(scoring.calibration?.buck)) {
    const cal = calibrate({ cfg, scoring, map });
    if (!cal.diagnostics.error && !cal.diagnostics.buck.degenerate) {
      scoring.calibration = { buck: cal.buck, general: cal.general };
      scoring._calibrationDiagnostics = cal.diagnostics;
      saveScoring(scoring);
      log(`Auto-calibrated: buck gain ${cal.buck.gain}, general gain ${cal.general.gain}`);
      for (const t of ['buck', 'general']) {
        if (cal.diagnostics[t].warning) log(`  Calibration warning (${t}): ${cal.diagnostics[t].warning}`);
      }
    }
  }

  // 6. Score every slot.
  const lastHunted = lastHuntedByStand();
  const wxRows = db.prepare('SELECT * FROM weather').all();
  const wxByKey = Object.fromEntries(wxRows.map((r) => [`${r.date}|${r.slot}`, r]));

  const upsertScore = db.prepare(`
    INSERT INTO scores (date, slot, buck_score, general_score, rut_offset, rut_phase, confidence, factors_json, stands_json, computed_at)
    VALUES (@date,@slot,@buck,@general,@offset,@phase,@confidence,@factors,@stands,@at)
    ON CONFLICT(date, slot) DO UPDATE SET
      buck_score=excluded.buck_score, general_score=excluded.general_score,
      rut_offset=excluded.rut_offset, rut_phase=excluded.rut_phase, confidence=excluded.confidence,
      factors_json=excluded.factors_json, stands_json=excluded.stands_json, computed_at=excluded.computed_at
  `);

  let scored = 0;
  const writeScores = db.transaction(() => {
    for (const date of dates) {
      for (const slot of ['AM', 'PM']) {
        const row = wxByKey[`${date}|${slot}`];
        if (!row) continue;
        const wx = {
          source: row.source,
          tempF: row.temp_f, tempNormalF: row.temp_normal_f,
          tempMinF: row.temp_min_f, tempMaxF: row.temp_max_f,
          tempChange24h: row.temp_change_24h,
          tempChange48h: row.temp_change_48h,
          windMph: row.wind_mph, windDirDeg: row.wind_dir_deg,
          gustMph: row.gust_mph, windSteadiness: row.wind_steadiness,
          windConfidence: row.wind_confidence, windConfidenceLabel: row.wind_confidence_label,
          precipProb: row.precip_prob, precipMm: row.precip_mm, precipIn: row.precip_in,
          skyCover: row.sky_cover,
          pressureHpa: row.pressure_hpa,
          pressureChange24h: row.pressure_change_24h,
          pressureDeltaWindow: row.pressure_delta_window,
          humidity: row.humidity,
          windowStart: row.window_start, windowEnd: row.window_end,
        };
        const s = scoreSlot({ date, slot, wx, cfg, scoring, map, lastHuntedByStand: lastHunted });

        // Scent tolerance follows the strictest weapon open that day.
        const strict = strictnessOn(date, seasons);

        // Per-stand scent verdicts for this slot's forecast wind.
        const standDetail = s.standScores.map((ss) => {
          const stand = map.points.find((p) => p.id === ss.id);
          const verdict = row.wind_dir_deg != null
            ? standVerdict(stand, map, row.wind_dir_deg, cfg, {
                confidence: row.wind_confidence,
                label: row.wind_confidence_label,
                minConfidence: scoring.windConfidence?.minConfidenceForVerdict ?? 0.3,
                windMph: row.wind_mph,
                steadiness: row.wind_steadiness,
              }, strict.strictness)
            : { verdict: 'unknown', note: 'No wind forecast for this slot, so scent safety cannot be computed. Past the forecast horizon this is expected.' };
          return {
            ...ss,
            verdict: verdict.verdict,
            scentSource: verdict.source ?? null,
            scentNote: verdict.note ?? null,
            conflicts: verdict.conflicts ?? [],
            manualSafeWinds: verdict.manualSafeWinds ?? null,
            geometryVerdict: verdict.geometryVerdict ?? null,
            thermalNotes: thermalNotes(stand, map, slot, cfg, map.terrainPositions),
          };
        });

        upsertScore.run({
          date, slot,
          buck: s.buckScore, general: s.generalScore,
          offset: s.rut.offset, phase: s.rut.phase,
          confidence: row.source === 'observation' ? 'observed'
            : row.source === 'forecast'
              ? (daysBetween(today, date) <= cfg.forecast.forecastConfidenceDays ? 'forecast' : 'outlook')
              : 'climatology',
          factors: JSON.stringify({
            buck: s.buck.contributions,
            general: s.general.contributions,
            base: { buck: s.buck.base, general: s.general.base },
            seasons: strict.seasons,
            scent: { strictness: strict.strictness, weapon: strict.weapon, weaponLabel: strict.weaponLabel, governedBy: strict.governedBy },
          }),
          stands: JSON.stringify(standDetail),
          at: nowIso(),
        });
        scored++;
      }
    }
  });
  writeScores();
  log(`Scored ${scored} slots across ${dates.length} days`);

  return { scored, weather: { observed: nObs, forecast: nForecast, climatology: nClimo }, dates: dates.length };
}

export async function checkAlerts({ log = console.log, force = false } = {}) {
  const cfg = loadConfig();
  const db = getDb();
  if (!cfg.alerts.enabled && !force) { log('Alerts disabled in config.'); return { sent: 0 }; }

  const today = todayLocal(cfg.property.timezone);
  const horizon = cfg.alerts.onlyWithinForecastWindow
    ? cfg.forecast.forecastConfidenceDays
    : cfg.forecast.extendedOutlookDays;
  const end = addDays(today, horizon);

  const rows = db.prepare(`
    SELECT s.*, w.wind_dir_deg, w.wind_mph, w.temp_f, w.temp_normal_f, w.precip_prob, w.sky_cover,
           a.am AS avail_am, a.pm AS avail_pm
      FROM scores s
      LEFT JOIN weather w ON w.date = s.date AND w.slot = s.slot
      LEFT JOIN availability a ON a.date = s.date
     WHERE s.date >= ? AND s.date <= ?
       AND s.date >= ? AND s.date <= ?
     ORDER BY s.date, s.slot
  `).all(today, end, cfg.season.start, cfg.season.end);

  const threshold = cfg.alerts.scoreThreshold;
  const candidates = [];
  for (const r of rows) {
    if (cfg.alerts.onlyWithinForecastWindow && r.confidence === 'climatology') continue;
    if (cfg.alerts.onlyAvailableDays) {
      const avail = r.slot === 'AM' ? r.avail_am : r.avail_pm;
      if (!avail) continue;
    }
    const stands = JSON.parse(r.stands_json || '[]');
    const base = {
      date: r.date, slot: r.slot,
      buckScore: r.buck_score, generalScore: r.general_score,
      rut: { phaseLabel: r.rut_phase, offset: r.rut_offset },
      confidence: r.confidence,
      weather: { tempF: r.temp_f, tempNormalF: r.temp_normal_f, windMph: r.wind_mph, precipProb: r.precip_prob },
      recommendedStands: stands,
    };
    if (cfg.alerts.alertOnBuckScore && r.buck_score >= threshold) candidates.push({ ...base, kind: 'buck' });
    if (cfg.alerts.alertOnGeneralScore && r.general_score >= threshold) candidates.push({ ...base, kind: 'general' });
  }

  const toSend = force ? candidates : filterAlreadySent(candidates, cfg.alerts.cooldownHours);
  if (!toSend.length) { log(`Nothing above ${threshold} in the next ${horizon} days that has not already been sent.`); return { sent: 0, considered: candidates.length }; }

  cfg.alerts.windowDaysUsed = horizon;
  const res = await sendAlerts(cfg, toSend);
  log(`Sent ${res.sent} alert(s).`);
  return { ...res, considered: candidates.length };
}
