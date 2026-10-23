// Two scores, never one.
//
//   buckScore    - how likely a mature, rut-influenced buck is moving in daylight.
//                  Driven primarily by rut phase.
//   generalScore - how likely you see a deer at all, any age or sex. Driven more by
//                  food, water, pressure and weather than by rut phase.
//
// Both are shown side by side every day. Which one matters on a given sit is Ben's
// call, and the tool does not collapse them into one "hunt rating" that hides the
// tradeoff. A 8.4/3.9 day (lockdown, chasing week, no food) and a 4.1/7.2 day (late
// December on a green field) are both good days, for completely different hunts.
//
// STRUCTURE: every factor produces a normalized effect in [-1, 1], which is multiplied
// by its current_weight from scoring.json to yield a contribution in score points.
// Nothing here contains a magic number that is not traceable to config. That is a hard
// requirement, because the reweighting system has to be able to move any weight
// independently without anyone editing this file.

import { rutFor } from './rut.js';
import { sunMoonFor } from './astro.js';
import { distanceToFeatureYards } from './geo.js';
import { daysBetween } from './timeutil.js';

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// Soft-knee compression at the ends of the 0-10 scale.
//
// A hard clamp destroys information exactly where it is most interesting: during chasing
// week four different stands all pinned at "10.0" and the ordering between them was gone.
// Above the high knee the remaining headroom is allocated through tanh, which is
// monotonic, so two days never swap places. Only the spacing between them changes, and
// only near the extremes. Below the low knee the same curve runs in reverse.
function softScale(v, scale) {
  const { min, max } = scale;
  const hi = scale.softKneeHigh ?? max;
  const lo = scale.softKneeLow ?? min;
  if (v > hi && max > hi) return hi + (max - hi) * Math.tanh((v - hi) / (max - hi));
  if (v < lo && lo > min) return lo - (lo - min) * Math.tanh((lo - v) / (lo - min));
  return clamp(v, min, max);
}

// --- individual factor effects ---------------------------------------------

// Precipitation, modeled jointly with wind speed.
//
// Penn State collar work: bucks cut movement roughly in half on rainy days, does did
// not show the same response. The same research found strong wind increases buck
// movement regardless of rain. So rain alone is not the input; rain AND wind is.
// At high wind the suppression cancels and tips slightly positive, which is also why
// a windy dry day scores a touch above a calm dry one. That small positive lives
// inside this factor deliberately, so wind is one tunable thing rather than two.
function precipitationEffect(wx, scoring) {
  const { cancelStartMph, cancelFullMph, reversalMax } = scoring.windRainInteraction;

  // Probability is the reliable signal out to 7 days; measured amount only reaches
  // ~4 days but sharpens the estimate when present.
  let intensity = wx.precipProb == null ? 0 : clamp(wx.precipProb / 100, 0, 1);
  if (wx.precipMm != null && wx.precipMm > 0) {
    intensity = clamp(Math.max(intensity, 0.35 + Math.min(wx.precipMm / 8, 0.65)), 0, 1);
  }

  const wind = wx.windMph ?? 0;
  const cancel = clamp((wind - cancelStartMph) / (cancelFullMph - cancelStartMph), 0, 1);

  const effect = -intensity * (1 - cancel) + cancel * reversalMax;
  return {
    effect: clamp(effect, -1, 1),
    detail: {
      intensity: +intensity.toFixed(2),
      windMph: wind == null ? null : +wind.toFixed(0),
      windCancel: +cancel.toFixed(2),
      available: wx.precipProb != null,
    },
  };
}

