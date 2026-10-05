// SQLite store. Structured, queryable data lives here; the map and the weights live
// in JSON because they are small, hand-editable, and diff nicely in git.
//
// The table that matters most is sit_snapshots. Ben records four things after a hunt
// (date, slot, stand, saw deer); the tool attaches the conditions itself from its own
// weather history. That is what makes reweighting honest later: nobody is reconstructing
// "was it windy that morning?" from memory in March.

import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { DATA_DIR } from './config.js';

let db;

export function getDb() {
  if (db) return db;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  db = new Database(path.join(DATA_DIR, 'deerhunter.db'));
  db.pragma('journal_mode = WAL');
  migrate(db);
  return db;
}

function migrate(d) {
  d.exec(`
    -- One row per hunt. Kept deliberately short to fill in: everything else is attached automatically.
    CREATE TABLE IF NOT EXISTS sits (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      date          TEXT NOT NULL,              -- YYYY-MM-DD, local
      slot          TEXT NOT NULL CHECK (slot IN ('AM','PM')),
      stand_id      TEXT,                       -- map.json point id; nullable for a walk/still hunt
      stand_label   TEXT,                       -- denormalized so history survives a stand being deleted
      saw_deer      INTEGER NOT NULL DEFAULT 0,
      deer_count    INTEGER NOT NULL DEFAULT 0,
      buck_count    INTEGER NOT NULL DEFAULT 0, -- feeds the buck-score half of reweighting
      notes         TEXT,
      season        TEXT,                       -- e.g. '2026-27', for season-over-season comparison
      created_at    TEXT NOT NULL,
      UNIQUE (date, slot, stand_id)
    );

    -- Conditions as they actually were for that slot, snapshotted at log time from the
    -- tool's own weather history rather than asked of the hunter.
    CREATE TABLE IF NOT EXISTS sit_snapshots (
      sit_id        INTEGER PRIMARY KEY REFERENCES sits(id) ON DELETE CASCADE,
      factors_json  TEXT NOT NULL,   -- normalized per-factor effect values, -1..1
      raw_json      TEXT NOT NULL,   -- human-readable conditions (temp, wind, rain, moon, rut offset)
      buck_score    REAL,            -- what the tool predicted for this slot
      general_score REAL,
      source        TEXT,            -- 'observation' | 'forecast' | 'climatology'
      created_at    TEXT NOT NULL
    );

    -- Weather per day/slot. Written forward from the forecast and then overwritten
    -- with real observations once the day has passed, so snapshots settle on actuals.
    CREATE TABLE IF NOT EXISTS weather (
      date          TEXT NOT NULL,
      slot          TEXT NOT NULL CHECK (slot IN ('AM','PM')),
      source        TEXT NOT NULL,   -- 'observation' | 'forecast' | 'climatology'
      temp_f        REAL,
      temp_normal_f REAL,
      wind_mph      REAL,
      wind_dir_deg  REAL,
      precip_prob   REAL,            -- 0-100
      precip_mm     REAL,
      sky_cover     REAL,            -- 0-100
      pressure_pa   REAL,
      pressure_trend_pa REAL,        -- change over the preceding ~6h; null when unknown
      humidity      REAL,
      fetched_at    TEXT NOT NULL,
      PRIMARY KEY (date, slot)
    );

    -- Computed scores, kept so the calendar renders instantly and so the annual review
    -- can compare what was predicted against what Ben actually saw.
    CREATE TABLE IF NOT EXISTS scores (
      date          TEXT NOT NULL,
      slot          TEXT NOT NULL CHECK (slot IN ('AM','PM')),
      buck_score    REAL NOT NULL,
      general_score REAL NOT NULL,
      rut_offset    INTEGER,
      rut_phase     TEXT,
      confidence    TEXT,            -- 'forecast' | 'outlook' | 'climatology'
      factors_json  TEXT,            -- per-factor effect and contribution, for the "why" panel
      stands_json   TEXT,            -- per-stand scent verdict and stand-adjusted scores
      computed_at   TEXT NOT NULL,
      PRIMARY KEY (date, slot)
    );

    -- Days Ben can actually hunt. A 9.4 on a Tuesday he cannot take off is trivia.
    CREATE TABLE IF NOT EXISTS availability (
      date          TEXT PRIMARY KEY,
      am            INTEGER NOT NULL DEFAULT 0,
      pm            INTEGER NOT NULL DEFAULT 0,
      note          TEXT,
      updated_at    TEXT NOT NULL
    );

    -- Audit trail for the reweighting system. Nothing changes the model silently.
    CREATE TABLE IF NOT EXISTS weight_adjustments (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      factor        TEXT NOT NULL,
      target        TEXT NOT NULL CHECK (target IN ('buck','general')),
      prior_weight  REAL NOT NULL,
      old_weight    REAL NOT NULL,
      new_weight    REAL NOT NULL,
      fitted_delta  REAL,
      shrinkage     REAL,
      sample_n      INTEGER,
      rate_high     REAL,
      rate_low      REAL,
      clipped       INTEGER NOT NULL DEFAULT 0,
      season        TEXT,
      reason        TEXT,
      created_at    TEXT NOT NULL
    );

    -- Alert dedupe, so a high Saturday does not get announced every morning for a week.
    CREATE TABLE IF NOT EXISTS alerts_sent (
      key           TEXT PRIMARY KEY,  -- date|slot|kind
      date          TEXT NOT NULL,
      slot          TEXT NOT NULL,
      kind          TEXT NOT NULL,     -- 'buck' | 'general'
      score         REAL NOT NULL,
      sent_at       TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_sits_date ON sits(date);
    CREATE INDEX IF NOT EXISTS idx_sits_stand ON sits(stand_id);
    CREATE INDEX IF NOT EXISTS idx_sits_season ON sits(season);
    CREATE INDEX IF NOT EXISTS idx_scores_date ON scores(date);
  `);

  addColumns(d);
}

// Additive migrations. SQLite has no "ADD COLUMN IF NOT EXISTS", so each is attempted and
// a duplicate-column error is the success case on an already-migrated database.
function addColumns(d) {
  const cols = [
    // Sit windows are four hours now, so weather is aggregated across the window rather
    // than sampled at one instant.
    ['weather', 'window_start TEXT'],
    ['weather', 'window_end TEXT'],
    ['weather', 'temp_min_f REAL'],
    ['weather', 'temp_max_f REAL'],
    // Wind trustworthiness. Direction alone was being treated as authoritative at 1 mph.
    ['weather', 'gust_mph REAL'],
    ['weather', 'wind_steadiness REAL'],
    ['weather', 'wind_confidence REAL'],
    ['weather', 'wind_confidence_label TEXT'],
    // Real barometric pressure, in hPa from Open-Meteo. The old pressure_pa column was
    // fed from the NWS gridpoint series, which is unitless and was never usable.
    ['weather', 'pressure_hpa REAL'],
    ['weather', 'pressure_delta_window REAL'],
    ['weather', 'pressure_change_24h REAL'],
    // Weather derivatives: what changed, not just what it is.
    ['weather', 'temp_change_24h REAL'],
    ['weather', 'temp_change_48h REAL'],
    ['weather', 'precip_in REAL'],
    ['weather', 'hours_since_rain REAL'],
  ];
  for (const [table, def] of cols) {
    try { d.exec(`ALTER TABLE ${table} ADD COLUMN ${def}`); }
    catch (err) { if (!/duplicate column/i.test(err.message)) throw err; }
  }

}

export function close() {
  if (db) { db.close(); db = undefined; }
}
