// Drought severity from the US Drought Monitor.
//
// This value scales the food and water proximity weights, and until now it was a number
// somebody typed once and never revisited. That is a slow way to be wrong: drought
// changes over weeks, the tool runs for months, and nothing was going to tell you when
// the ground recovered.
//
// USDM publishes weekly county statistics, free and keyless, keyed by county FIPS, which
// `npm run setup` already resolves.
//
// THE CUMULATIVE TRAP. USDM percentages are cumulative, not exclusive. `d0: 100` does not
// mean the county is uniformly D0; it means 100% of it is at D0 OR WORSE. `d2: 99.47`
// means 99.47% is at D2 or worse. Reading those as exclusive shares would badly
// understate a drought, so the conversion below differences them first.

import { getDb } from './db.js';
import { loadConfig, saveConfig } from './config.js';
import { nowIso, todayLocal } from './timeutil.js';

const USDM = 'https://usdmdataservices.unl.edu/api/CountyStatistics/GetDroughtSeverityStatisticsByAreaPercent';

// Each USDM category mapped onto this tool's 0-1 severity scale. The anchors match the
// scale documented in config.json, so an install that was hand-set to 0.75 for "severe"
// does not jump when automation takes over.
const LEVEL = { none: 0, d0: 0.30, d1: 0.50, d2: 0.75, d3: 0.90, d4: 1.0 };

const LABEL = {
  none: 'no drought', d0: 'D0 abnormally dry', d1: 'D1 moderate',
  d2: 'D2 severe', d3: 'D3 extreme', d4: 'D4 exceptional',
};

/** County FIPS, from the explicit field or parsed out of the county string. */
export function countyFips(cfg) {
  if (cfg.property?.countyFips) return String(cfg.property.countyFips);
  const m = /FIPS\s*(\d{4,5})/i.exec(cfg.property?.county ?? '');
  return m ? m[1].padStart(5, '0') : null;
}

const fmtDate = (d) => `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`;

export async function fetchUsdm(fips, { weeks = 6 } = {}) {
  const end = new Date();
  const start = new Date(end.getTime() - weeks * 7 * 86400000);
  const url = `${USDM}?aoi=${fips}&startdate=${fmtDate(start)}&enddate=${fmtDate(end)}&statisticsType=1`;
  const res = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`USDM ${res.status}`);
  const rows = await res.json();
  if (!Array.isArray(rows) || !rows.length) throw new Error(`USDM returned no rows for FIPS ${fips}`);
  return rows.sort((a, b) => a.mapDate.localeCompare(b.mapDate));
}

/**
 * Coverage-weighted severity for one weekly map.
 *
 * Weighted by area rather than taking the worst category present, so a county with a
 * corner in D3 and the rest in D1 does not read as uniformly extreme. Cumulative
 * percentages are differenced into exclusive shares first.
 */
export function severityFrom(row) {
  const pct = {
    d4: row.d4 ?? 0,
    d3: (row.d3 ?? 0) - (row.d4 ?? 0),
    d2: (row.d2 ?? 0) - (row.d3 ?? 0),
    d1: (row.d1 ?? 0) - (row.d2 ?? 0),
    d0: (row.d0 ?? 0) - (row.d1 ?? 0),
    none: Math.max(0, 100 - (row.d0 ?? 0)),
  };
  const total = Object.values(pct).reduce((a, b) => a + b, 0);
  if (total <= 0) return null;

  const severity = Object.entries(pct).reduce((a, [k, v]) => a + (v * LEVEL[k]), 0) / total;

  // The headline category: the worst one covering a majority of the county.
  let dominant = 'none';
  for (const k of ['d4', 'd3', 'd2', 'd1', 'd0']) {
    if ((row[k] ?? 0) >= 50) { dominant = k; break; }
  }

  return {
    severity: +severity.toFixed(3),
    dominant,
    dominantLabel: LABEL[dominant],
    mapDate: row.mapDate?.slice(0, 10) ?? null,
    coverage: Object.fromEntries(Object.entries(pct).map(([k, v]) => [k, +v.toFixed(2)])),
  };
}

