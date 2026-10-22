// Score calibration.
//
// The raw weighted sum lands wherever the rut curve and the factor weights put it, and
// where that is depends on the property. A place with food and water inside 150 yards
// of every stand really does sit higher than one where the nearest water is half a mile
// off. Rather than fudge weights until the numbers look nice, this measures the raw
// range the property actually produces and fits an affine map onto the 0-10 scale.
//
// Method: simulate every AM and PM slot of the season against a spread of plausible
// weather drawn from the site's own climate normals and a spread of hunting-pressure
// states, collect the raw scores, then solve offset and gain so the 5th percentile
// lands at targetLow and the 95th at targetHigh. Percentiles rather than min/max,
// because one freak 70-degree rainy December evening should not compress the scale.
//
// Calibration never changes how days RANK. It changes what the numbers look like.

import { scoreSlot } from './scoring.js';
import { climatologyFor, normalFor } from './nws.js';
import { dateRange, addDays } from './timeutil.js';
import { distanceToFeatureYards } from './geo.js';

// Weather archetypes, weighted to roughly mirror a Piedmont late-fall season: mostly
// ordinary days, a minority of fronts, rain and warm spells.
//
// dTemp is departure from normal; tempChg is the 24-hour change, and dPress the 24-hour
// pressure change in hPa. Those last two have to be here: without them the sweep measures
// a model missing two factors that the real forecast days do carry, and every forecast
// day would then score outside the range the calibration was fit to.
const ARCHETYPES = [
  { key: 'normal',      w: 4, dTemp:   0, tempChg:   0, dPress:  0,   wind:  7, precipProb: 10, sky: 45 },
  { key: 'cold-clear',  w: 3, dTemp: -12, tempChg:  -8, dPress: +3,   wind:  9, precipProb:  5, sky: 15 },
  { key: 'warm',        w: 3, dTemp: +10, tempChg:  +6, dPress: -1,   wind:  5, precipProb: 10, sky: 35 },
  { key: 'overcast',    w: 2, dTemp:  -2, tempChg:  -1, dPress: -2,   wind:  8, precipProb: 30, sky: 90 },
  { key: 'rain',        w: 2, dTemp:  +4, tempChg:  +2, dPress: -4,   wind:  6, precipProb: 85, sky: 95, precipMm: 6 },
  { key: 'windy-rain',  w: 1, dTemp:  +2, tempChg:   0, dPress: -5,   wind: 22, precipProb: 80, sky: 92, precipMm: 5 },
  { key: 'windy-dry',   w: 1, dTemp:  -6, tempChg:  -9, dPress: +4,   wind: 20, precipProb:  5, sky: 30 },
  { key: 'hard-front',  w: 1, dTemp: -18, tempChg: -16, dPress: +6,   wind: 14, precipProb: 15, sky: 25 },
  { key: 'pre-front',   w: 2, dTemp:  +6, tempChg:  +3, dPress: -7,   wind: 12, precipProb: 45, sky: 80 },
];

// Hunting pressure is a real in-season driver, so the sweep varies it rather than
// holding every stand at never-hunted. Without this the calibration measures only
// weather variance and reports a flatter model than the one Ben will actually use.
// Values are days since the stand was last sat; null means untouched.
const PRESSURE_STATES = [null, 1, 3, 6, 12];

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const i = (sorted.length - 1) * p;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

