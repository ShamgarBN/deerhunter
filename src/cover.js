// Land cover: woods, field, water, and the edge between them.
//
// Until now the tool had no idea what anything on the property actually was. The aerial
// imagery was a backdrop for Ben's eyes; nothing read a pixel. Every classification was
// one he typed in, so a polygon over a gravel lot labeled Food scored like a bean field.
//
// This adds an actual answer, from NLCD (National Land Cover Database) via the MRLC
// WMS service: free, keyless, 30-metre pixels, verified working against this property on
// 2026-09-19. It is used for CONTEXT and VALIDATION, not scoring. Land cover is not deer
// preference, and giving it weight without evidence would be exactly the folklore-driven
// modeling the rest of this tool avoids.
//
// Two ways a feature gets a cover class, and Ben's answer always wins:
//   manual  - a woods/field area he drew on the map, same precedence rule as safeWinds
//   nlcd    - sampled from the satellite record, cached to disk
//
// Caveats worth remembering: 30 m is about a fifth of an acre, so narrow strips and small
// plots blur into their surroundings; the 2021 vintage misses anything cleared or planted
// since; and it says what grows there, not what deer do there.

import fs from 'fs';
import path from 'path';
import { DATA_DIR } from './config.js';
import { distanceYards, pointInRing } from './geo.js';

const WMS = 'https://www.mrlc.gov/geoserver/mrlc_display/wms';
const LAYER = 'NLCD_2021_Land_Cover_L48';

// NLCD Legend, grouped into what matters for a deer property.
export const NLCD_CLASSES = {
  11: { label: 'Open water',        group: 'water',     deer: 'Water source.' },
  12: { label: 'Perennial ice/snow',group: 'other',     deer: null },
  21: { label: 'Developed, open',   group: 'open',      deer: 'Lawns, road margins, parkland. Edge value, little food.' },
  22: { label: 'Developed, low',    group: 'developed', deer: 'Houses and yards. Pressure, not habitat.' },
  23: { label: 'Developed, medium', group: 'developed', deer: 'Pressure, not habitat.' },
  24: { label: 'Developed, high',   group: 'developed', deer: 'Pressure, not habitat.' },
  31: { label: 'Barren',            group: 'open',      deer: null },
  41: { label: 'Deciduous forest',  group: 'woods',     deer: 'Hardwoods. Mast in a good year, cover year-round.' },
  42: { label: 'Evergreen forest',  group: 'woods',     deer: 'Pines. Thermal cover and bedding, little food.' },
  43: { label: 'Mixed forest',      group: 'woods',     deer: 'Mixed hardwood and pine. Often the best bedding on a Piedmont place.' },
  52: { label: 'Shrub/scrub',       group: 'thick',     deer: 'Cutover or regrowth. Prime bedding and browse.' },
  71: { label: 'Grassland',         group: 'field',     deer: 'Open forage, low cover.' },
  81: { label: 'Pasture/hay',       group: 'field',     deer: 'Grazed or hayed ground. Forage, very little cover.' },
  82: { label: 'Cultivated crops',  group: 'field',     deer: 'Row crops. Heavy draw when standing, bare after harvest.' },
  90: { label: 'Woody wetlands',    group: 'thick',     deer: 'Wet bottom timber. Classic bedding and escape cover.' },
  95: { label: 'Herbaceous wetland',group: 'thick',     deer: 'Marshy. Bedding and escape cover.' },
};

const CACHE_FILE = () => path.join(DATA_DIR, 'cover-cache.json');

function loadCache() {
  try { return JSON.parse(fs.readFileSync(CACHE_FILE(), 'utf8')); } catch { return {}; }
}
function saveCache(c) {
  try { fs.writeFileSync(CACHE_FILE(), `${JSON.stringify(c, null, 1)}\n`); } catch { /* read-only disk */ }
}

// Cache key at roughly 11 m, finer than the 30 m source, so neighbouring samples that
// land in the same pixel still share a lookup.
const key = (lat, lon) => `${lat.toFixed(4)},${lon.toFixed(4)}`;

/**
 * Sample the NLCD class at one coordinate. Returns null on any failure, which every
 * caller treats as "cover unknown" rather than an error: this is enrichment, and the
 * tool has to keep working when MRLC is down.
 */