// Days since this stand was last hunted. Approaches +1 asymptotically, so the
// difference between 14 and 21 days off is small, which matches how pattern-avoidance
// actually decays.
function pressureEffect(daysSince, recoveryDays = 3) {
  // Never hunted caps at +0.85 rather than +1. At the season opener every stand is
  // untouched, so a full +1 would hand every slot in November a constant bonus that
  // discriminates nothing.
  //
  // recoveryDays is the half-recovery point: the rest after which a stand has given back
  // half the penalty, i.e. where the curve crosses zero. An Oklahoma GPS study had bucks
  // cutting movement as soon as hunters arrived, staying down through the hunt, and
  // beginning to recover about three days later, so that is the default. The time
  // constant is derived from it rather than written as a magic divisor, so changing the
  // number here moves the curve the way you would expect.
  if (daysSince == null) return { effect: 0.85, detail: { daysSince: null, neverHunted: true } };
  const tau = Math.max(0.25, recoveryDays) / Math.LN2;
  const effect = 2 * (1 - Math.exp(-daysSince / tau)) - 1;
  return { effect: clamp(effect, -1, 1), detail: { daysSince, neverHunted: false, recoveryDays } };
}

// Distance-to-resource falloff. near => +1, far => -1, with the midpoint at zero.
function proximityEffect(distYards, near, mid, far) {
  if (distYards == null) return { effect: 0, detail: { distanceYards: null, unmarked: true } };
  let effect;
  if (distYards <= near) effect = 1;
  else if (distYards <= mid) effect = 1 - (distYards - near) / (mid - near);
  else effect = -clamp((distYards - mid) / (far - mid), 0, 1);
  return { effect: clamp(effect, -1, 1), detail: { distanceYards: Math.round(distYards), unmarked: false } };
}

// Colder than normal reads positive, warmer negative. Capped so a once-a-decade
// arctic outbreak does not produce a 14-point day.
function tempEffect(tempF, normalF) {
  if (tempF == null || normalF == null) return { effect: 0, detail: { departureF: null, available: false } };
  const departure = tempF - normalF;
  return {
    effect: clamp(-departure / 12, -1, 1),
    detail: { tempF: +tempF.toFixed(0), normalF: +normalF.toFixed(0), departureF: +departure.toFixed(1), available: true },
  };
}

// Temperature CHANGE, distinct from departure from normal.
//
// Departure asks "is today warm for November". This asks "did it just get colder", which
// is the question hunters actually act on: a 45F morning can be both above normal and
// fifteen degrees colder than yesterday, and those two facts pull the score in opposite
// directions. A drop reads positive.
function tempChangeEffect(deltaF, scoring) {
  if (deltaF == null) return { effect: 0, detail: { deltaF: null, available: false } };
  const full = scoring.weatherDerivatives?.tempDropFullEffectF ?? 15;
  return {
    effect: clamp(-deltaF / full, -1, 1),
    detail: {
      deltaF: +deltaF.toFixed(1),
      direction: deltaF <= -2 ? 'falling' : deltaF >= 2 ? 'rising' : 'steady',
      available: true,
    },
  };
}

// Falling barometer reads positive. Real hPa now: this factor spent the first build
// contributing nothing in every slot, because it was wired to the NWS gridpoint pressure
// series, which is unitless. The research caution still stands - pressure largely tracks
// temperature rather than acting on its own - so the weight stays modest and this will
// partly double-count the temperature-change factor until reweighting separates them.
function pressureTrendEffect(deltaHpa, scoring) {
  if (deltaHpa == null) return { effect: 0, detail: { deltaHpa: null, available: false } };
  const full = scoring.weatherDerivatives?.pressureDropFullEffectHpa ?? 6;
  return {
    effect: clamp(-deltaHpa / full, -1, 1),
    detail: {
      deltaHpa: +deltaHpa.toFixed(2),
      deltaInHg: +(deltaHpa * 0.02953).toFixed(3),
      direction: deltaHpa <= -1 ? 'falling' : deltaHpa >= 1 ? 'rising' : 'steady',
      available: true,
    },
  };
}