export function collectRawScores({ cfg, scoring, map, lastHuntedByStand = null }) {
  const dates = dateRange(cfg.season.start, cfg.season.end);
  const stands = map.points.filter((p) => p.type === 'stand');
  const buck = [];
  const general = [];

  // When the caller pins a real last-hunted map, use it. Otherwise sweep the pressure
  // states, rebuilt relative to each calendar day so "3 days ago" stays 3 days ago in
  // December rather than decaying into "50 days ago".
  const sweep = lastHuntedByStand
    ? [() => lastHuntedByStand]
    : PRESSURE_STATES.map((days) => (date) => (
        days == null ? {} : Object.fromEntries(stands.map((s) => [s.id, addDays(date, -days)]))
      ));

  for (const date of dates) {
    if (!normalFor(date)) continue;
    for (const slot of ['AM', 'PM']) {
      const climo = climatologyFor(date, slot);
      for (const a of ARCHETYPES) {
        const wx = {
          source: 'climatology',
          tempF: climo.tempF + a.dTemp,
          tempNormalF: climo.tempF,
          tempChange24h: a.tempChg ?? null,
          pressureChange24h: a.dPress ?? null,
          windMph: a.wind,
          windDirDeg: 270,
          precipProb: a.precipProb,
          precipMm: a.precipMm ?? null,
          skyCover: a.sky,
        };
        for (const makeHunted of sweep) {
          const r = scoreSlot({ date, slot, wx, cfg, scoring, map, lastHuntedByStand: makeHunted(date) });
          for (let i = 0; i < a.w; i++) { buck.push(r.buck.raw); general.push(r.general.raw); }
        }
      }
    }
  }
  return { buck: buck.sort((x, y) => x - y), general: general.sort((x, y) => x - y) };
}

function fit(sorted, targetLow, targetHigh, pLow, pHigh, maxGain = 2.0) {
  const lo = percentile(sorted, pLow);
  const hi = percentile(sorted, pHigh);

  if (hi - lo < 0.25) {
    // Degenerate spread: almost certainly an empty map, where every resource factor
    // returns a neutral zero and only the rut curve moves. Leave it alone rather than
    // multiplying noise up into a fake 0-10 range.
    return { offset: 0, gain: 1, degenerate: true, warning: 'Raw scores barely vary. This usually means the map has no stands, food or water marked yet, so only the rut curve is moving. Calibration left at identity.', p05: +lo.toFixed(2), p95: +hi.toFixed(2), rawSpread: +(hi - lo).toFixed(2) };
  }

  // A large gain means the model barely discriminates and calibration would be stretching
  // a narrow band across the whole scale, making small differences look decisive. Cap it
  // rather than amplify: a compressed visible range is the honest rendering of a score
  // that genuinely does not vary much on this property.
  const wanted = (targetHigh - targetLow) / (hi - lo);
  const capped = wanted > maxGain;
  const gain = capped ? maxGain : wanted;
  const offset = targetLow / gain - lo;

  const warning = capped
    ? `Raw 5th-95th spread is only ${(hi - lo).toFixed(2)} points, so a full-scale fit would need a gain of ${wanted.toFixed(2)}. Capped at ${maxGain}, which means this score will use roughly ${((hi - lo) * maxGain).toFixed(1)} of the 10-point scale rather than all of it. That is not a bug: it says this score does not vary much here. It usually means a factor has saturated — for example food and water sitting close to every stand, so proximity stops separating them and only weather and pressure move the number.`
    : null;

  return {
    offset: +offset.toFixed(4),
    gain: +gain.toFixed(4),
    degenerate: false,
    capped,
    wantedGain: +wanted.toFixed(4),
    warning,
    p05: +lo.toFixed(2),
    p95: +hi.toFixed(2),
    rawSpread: +(hi - lo).toFixed(2),
  };
}

/**
 * Fit the food and water proximity curves to THIS property's distances.
 *
 * The thresholds shipped as absolute guesses - full credit inside 60 yards of food, 80 of
 * water - and absolute guesses cannot discriminate on a property whose numbers happen to
 * sit on one side of them. Measured here, two stands 13 and 38 yards from water both
 * scored a flat +1 and the factor told you nothing about which to sit.
 *
 * So the curve is anchored on the property's own spread: the nearest stand earns full
 * credit, the median sits at neutral, and the far end runs past the worst stand so it
 * reads clearly negative without pinning. Guardrails stop a cluster of near-identical
 * distances from being amplified into false distinctions.
 */
