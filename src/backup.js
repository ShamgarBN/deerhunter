// Backups of the things that cannot be refetched.
//
// The whole premise of this tool is that it accumulates value across seasons: the sit log,
// the conditions frozen at log time, the sightings, and weights that have drifted from
// research priors toward what this property actually does. All of it lives in one SQLite
// file on one machine. Everything else - weather, scores, climate normals - is derived and
// can be rebuilt from the APIs, so it is deliberately left out and the file stays small.
//
// The export is a backup, not an archive format: it is written to be re-readable by a
// human and by a future version of this tool, which is why it is plain JSON with a schema
// version rather than a SQLite copy.

import fs from 'fs';
import path from 'path';
import { EXPORT_DIR, loadConfig, loadScoring, loadMap } from './config.js';
import { getDb } from './db.js';
import { nowIso } from './timeutil.js';

export const BACKUP_DIR = EXPORT_DIR;

const SCHEMA_VERSION = 1;

// Tables worth keeping. scores and weather are omitted on purpose: both are rebuilt by a
// refresh, and sit_snapshots already freezes the conditions that mattered at log time.
const TABLES = [
  'sits',
  'sit_snapshots',
  'sightings',
  'availability',
  'weight_adjustments',
  'alerts_sent',
  'webhook_log',
  'drought_log',
];

/**
 * Config with every credential stripped.
 *
 * A backup is a file that gets copied to other disks and attached to messages, so it must
 * not carry the Discord webhook: anyone holding that URL can post to the channel. The key
 * is replaced rather than deleted so a restore makes it obvious what has to be put back.
 */
function safeConfig(cfg) {
  const out = JSON.parse(JSON.stringify(cfg));
  if (out.discord) out.discord.webhookUrl = '[redacted from backup: paste your webhook back in]';
  return out;
}

function tableRows(db, name) {
  try {
    return db.prepare(`SELECT * FROM ${name}`).all();
  } catch {
    return [];  // a table this version does not have yet is not an error
  }
}

/** Everything worth keeping, as one object. */
export function snapshot() {
  const db = getDb();
  const data = Object.fromEntries(TABLES.map((t) => [t, tableRows(db, t)]));
  return {
    _schemaVersion: SCHEMA_VERSION,
    _generatedAt: nowIso(),
    _note: 'Scores and weather are omitted: a refresh rebuilds both. Everything here is either hand-entered or fitted from it, and cannot be recovered any other way.',
    counts: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, v.length])),
    config: safeConfig(loadConfig()),
    scoring: loadScoring(),
    map: loadMap(),
    data,
  };
}

const csvCell = (v) => {
  if (v == null) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

function toCsv(rows) {
  if (!rows.length) return '';
  const cols = Object.keys(rows[0]);
  return [cols.join(','), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(','))].join('\n') + '\n';
}

/**
 * The sit log flattened for a spreadsheet: one row per sit, with its sighting count and
 * the conditions it was logged under. The JSON is the real backup; this exists because
 * "open last season in a spreadsheet" is a reasonable thing to want and parsing nested
 * JSON by hand is not.
 */
function sitsCsv(db) {
  const rows = db.prepare(`
    SELECT s.date, s.slot, s.stand_label, s.saw_deer, s.deer_count, s.buck_count, s.season, s.notes,
           sn.buck_score, sn.general_score, sn.source,
           (SELECT COUNT(*) FROM sightings g WHERE g.sit_id = s.id) AS sightings
      FROM sits s LEFT JOIN sit_snapshots sn ON sn.sit_id = s.id
     ORDER BY s.date, s.slot
  `).all();
  return toCsv(rows);
}

function sightingsCsv(db) {
  const rows = db.prepare(`
    SELECT s.date, s.slot, s.stand_label,
           g.at_time, g.minutes_from_anchor, g.deer_count, g.buck_count,
           g.bearing_deg, g.distance_yards, g.travel_deg, g.travel_yards, g.behavior, g.notes
      FROM sightings g JOIN sits s ON s.id = g.sit_id
     ORDER BY s.date, s.slot, g.minutes_from_anchor
  `).all();
  return toCsv(rows);
}

/**
 * Write a timestamped backup and prune old ones.
 *
 * Retention is by count rather than age so a tool left alone for a month still has
 * history when it comes back, instead of having quietly expired everything.
 */
export function writeBackup({ dir = BACKUP_DIR, keep = 30, log = () => {} } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const stamp = nowIso().replace(/[:.]/g, '-');
  const snap = snapshot();
  const db = getDb();

  const jsonPath = path.join(dir, `deerhunter-${stamp}.json`);
  fs.writeFileSync(jsonPath, JSON.stringify(snap, null, 2));

  const csvDir = path.join(dir, 'csv');
  fs.mkdirSync(csvDir, { recursive: true });
  const sits = path.join(csvDir, `sits-${stamp}.csv`);
  const sightings = path.join(csvDir, `sightings-${stamp}.csv`);
  fs.writeFileSync(sits, sitsCsv(db));
  fs.writeFileSync(sightings, sightingsCsv(db));

  const pruned = prune(dir, keep);
  log(`Backup written: ${path.basename(jsonPath)} (${snap.counts.sits} sits, ${snap.counts.sightings} sightings)`
    + (pruned ? `, pruned ${pruned} old` : ''));

  return { jsonPath, sits, sightings, counts: snap.counts, pruned };
}

function prune(dir, keep) {
  let removed = 0;
  const sweep = (d, re) => {
    if (!fs.existsSync(d)) return;
    const files = fs.readdirSync(d).filter((f) => re.test(f)).sort();
    for (const f of files.slice(0, Math.max(0, files.length - keep))) {
      fs.unlinkSync(path.join(d, f));
      removed++;
    }
  };
  sweep(dir, /^deerhunter-.*\.json$/);
  sweep(path.join(dir, 'csv'), /^sits-.*\.csv$/);
  sweep(path.join(dir, 'csv'), /^sightings-.*\.csv$/);
  return removed;
}

/** Most recent backup on disk, or null. */
export function latestBackup(dir = BACKUP_DIR) {
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir).filter((f) => /^deerhunter-.*\.json$/.test(f)).sort();
  if (!files.length) return null;
  const p = path.join(dir, files.at(-1));
  const { size, mtime } = fs.statSync(p);
  return { path: p, name: files.at(-1), bytes: size, at: mtime.toISOString(), count: files.length };
}