/**
 * Frontal passage: the conjunction, not the ingredients.
 *
 * tempChange24h and pressureTrend each see one half of a front and neither sees a front.
 * Worse, they disagree about the state hunters actually rate most highly: the clear, cold
 * morning after a low has moved through has a RISING barometer, which pressureTrend scores
 * as a negative. This factor exists to name that state directly rather than leaving it to
 * be cancelled out by two factors arguing.
 *
 * Two shapes are recognised:
 *   post-frontal  colder than yesterday AND barometer recovering AND sky clearing
 *   pre-frontal   barometer dropping hard while it is still mild (feeding ahead of weather)
 *
 * The post-frontal case requires BOTH the cold and the recovery, multiplied rather than
 * added, so a merely cold day or a merely rising barometer scores nothing. That is the
 * whole point of a composite: either ingredient alone is already covered elsewhere.
 *
 * This factor is ONE-SIDED, 0 to 1, and never goes negative. The absence of a front is
 * ordinary weather, not a penalty, and there is no such thing as an anti-front. Do not
 * "fix" it to be symmetric like the others. Calibration absorbs the baseline shift.
 *
 * The prior is deliberately modest and flagged as a reweight candidate: the pre-frontal
 * half rests mostly on hunter consensus, and it necessarily overlaps the two factors it
 * was built from. Let the sit log settle how much of the credit belongs here.
 */
function frontalEffect(wx, scoring) {
  const f = scoring.frontal ?? {};
  const dT = wx.tempChange24h;
  const dP = wx.pressureChange24h;
  if (dT == null || dP == null) return { effect: 0, detail: { available: false, shape: 'unknown' } };

  const dropF = f.tempDropFullF ?? 12;
  const riseHpa = f.pressureRiseFullHpa ?? 5;
  const fallHpa = f.pressureFallFullHpa ?? 5;

  const cold = clamp(-dT / dropF, 0, 1);
  const rising = clamp(dP / riseHpa, 0, 1);
  // An unknown sky is treated as half-clear rather than as a reason to zero the factor:
  // past the forecast horizon sky cover is missing for every slot, and the temperature
  // and pressure halves are still real.
  const clearing = wx.skyCover == null ? 0.5 : clamp((60 - wx.skyCover) / 60, 0, 1);
  const post = cold * rising * (0.6 + 0.4 * clearing);

  const falling = clamp(-dP / fallHpa, 0, 1);
  const stillMild = clamp(1 - Math.abs(dT) / dropF, 0, 1);
  const pre = (f.preFrontalCeiling ?? 0.45) * falling * stillMild;

  const effect = clamp(Math.max(post, pre), 0, 1);
  const shape = effect < 0.05 ? 'none' : post >= pre ? 'post-frontal' : 'pre-frontal';
  return {
    effect,
    detail: {
      available: true,
      shape,
      tempChangeF: +dT.toFixed(1),
      pressureChangeHpa: +dP.toFixed(2),
      skyCover: wx.skyCover == null ? null : Math.round(wx.skyCover),
      post: +post.toFixed(3),
      pre: +pre.toFixed(3),
    },
  };
}

// Overcast extends usable low light at the edges of legal shooting time. Because the
// forecast is sampled at the slot center (45 min after sunrise, 75 min before sunset)
// rather than at noon, this is measuring cloud during the window that matters.
function cloudEffect(skyCover) {
  if (skyCover == null) return { effect: 0, detail: { skyCover: null, available: false } };
  return { effect: clamp((skyCover - 50) / 50, -1, 1), detail: { skyCover: Math.round(skyCover), available: true } };
}

// Computed so the number appears in the "why" panel alongside everything else, and
// weighted ZERO in scoring.json. The sign below is unfalsifiable at weight zero and is
// only there so a future reweighting pass has a consistent direction to fit against.
function moonEffect(illumPct) {
  if (illumPct == null) return { effect: 0, detail: { illumination: null } };
  return { effect: clamp((illumPct - 50) / 50, -1, 1), detail: { illumination: illumPct, scored: false } };
}

// --- weight resolution ------------------------------------------------------

export function effectiveWeight(scoring, cfg, factorKey, target) {
  const f = scoring.factors[factorKey];
  if (!f) return 0;
  let w = f[target].current;
  if (f.droughtScaled) w *= 1 + scoring.droughtBoost * (cfg.drought?.severity ?? 0);
  return w;
}

// --- the main entry point ---------------------------------------------------