export function fitProximity(map) {
  const stands = map.points.filter((p) => p.type === 'stand');
  const foods = map.points.filter((p) => p.type === 'food');
  const waters = map.points.filter((p) => p.type === 'water' && p.active !== false);
  if (stands.length < 2) return null;

  const nearestTo = (feats) => stands
    .map((s) => {
      const ds = feats.map((f) => distanceToFeatureYards(s, f)).filter((v) => v != null);
      return ds.length ? Math.min(...ds) : null;
    })
    .filter((v) => v != null)
    .sort((a, b) => a - b);

  const curve = (ds, fallback) => {
    if (ds.length < 2) return fallback;
    const near = Math.max(15, Math.round(ds[0]));
    const median = ds[Math.floor(ds.length / 2)];
    const mid = Math.max(near + 40, Math.round(median));
    const far = Math.max(mid + 120, Math.round(ds.at(-1) * 1.6));
    // A property whose stands are all within a stone's throw of each other has nothing to
    // separate; stretching that would manufacture a distinction out of noise.
    if (ds.at(-1) - ds[0] < 40) return fallback;
    return { near, mid, far, fittedFrom: ds.map((d) => Math.round(d)) };
  };

  return {
    food: curve(nearestTo(foods), { near: 60, mid: 250, far: 700 }),
    water: curve(nearestTo(waters), { near: 80, mid: 350, far: 900 }),
  };
}

export function calibrate({ cfg, scoring, map, lastHuntedByStand = null, targetLow = 2.0, targetHigh = 9.0, pLow = 0.05, pHigh = 0.95 }) {
  const raw = collectRawScores({ cfg, scoring, map, lastHuntedByStand });
  if (!raw.buck.length) {
    return { buck: { offset: 0, gain: 1 }, general: { offset: 0, gain: 1 }, diagnostics: { error: 'No scoreable days in the configured season range. Check season.start/end and that data/normals-rdu.json covers them.' } };
  }
  const maxGain = scoring.calibrationLimits?.maxGain ?? 2.0;
  const buck = fit(raw.buck, targetLow, targetHigh, pLow, pHigh, maxGain);
  const general = fit(raw.general, targetLow, targetHigh, pLow, pHigh, maxGain);
  return {
    buck: { offset: buck.offset, gain: buck.gain },
    general: { offset: general.offset, gain: general.gain },
    proximity: fitProximity(map),
    diagnostics: {
      buck: { ...buck, n: raw.buck.length, min: +raw.buck[0].toFixed(2), max: +raw.buck.at(-1).toFixed(2) },
      general: { ...general, n: raw.general.length, min: +raw.general[0].toFixed(2), max: +raw.general.at(-1).toFixed(2) },
      targetLow, targetHigh,
      calibratedAt: new Date().toISOString(),
    },
  };
}

// Post-calibration distribution check, so the calibrate command can print what the
// season will actually look like rather than asserting that it worked.
export function distribution({ cfg, scoring, map, lastHuntedByStand = null }) {
  const raw = collectRawScores({ cfg, scoring, map, lastHuntedByStand });
  const apply = (v, cal) => Math.max(0, Math.min(10, (v + cal.offset) * cal.gain));
  const out = {};
  for (const target of ['buck', 'general']) {
    const cal = scoring.calibration?.[target] ?? { offset: 0, gain: 1 };
    const vals = raw[target].map((v) => apply(v, cal)).sort((a, b) => a - b);
    const buckets = new Array(10).fill(0);
    for (const v of vals) buckets[Math.min(9, Math.floor(v))]++;
    out[target] = {
      p05: +percentile(vals, 0.05).toFixed(2),
      p25: +percentile(vals, 0.25).toFixed(2),
      p50: +percentile(vals, 0.5).toFixed(2),
      p75: +percentile(vals, 0.75).toFixed(2),
      p95: +percentile(vals, 0.95).toFixed(2),
      min: +vals[0].toFixed(2),
      max: +vals.at(-1).toFixed(2),
      histogram: buckets,
      n: vals.length,
    };
  }
  return out;
}
