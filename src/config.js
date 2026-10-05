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

// Writes back to config.json only. A webhook that came from config.local.json or the
// environment is stripped first, so a UI settings save can never copy a secret into the
// tracked file.
export function saveConfig(obj) {
  const tracked = JSON.parse(JSON.stringify(obj));
  // `season` is derived from the seasons array at load time. Writing it back would make a
  // stale copy that quietly disagrees with the seasons the user actually edited.
  if (tracked.season?._derived) delete tracked.season;
  const onDisk = readJson(FILES.config);
  const placeholder = onDisk?.discord?.webhookUrl ?? '';
  if (tracked.discord && tracked.discord.webhookUrl !== placeholder) {
    tracked.discord.webhookUrl = placeholder;
  }
  writeJson(FILES.config, tracked);
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