/**
 * Score one date/slot.
 *
 * @param {object} args
 *   date, slot ('AM'|'PM'), wx (weather row), cfg, scoring, map,
 *   lastHuntedByStand: { [standId]: 'YYYY-MM-DD' | null }
 */
export function scoreSlot({ date, slot, wx, cfg, scoring, map, lastHuntedByStand = {} }) {
  const rut = rutFor(date, scoring);
  const astro = sunMoonFor(date, cfg.property.lat, cfg.property.lon, cfg.property.timezone);

  const stands = map.points.filter((p) => p.type === 'stand');
  const foods = map.points.filter((p) => p.type === 'food');
  const waters = map.points.filter((p) => p.type === 'water' && p.active !== false);

  // Per-stand resource distances and pressure. The day-level score uses the BEST stand
  // available, because the decision being made is "is this slot worth hunting at all",
  // and that question is answered by your best option, not by the average of every
  // stand including the one you will not sit.
  const perStand = stands.map((s) => {
    // distanceToFeatureYards handles both shapes: nearest edge for a drawn area (zero if
    // the stand is inside it), straight-line distance for a dropped pin. Measuring a field
    // to its centroid understates a stand on the field edge by roughly half.
    const fd = foods.map((f) => distanceToFeatureYards(s, f)).filter((v) => v != null);
    const wd = waters.map((w) => distanceToFeatureYards(s, w)).filter((v) => v != null);
    const foodDist = fd.length ? Math.min(...fd) : null;
    const waterDist = wd.length ? Math.min(...wd) : null;
    const last = lastHuntedByStand[s.id] ?? null;
    return {
      stand: s,
      foodDist,
      waterDist,
      daysSinceHunted: last ? daysBetween(last, date) : null,
    };
  });

  const shared = {
    precipitation: precipitationEffect(wx, scoring),
    tempDeparture: tempEffect(wx.tempF, wx.tempNormalF),
    tempChange24h: tempChangeEffect(wx.tempChange24h, scoring),
    pressureTrend: pressureTrendEffect(wx.pressureChange24h, scoring),
    frontalPassage: frontalEffect(wx, scoring),
    cloudCover: cloudEffect(wx.skyCover),
    moonIllumination: moonEffect(astro.moon.illumination),
  };

  // Proximity curves are fitted to the property's own distances by `npm run score --
  // calibrate` (see fitProximity), falling back to the shipped defaults when there are too
  // few stands or they sit too close together to separate.
  //
  // Absolute thresholds alone cannot discriminate: on a property where two stands sit 13
  // and 38 yards from water, a curve giving full credit inside 80 yards scores both a
  // flat +1 and tells you nothing about which to sit.
  const fc = scoring.proximityCurves?.food ?? { near: 60, mid: 250, far: 700 };
  const wc = scoring.proximityCurves?.water ?? { near: 80, mid: 350, far: 900 };
  const buildFactors = (foodDist, waterDist, daysSince) => ({
    ...shared,
    huntingPressure: pressureEffect(daysSince, scoring.pressureRecoveryDays ?? 3),
    foodProximity: proximityEffect(foodDist, fc.near, fc.mid, fc.far),
    waterProximity: proximityEffect(waterDist, wc.near, wc.mid, wc.far),
  });

  const assemble = (factors, target) => {
    const phaseKey = scoring.rutCurve.phases.some((p) => p.key === rut.phase) ? rut.phase : 'default';
    const tod = scoring.timeOfDay[phaseKey] ?? scoring.timeOfDay.default;
    let base = (target === 'buck' ? rut.buckBase : rut.generalBase) + (tod[slot] ?? 0);
    if (target === 'general') base += scoring.timeOfDay.generalBias[slot] ?? 0;

    // Weights apply DIRECTLY, in score points at full effect. A precipitation weight of
    // 1.5 means a soaking rain costs the buck score 1.5 points. Keeping the unit
    // interpretable matters because the reweighting system writes these numbers and Ben
    // reads them, and an opaque internal scale factor would make both harder.
    //
    // The consequence is that the raw sum is not naturally bounded to 0-10, so a final
    // affine calibration maps it onto the visible scale. See calibration below.
    const keys = Object.keys(scoring.factors);
    const weights = Object.fromEntries(keys.map((k) => [k, effectiveWeight(scoring, cfg, k, target)]));

    const contributions = {};
    let total = base;
    for (const key of keys) {
      const w = weights[key];
      const eff = factors[key]?.effect ?? 0;
      const contrib = eff * w;
      contributions[key] = {
        effect: +eff.toFixed(3),
        weight: +w.toFixed(3),
        contribution: +contrib.toFixed(3),
        detail: factors[key]?.detail ?? null,
      };
      total += contrib;
    }

    // Affine calibration onto the visible 0-10 scale.
    //
    // The raw sum lands wherever the rut base and the factor weights put it, and that
    // depends on the property: a place with food and water inside 150 yards of every
    // stand genuinely sits higher than one where the nearest water is half a mile. Rather
    // than fudge the weights to hide that, the raw range is measured once by
    // `npm run score -- --calibrate` and mapped so a typical season spreads across the
    // scale instead of bunching at one end. Identity by default, which is the right
    // behavior before any calibration has been run.
    const cal = scoring.calibration?.[target] ?? { offset: 0, gain: 1 };
    const calibrated = (total + cal.offset) * cal.gain;

    return {
      score: +softScale(calibrated, scoring.scoreScale).toFixed(2),
      raw: +total.toFixed(2),
      base: +base.toFixed(2),
      calibration: cal,
      contributions,
    };
  };

  // Score each stand against its own resource distances and its own pressure history.
  const assembled = perStand.map((p) => {
    const f = buildFactors(p.foodDist, p.waterDist, p.daysSinceHunted);
    return { p, buck: assemble(f, 'buck'), general: assemble(f, 'general') };
  });

  // The day-level score is the BEST ACHIEVABLE STAND, not a blend of the best food
  // distance from one stand with the best water distance from another.
  //
  // An earlier version did the latter and produced a day-level general score of 9.2 on a
  // property where no individual stand scored above 4.5. That number described a stand
  // that does not exist. Taking the max over real stands keeps the day score to something
  // Ben can actually go sit, and puts the day and stand numbers on one comparable scale
  // so the calibration fits both.
  //
  // Buck and general are maximized independently, because they answer different questions
  // and the best stand for one is often not the best for the other. Same reason the tool
  // reports two scores instead of collapsing them into one.
  const best = (target) => assembled.reduce((a, b) => (b[target].score > a[target].score ? b : a));
  const neutral = buildFactors(null, null, null);
  const buck = assembled.length ? best('buck').buck : assemble(neutral, 'buck');
  const general = assembled.length ? best('general').general : assemble(neutral, 'general');

  const standScores = assembled.map(({ p, buck: b, general: g }) => ({
    id: p.stand.id,
    label: p.stand.label,
    terrain: p.stand.terrain ?? null,
    buckScore: b.score,
    generalScore: g.score,
    foodYards: p.foodDist == null ? null : Math.round(p.foodDist),
    waterYards: p.waterDist == null ? null : Math.round(p.waterDist),
    daysSinceHunted: p.daysSinceHunted,
  }));

  return {
    date,
    slot,
    rut,
    astro,
    weather: wx,
    confidence: wx.source === 'observation' ? 'observed'
      : wx.source === 'forecast' ? 'forecast'
      : 'climatology',
    buckScore: buck.score,
    generalScore: general.score,
    bestBuckStand: assembled.length ? best('buck').p.stand.label : null,
    bestGeneralStand: assembled.length ? best('general').p.stand.label : null,
    buck,
    general,
    standScores: standScores.sort((a, b) => b.buckScore - a.buckScore),
    unmarked: {
      stands: stands.length === 0,
      food: foods.length === 0,
      water: waters.length === 0,
      bedding: !map.points.some((p) => p.type === 'bedding'),
    },
  };
}
