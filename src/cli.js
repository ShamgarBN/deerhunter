#!/usr/bin/env node
// Command line entry point. Everything the dashboard does, the CLI does, so the Mac mini
// can run jobs from launchd without the server being up.

import { loadConfig, loadScoring, loadMap, saveScoring, DATA_DIR } from './config.js';
import { getDb } from './db.js';
import { refresh, checkAlerts } from './jobs.js';
import { runReweight, resetToPriors, adjustmentHistory } from './reweight.js';
import { calibrate, distribution } from './calibrate.js';
import { testWebhook } from './discord.js';
import { rutFor, seasonHighlights } from './rut.js';
import { todayLocal, weekday } from './timeutil.js';
import fs from 'fs';
import path from 'path';

const [, , cmd, ...args] = process.argv;
const has = (flag) => args.includes(flag);
const argOf = (flag, dflt = null) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};

const bar = (v, width = 20) => {
  const n = Math.round((v / 10) * width);
  return '█'.repeat(Math.max(0, n)) + '·'.repeat(Math.max(0, width - n));
};

async function main() {
  switch (cmd) {
    case 'refresh': {
      const r = await refresh();
      console.log(`\nDone: ${r.scored} slots scored across ${r.dates} days.`);
      break;
    }

    case 'alert': {
      await checkAlerts({ force: has('--force') });
      break;
    }

    case 'test-discord': {
      const r = await testWebhook(loadConfig());
      console.log(r.skipped ? `Skipped: ${r.skipped}` : 'Posted to Discord.');
      break;
    }

    case 'score': {
      const cfg = loadConfig();
      const scoring = loadScoring();
      const map = loadMap();

      if (has('--calibrate')) {
        const cal = calibrate({ cfg, scoring, map });
        if (cal.diagnostics.error) { console.error(cal.diagnostics.error); break; }
        console.log('Raw score range before calibration:');
        for (const t of ['buck', 'general']) {
          const d = cal.diagnostics[t];
          console.log(`  ${t.padEnd(8)} min ${d.min}  p05 ${d.p05}  p95 ${d.p95}  max ${d.max}  (spread ${d.rawSpread}, n=${d.n})`);
          if (d.warning) console.log(`    WARNING: ${d.warning}`);
        }
        if (has('--dry-run')) { console.log('\nDry run, nothing written.'); break; }
        scoring.calibration = { buck: cal.buck, general: cal.general };
        scoring._calibrationDiagnostics = cal.diagnostics;
        saveScoring(scoring);
        const dist = distribution({ cfg, scoring, map });
        console.log('\nCalibrated. Expected season distribution:');
        for (const t of ['buck', 'general']) {
          const x = dist[t];
          console.log(`  ${t.padEnd(8)} p05 ${x.p05}  p25 ${x.p25}  median ${x.p50}  p75 ${x.p75}  p95 ${x.p95}`);
          console.log(`           ${x.histogram.map((n, i) => `${i}:${n}`).join(' ')}`);
        }
        console.log(`\nWritten to config/scoring.json (buck gain ${cal.buck.gain}, general gain ${cal.general.gain}).`);
        break;
      }

      // Default: print the season calendar.
      const db = getDb();
      const rows = db.prepare(`
        SELECT s.*, w.temp_f, w.temp_normal_f, w.wind_mph, w.precip_prob
          FROM scores s LEFT JOIN weather w ON w.date=s.date AND w.slot=s.slot
         WHERE s.date >= ? AND s.date <= ? ORDER BY s.date, s.slot
      `).all(cfg.season.start, cfg.season.end);
      if (!rows.length) { console.log('No scores stored yet. Run: npm run refresh'); break; }

      let lastPhase = null;
      console.log('date        day  slot  buck                 general              phase');
      for (const r of rows) {
        if (r.rut_phase !== lastPhase) { console.log(`--- ${r.rut_phase} ---`); lastPhase = r.rut_phase; }
        console.log(
          `${r.date}  ${weekday(r.date)}  ${r.slot}   ` +
          `${String(r.buck_score).padStart(5)} ${bar(r.buck_score)}  ` +
          `${String(r.general_score).padStart(5)} ${bar(r.general_score)}  ` +
          `${r.confidence}`,
        );
      }
      break;
    }

    case 'rut': {
      const cfg = loadConfig();
      const scoring = loadScoring();
      console.log(`Peak breeding date: ${scoring.peakRutDate}`);
      console.log(`Today (${todayLocal()}): ${JSON.stringify(rutFor(todayLocal(), scoring))}\n`);
      for (const h of seasonHighlights(scoring, cfg.season)) {
        console.log(`${h.date}${h.through ? ` to ${h.through}` : '          '}  ${h.label.padEnd(16)} ${h.note}`);
      }
      break;
    }

    case 'reweight': {
      if (has('--reset')) { console.log(JSON.stringify(resetToPriors())); break; }
      if (has('--history')) {
        for (const a of adjustmentHistory(50)) {
          console.log(`${a.created_at.slice(0, 16)}  ${a.factor.padEnd(18)} ${a.target.padEnd(8)} ${a.old_weight} -> ${a.new_weight}  (n=${a.sample_n}, shrink=${a.shrinkage?.toFixed?.(2)}) ${a.clipped ? 'CLIPPED' : ''}`);
        }
        break;
      }
      const apply = has('--apply');
      const r = runReweight({ dryRun: !apply, season: argOf('--season') });
      console.log(`${r.totalSits} logged sits with snapshots.\n`);
      console.log('factor              target    n   rateHi rateLo   prior -> new     note');
      for (const x of r.results) {
        if (x.skipped) { console.log(`${x.factor.padEnd(19)} ${x.target.padEnd(9)} ${String(x.n ?? 0).padStart(3)}   skipped: ${x.reason}`); continue; }
        if (x.frozen) { console.log(`${x.factor.padEnd(19)} ${x.target.padEnd(9)} ${String(x.n).padStart(3)}   ${String(x.rateHigh).padStart(6)} ${String(x.rateLow).padStart(6)}   FROZEN (would have been ${x.wouldHaveBeen})`); continue; }
        console.log(`${x.factor.padEnd(19)} ${x.target.padEnd(9)} ${String(x.n).padStart(3)}   ${String(x.rateHigh).padStart(6)} ${String(x.rateLow).padStart(6)}   ${String(x.prior).padStart(5)} -> ${String(x.current).padStart(6)}  ${x.clipped ? 'clipped at 20%' : ''}`);
      }
      console.log(`\n${apply ? `Applied ${r.applied} change(s) to config/scoring.json and logged them.` : 'Dry run. Re-run with --apply to write.'}`);
      break;
    }

    case 'setup': {
      const { runSetup, resolveLocation } = await import('./setup.js');
      const zip = argOf('--zip');
      const place = argOf('--place');
      let lat = parseFloat(argOf('--lat'));
      let lon = parseFloat(argOf('--lon'));

      if ((!Number.isFinite(lat) || !Number.isFinite(lon)) && (zip || place)) {
        const loc = await resolveLocation({ zip, place });
        lat = loc.lat; lon = loc.lon;
        console.log(`Resolved "${zip ?? place}" to ${loc.label} (${lat}, ${lon})`);
        if (loc.approximate) {
          console.log('That is a centroid, good enough to pick the right forecast grid and county.');
          console.log('Drop real pins on the Map tab once the dashboard is up.\n');
        }
      }

      if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
        console.log(`Point the tool at a property. Give it coordinates, a zip, or a place name.

  npm run setup -- --lat 38.9072 --lon -77.0369 --name "Home place"
  npm run setup -- --zip 54843 --name "Home place"
  npm run setup -- --place "Hayward, WI" --name "Home place"

Optional:
  --season-start YYYY-MM-DD   gun season opens
  --season-end   YYYY-MM-DD   gun season closes
  --peak-rut     YYYY-MM-DD   peak breeding date for your region

Resolves the NWS forecast grid, nearest observation station and county, then computes
30-year climate normals for your coordinates. Writes config/config.local.json, which is
gitignored and overrides config.json, so your property stays off version control.`);
        break;
      }
      const r = await runSetup({
        lat, lon,
        name: argOf('--name') ?? 'My property',
        seasonStart: argOf('--season-start'),
        seasonEnd: argOf('--season-end'),
        peakRut: argOf('--peak-rut'),
      });
      console.log(`\nNext: set your season dates and rut peak if you have not, add the Discord webhook to`);
      console.log(`config/config.local.json, then run \`npm run refresh\` and open the Map tab.`);
      void r;
      break;
    }

    case 'normals': {
      // Refresh the NOAA 1991-2020 daily normals cache used for temperature departure.
      const station = argOf('--station', 'USW00013722');
      const base = `https://www.ncei.noaa.gov/access/services/data/v1?dataset=normals-daily&stations=${station}&dataTypes=DLY-TMAX-NORMAL,DLY-TMIN-NORMAL&format=json`;
      const rows = [];
      for (const [s, e] of [['2010-09-01', '2010-12-31'], ['2010-01-01', '2010-01-31']]) {
        const res = await fetch(`${base}&startDate=${s}&endDate=${e}`, { signal: AbortSignal.timeout(60000) });
        if (!res.ok) throw new Error(`NCEI ${res.status}`);
        rows.push(...await res.json());
      }
      const normals = {};
      for (const r of rows) {
        const tmax = r['DLY-TMAX-NORMAL']; const tmin = r['DLY-TMIN-NORMAL'];
        if (!tmax || !tmin) continue;
        normals[r.DATE] = { tmaxF: +(tmax / 10).toFixed(1), tminF: +(tmin / 10).toFixed(1) };
      }
      const out = {
        _source: `NOAA NCEI Daily Climate Normals 1991-2020, station ${station}`,
        _fetched: todayLocal(),
        _note: 'Tenths of degF in the source, converted to degF here. Refresh with: npm run normals',
        station, normals,
      };
      fs.writeFileSync(path.join(DATA_DIR, 'normals-rdu.json'), `${JSON.stringify(out, null, 1)}\n`);
      console.log(`Wrote ${Object.keys(normals).length} days of normals for ${station}.`);
      break;
    }

    case 'sits': {
      const rows = getDb().prepare('SELECT s.*, sn.source FROM sits s LEFT JOIN sit_snapshots sn ON sn.sit_id=s.id ORDER BY s.date DESC').all();
      if (!rows.length) { console.log('No sits logged.'); break; }
      for (const r of rows) {
        console.log(`${r.date} ${r.slot}  ${(r.stand_label ?? '-').padEnd(16)} ${r.saw_deer ? `saw ${r.deer_count} (${r.buck_count} buck)` : 'no deer'}  ${r.source ? `[${r.source}]` : '[no snapshot]'}`);
      }
      break;
    }

    default:
      console.log(`DeerHunter CLI

  npm run setup -- --zip 54843 --name "..."      point the tool at a property (run first)
  npm start                    serve the dashboard and arm the scheduler
  npm run refresh              pull weather, rescore the whole season
  npm run score                print the season calendar
  npm run score -- --calibrate fit the 0-10 scale to this property, then print the distribution
  npm run alert                check thresholds and fire Discord (add --force to ignore dedupe)
  npm run reweight             dry-run the empirical-Bayes update (add --apply to write)
  npm run reweight -- --history   show the weight change log
  npm run reweight -- --reset     restore every weight to its research prior
  npm run normals              refresh the NOAA climate-normals cache
  npm run test-discord         post a connectivity test to the webhook
  node src/cli.js rut          print the rut curve landmarks for this season
  node src/cli.js sits         print the sit log
`);
  }
}

main().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });
