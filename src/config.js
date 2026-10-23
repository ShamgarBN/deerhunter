// Config loading and persistence. Three JSON files, each with a distinct job:
//   config.json  - runtime settings (location, schedule, alerts, drought, scent geometry)
//   scoring.json - every weight that moves a score, as {prior, current} pairs
//   map.json     - property points and lines
// All three are hand-editable and hot-reloadable; the server re-reads on every request
// rather than caching, because the data is tiny and stale config is a worse bug than a
// few extra file reads.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..');
export const CONFIG_DIR = path.join(ROOT, 'config');
export const DATA_DIR = path.join(ROOT, 'data');

const FILES = {
  config: path.join(CONFIG_DIR, 'config.json'),
  configLocal: path.join(CONFIG_DIR, 'config.local.json'),
  scoring: path.join(CONFIG_DIR, 'scoring.json'),
  map: path.join(CONFIG_DIR, 'map.json'),
};

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// Atomic-ish write: temp file then rename, so a crash mid-write can't leave a
// truncated config that bricks the next start.
function writeJson(file, obj) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(obj, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

// Deep merge, so config.local.json can override a single nested key without having to
// restate the whole block it lives in.
function merge(base, over) {
  if (!over || typeof over !== 'object' || Array.isArray(over)) return over ?? base;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) {
    out[k] = (v && typeof v === 'object' && !Array.isArray(v) && base?.[k] && typeof base[k] === 'object')
      ? merge(base[k], v)
      : v;
  }
  return out;
}

/**
 * Config, with secrets kept out of the tracked file.
 *
 * config.json is committed and carries everything worth version-controlling: season
 * dates, thresholds, drought severity, scent geometry. Anything that is a credential
 * lives in config.local.json, which is gitignored, or in an environment variable.
 *
 * Precedence, lowest to highest: config.json, config.local.json, environment.
 *
 * The Discord webhook is the one that matters. It is a bearer credential: anyone holding
 * the URL can post to that channel, and committing it to a repository publishes it to
 * everyone with read access, permanently, even if a later commit removes it.
 */
export function loadConfig() {
  let cfg = readJson(FILES.config);
  if (fs.existsSync(FILES.configLocal)) cfg = merge(cfg, readJson(FILES.configLocal));

  const envHook = process.env.DEERHUNTER_DISCORD_WEBHOOK;
  if (envHook) cfg.discord = { ...cfg.discord, webhookUrl: envHook };

  // Installs predating user-defined seasons carry a single `season` object. Fold it into
  // the seasons array in memory so nothing has to be hand-edited to keep working.
  if (!Array.isArray(cfg.seasons) || !cfg.seasons.length) {
    const migrated = legacySeasons(cfg);
    if (migrated) cfg.seasons = migrated;
  }

  // A good deal of code wants "the span being scored". Derive it rather than making every
  // caller reason about overlapping ranges.
  const spans = (cfg.seasons ?? []).filter((s) => s.enabled !== false && s.start && s.end);
  if (spans.length) {
    cfg.season = {
      ...(cfg.season ?? {}),
      start: spans.reduce((a, s) => (s.start < a ? s.start : a), spans[0].start),
      end: spans.reduce((a, s) => (s.end > a ? s.end : a), spans[0].end),
      label: cfg.season?.label ?? spans.map((s) => s.label).join(' / '),
      _derived: true,
    };
  }

  return cfg;
}

// Inlined rather than imported from seasons.js to keep config.js dependency-free: every
// other module imports config, so an import the other way would be a cycle.
function legacySeasons(cfg) {
  const old = cfg.season;
  if (!old?.start) return null;
  const mk = (label, weapon, start, end, color) => ({ id: label.toLowerCase(), label, weapon, start, end, color, enabled: true, notes: '' });
  const out = [];
  if (old.archery?.start) out.push(mk('Archery', 'archery', old.archery.start, old.archery.end, '#16c784'));
  if (old.blackpowder?.start) out.push(mk('Blackpowder', 'muzzleloader', old.blackpowder.start, old.blackpowder.end, '#f0b429'));
  out.push(mk(old.label || 'Gun', 'rifle', old.start, old.end, '#5ac8fa'));
  return out;
}
export const loadScoring = () => readJson(FILES.scoring);
// A fresh checkout has no map.json: it is gitignored, because it holds exact coordinates
// for stands, bedding and food. Seed it from the tracked example on first load.
export function loadMap() {
  if (!fs.existsSync(FILES.map)) {
    const example = path.join(CONFIG_DIR, 'map.example.json');
    if (fs.existsSync(example)) fs.copyFileSync(example, FILES.map);
  }
  return readJson(FILES.map);
}