function logChange(entry) {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS drought_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      map_date TEXT, fips TEXT, old_severity REAL, new_severity REAL,
      dominant TEXT, source TEXT, applied INTEGER NOT NULL DEFAULT 1,
      note TEXT, created_at TEXT NOT NULL
    )`);
  db.prepare(`INSERT INTO drought_log (map_date, fips, old_severity, new_severity, dominant, source, applied, note, created_at)
              VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(entry.mapDate, entry.fips, entry.oldSeverity, entry.newSeverity, entry.dominant,
         entry.source, entry.applied ? 1 : 0, entry.note ?? null, nowIso());
}

export function droughtHistory(limit = 30) {
  const db = getDb();
  try {
    return db.prepare('SELECT * FROM drought_log ORDER BY created_at DESC, id DESC LIMIT ?').all(limit);
  } catch { return []; }
}

/**
 * Refresh severity from USDM.
 *
 * Writes only when `drought.mode` is 'auto' (the default). In 'manual' the current
 * reading is still fetched, reported and logged, so you can see what USDM thinks without
 * it overriding a judgement you made deliberately - you know your own ponds better than a
 * county-level map does.
 *
 * Never fatal: drought is one input, and a USDM outage should not stop a refresh.
 */
export async function updateDrought({ log = console.log, force = false } = {}) {
  const cfg = loadConfig();
  const fips = countyFips(cfg);
  if (!fips) {
    log('Drought: no county FIPS resolved, skipping. Run `npm run setup` to set one.');
    return { skipped: 'no-fips' };
  }

  const mode = cfg.drought?.mode ?? 'auto';
  if (mode !== 'auto' && !force) {
    try {
      const rows = await fetchUsdm(fips, { weeks: 2 });
      const cur = severityFrom(rows.at(-1));
      log(`Drought: manual mode, left at ${cfg.drought.severity}. USDM currently reads ${cur.dominantLabel} (would be ${cur.severity}).`);
      return { skipped: 'manual', usdm: cur, current: cfg.drought.severity };
    } catch (err) {
      log(`Drought: manual mode; USDM check failed (${err.message}).`);
      return { skipped: 'manual' };
    }
  }

  let rows;
  try {
    rows = await fetchUsdm(fips);
  } catch (err) {
    log(`Drought: USDM fetch failed (${err.message}). Leaving severity at ${cfg.drought?.severity ?? 0}.`);
    return { error: err.message, current: cfg.drought?.severity ?? 0 };
  }

  const latest = severityFrom(rows.at(-1));
  if (!latest) { log('Drought: USDM row unreadable, leaving severity alone.'); return { error: 'unreadable' }; }

  const old = cfg.drought?.severity ?? 0;
  const changed = Math.abs(latest.severity - old) >= 0.01;

  const prev = rows.length > 1 ? severityFrom(rows.at(-2)) : null;
  const trend = prev == null ? 'unknown'
    : latest.severity > prev.severity + 0.01 ? 'worsening'
      : latest.severity < prev.severity - 0.01 ? 'easing' : 'steady';

  cfg.drought = {
    ...cfg.drought,
    mode: 'auto',
    severity: latest.severity,
    asOf: latest.mapDate ?? todayLocal(cfg.property.timezone),
    source: 'us-drought-monitor',
    dominant: latest.dominant,
    note: `${latest.dominantLabel} over ${Math.round(rows.at(-1)[latest.dominant] ?? 0)}% of ${rows.at(-1).county ?? `FIPS ${fips}`}, per the US Drought Monitor map of ${latest.mapDate}. Trend: ${trend}.`,
    coverage: latest.coverage,
    trend,
    checkedAt: nowIso(),
  };
  saveConfig(cfg);

  logChange({
    mapDate: latest.mapDate, fips, oldSeverity: old, newSeverity: latest.severity,
    dominant: latest.dominant, source: 'us-drought-monitor', applied: true,
    note: changed ? `auto-updated (${trend})` : 'unchanged',
  });

  if (changed) {
    log(`Drought: ${old} -> ${latest.severity} (${latest.dominantLabel}, map ${latest.mapDate}, ${trend}).`);
    log(`  Food and water weights now scale by ${(1 + 0.8 * latest.severity).toFixed(2)}x. Recalibrate if this moved much.`);
  } else {
    log(`Drought: unchanged at ${latest.severity} (${latest.dominantLabel}, map ${latest.mapDate}, ${trend}).`);
  }

  return { ...latest, old, changed, trend, applied: true };
}