export async function sampleNlcd(lat, lon, { cache = loadCache(), write = true } = {}) {
  const k = key(lat, lon);
  if (cache[k] !== undefined) return cache[k];

  const d = 0.0004;
  const qs = new URLSearchParams({
    service: 'WMS', version: '1.1.1', request: 'GetFeatureInfo',
    layers: LAYER, query_layers: LAYER, srs: 'EPSG:4326',
    bbox: `${lon - d},${lat - d},${lon + d},${lat + d}`,
    width: '101', height: '101', x: '50', y: '50',
    info_format: 'application/json',
  });

  try {
    const res = await fetch(`${WMS}?${qs}`, { signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error(`MRLC ${res.status}`);
    const j = await res.json();
    const code = j?.features?.[0]?.properties?.PALETTE_INDEX ?? null;
    cache[k] = code;
    if (write) saveCache(cache);
    return code;
  } catch {
    return null;
  }
}

export function describe(code) {
  if (code == null) return null;
  const c = NLCD_CLASSES[code];
  return c ? { code, ...c } : { code, label: `NLCD class ${code}`, group: 'other', deer: null };
}

/**
 * Cover at a point, with Ben's manual woods/field areas taking precedence over NLCD.
 * Same rule as safeWinds: he has walked it, the satellite has not.
 */
export function manualCoverAt(lat, lon, map) {
  const areas = map.points.filter((p) => (p.type === 'woods' || p.type === 'field') && p.shape?.ring?.length >= 3);
  for (const a of areas) {
    if (pointInRing({ lat, lon }, a.shape.ring)) {
      return {
        source: 'manual',
        group: a.type === 'woods' ? 'woods' : 'field',
        label: a.label || (a.type === 'woods' ? 'Woods' : 'Field'),
        id: a.id,
      };
    }
  }
  return null;
}

/**
 * Cover for one stand, plus whether it sits on an edge.
 *
 * Edge habitat is the one land-cover idea with a real basis for deer hunting: the
 * boundary between cover and food is where deer travel and where they stage before
 * committing to open ground. It is detected by sampling a ring of points around the
 * stand and checking whether both a cover group and an open group appear.
 *
 * This is reported, not scored. Giving it weight would need evidence from Ben's own sit
 * log, which is exactly what the reweighting system is for.
 */
export async function coverForStand(stand, map, { radiusYards = 70, samples = 8, cache } = {}) {
  const manual = manualCoverAt(stand.lat, stand.lon, map);
  const centre = manual ?? describe(await sampleNlcd(stand.lat, stand.lon, { cache }));
  if (!centre) return null;

  // Ring of samples about a bowshot out, which is the scale at which an edge matters.
  const dLat = radiusYards / 1215.22;
  const dLon = dLat / Math.cos((stand.lat * Math.PI) / 180);
  const groups = new Set([centre.group]);
  const neighbours = [];

  for (let i = 0; i < samples; i++) {
    const a = (2 * Math.PI * i) / samples;
    const lat = stand.lat + dLat * Math.cos(a);
    const lon = stand.lon + dLon * Math.sin(a);
    const m = manualCoverAt(lat, lon, map);
    const g = m ?? describe(await sampleNlcd(lat, lon, { cache }));
    if (!g) continue;
    groups.add(g.group);
    neighbours.push(g.label);
  }

  const COVER = new Set(['woods', 'thick']);
  const OPEN = new Set(['field', 'open']);
  const hasCover = [...groups].some((g) => COVER.has(g));
  const hasOpen = [...groups].some((g) => OPEN.has(g));

  return {
    ...centre,
    source: centre.source ?? 'nlcd',
    edge: hasCover && hasOpen,
    nearby: [...new Set(neighbours)].filter((n) => n !== centre.label).slice(0, 3),
    groups: [...groups],
  };
}

export async function coverForPoints(points, map) {
  const cache = loadCache();
  const out = {};
  for (const p of points) {
    const manual = manualCoverAt(p.lat, p.lon, map);
    out[p.id] = manual ?? describe(await sampleNlcd(p.lat, p.lon, { cache, write: false }));
  }
  saveCache(cache);
  return out;
}

export const wmsInfo = { url: WMS, layer: LAYER };