/**
 * Runtime writes go to config.local.json, never to the tracked config.json.
 *
 * config.json is a TEMPLATE: shipped defaults, committed, shared. config.local.json is
 * this install. Anything the running app changes - drought severity, seasons edited in
 * the UI, alert thresholds - is by definition this install, so writing it to the tracked
 * file was wrong twice over.
 *
 * It was also silently broken. config.local.json is merged OVER config.json at load, so
 * a value present in local shadowed whatever a save wrote to the tracked file. The
 * automatic drought update wrote 0.749 to config.json, local still said 0.75 from
 * September, and the load merge handed back the stale number with no error anywhere.
 *
 * Only the DIFF against config.json is stored, so local stays small and readable and the
 * tracked defaults keep meaning something.
 */
function diffAgainst(base, next) {
  const out = {};
  for (const [k, v] of Object.entries(next)) {
    if (k.startsWith('_')) continue;
    if (JSON.stringify(base?.[k]) !== JSON.stringify(v)) out[k] = v;
  }
  return out;
}

export function saveConfig(obj) {
  const next = JSON.parse(JSON.stringify(obj));

  // `season` is derived from the seasons array at load. Persisting it would create a
  // stale copy that quietly disagrees with the seasons actually edited.
  if (next.season?._derived) delete next.season;

  // A webhook that arrived from the environment is not ours to write down.
  if (process.env.DEERHUNTER_DISCORD_WEBHOOK && next.discord) {
    const existing = fs.existsSync(FILES.configLocal) ? readJson(FILES.configLocal) : {};
    next.discord = { ...next.discord, webhookUrl: existing.discord?.webhookUrl ?? '' };
  }

  const base = readJson(FILES.config);
  const local = fs.existsSync(FILES.configLocal) ? readJson(FILES.configLocal) : {};
  const changes = diffAgainst(base, next);

  const merged = {
    _comment: local._comment
      ?? 'Your property, your secrets, your machine. Gitignored and deep-merged over config.json at load. Never commit this file.',
    ...local,
    ...changes,
  };

  // Drop any override that has gone back to its config.json value.
  //
  // Without this, local overrides are write-only. `changes` holds just the keys that
  // differ from base, so setting one BACK to its default produces no entry, the stale
  // copy survives in `...local`, and it keeps winning the deep merge at load. The change
  // appears to save and then reads back as the old value, with nothing reporting an
  // error. Every caller passes a fully merged config, so a key absent from `changes`
  // genuinely means "same as base" rather than "not supplied".
  for (const k of Object.keys(base)) {
    if (k.startsWith('_')) continue;
    if (!(k in changes)) delete merged[k];
  }

  writeJson(FILES.configLocal, merged);
}

export const saveScoring = (obj) => writeJson(FILES.scoring, obj);
export const saveMap = (obj) => writeJson(FILES.map, obj);

// Normals file is configurable so each install can carry its own. Falls back across the
// names setup and the NOAA importer write, so an existing install keeps working.
export function loadNormals() {
  let configured = null;
  try { configured = loadConfig()?.climate?.normalsFile ?? null; } catch { configured = null; }
  const candidates = [configured, 'normals.json', 'normals-rdu.json'].filter(Boolean);
  for (const name of candidates) {
    const p = path.join(DATA_DIR, name);
    if (fs.existsSync(p)) return readJson(p);
  }
  return null;
}

export function loadAll() {
  return { config: loadConfig(), scoring: loadScoring(), map: loadMap() };
}
