// Is the score worth anything, and what does a number on it actually mean?
//
// Two questions the tool could not answer about itself until there was a sit log:
//
//   1. Calibration. "6.8" is ordinal. It beats 4.2 and that is all it says. Mapping the
//      score onto an observed sighting rate turns it into the number you actually want at
//      4:45am: out of the mornings that looked like this one, how many produced a deer.
//
//   2. Skill. A model that looks plausible and predicts nothing is the default outcome,
//      not the unlucky one. Comparing it against baselines that cost nothing to compute is
//      the only way to know, and the honest baselines are unflattering on purpose.
//
// Everything here is fitted on a handful of sits for at least the first season, so the
// uncertainty is reported as loudly as the estimate and every function refuses to pretend
// when there is not enough data.

import { getDb } from './db.js';

/**
 * Wilson score interval for a binomial proportion.
 *
 * Not the textbook normal approximation, which is embarrassing at the sample sizes this
 * tool will have for a year or more: at 3 hits out of 3 it produces an interval of exactly
 * [1, 1], claiming certainty from three sits. Wilson stays inside [0,1] and keeps real
 * width at the extremes.
 */
export function wilson(hits, n, z = 1.96) {
  if (!n) return { low: 0, high: 1, mid: null };
  const p = hits / n;
  const d = 1 + (z * z) / n;
  const center = (p + (z * z) / (2 * n)) / d;
  const half = (z / d) * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return {
    mid: p,
    low: Math.max(0, center - half),
    high: Math.min(1, center + half),
  };
}

/** Mean squared error of probabilistic forecasts. Lower is better; 0.25 is a coin flip. */
export function brier(pairs) {
  if (!pairs.length) return null;
  return pairs.reduce((a, [p, o]) => a + (p - o) ** 2, 0) / pairs.length;
}

const sigmoid = (z) => 1 / (1 + Math.exp(-z));

/**
 * One-predictor logistic regression by Newton-Raphson, with a ridge penalty.
 *
 * The penalty is not optional at this sample size. With a dozen sits it is entirely
 * possible for every sighting to sit above every blank, which is perfect separation: the
 * unpenalised fit then sends the slope to infinity and reports probabilities of 0 and 1,
 * which is the most confident possible way to be wrong. The penalty keeps the slope finite
 * and the probabilities honest.
 */
export function fitLogistic(xs, ys, { lambda = 1, iterations = 50 } = {}) {
  if (xs.length !== ys.length || !xs.length) return null;
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length) || 1;
  const z = xs.map((x) => (x - mean) / sd);   // standardised, so one lambda suits any scale

  let b0 = 0;
  let b1 = 0;
  for (let it = 0; it < iterations; it++) {
    let g0 = 0; let g1 = 0; let h00 = lambda * 0; let h01 = 0; let h11 = lambda;
    for (let i = 0; i < z.length; i++) {
      const p = sigmoid(b0 + b1 * z[i]);
      const r = p - ys[i];
      g0 += r;
      g1 += r * z[i];
      const w = Math.max(1e-6, p * (1 - p));
      h00 += w;
      h01 += w * z[i];
      h11 += w * z[i] * z[i];
    }
    g1 += lambda * b1;                        // penalise the slope, never the intercept
    const det = h00 * h11 - h01 * h01;
    if (!Number.isFinite(det) || Math.abs(det) < 1e-12) break;
    const d0 = (h11 * g0 - h01 * g1) / det;
    const d1 = (h00 * g1 - h01 * g0) / det;
    b0 -= d0;
    b1 -= d1;
    if (Math.abs(d0) < 1e-9 && Math.abs(d1) < 1e-9) break;
  }
  if (!Number.isFinite(b0) || !Number.isFinite(b1)) return null;
  return { b0, b1, mean, sd, predict: (x) => sigmoid(b0 + b1 * ((x - mean) / sd)) };
}

/**
 * Leave-one-out Brier.
 *
 * Scoring a fit on the sits it was fitted to measures memorisation, and at n=12 it
 * measures almost nothing else. Refitting without each sit in turn is the cheapest honest
 * answer and is trivially affordable at this size.
 */
export function looBrier(xs, ys, opts) {
  if (xs.length < 4) return null;
  const pairs = [];
  for (let i = 0; i < xs.length; i++) {
    const tx = xs.filter((_, j) => j !== i);
    const ty = ys.filter((_, j) => j !== i);
    if (!ty.some((v) => v === 1) || !ty.some((v) => v === 0)) continue;  // one class left, nothing to fit
    const fit = fitLogistic(tx, ty, opts);
    if (!fit) continue;
    pairs.push([fit.predict(xs[i]), ys[i]]);
  }
  return pairs.length >= 4 ? { brier: brier(pairs), n: pairs.length } : null;
}

/** Sits that carry both a prediction and an outcome. */
function scoredSits() {
  return getDb().prepare(`
    SELECT s.id, s.date, s.slot, s.stand_label, s.saw_deer, s.deer_count, s.buck_count,
           sn.buck_score, sn.general_score, sn.raw_json, sn.source
      FROM sits s JOIN sit_snapshots sn ON sn.sit_id = s.id
     WHERE sn.buck_score IS NOT NULL
     ORDER BY s.date, s.slot
  `).all().map((r) => {
    let raw = {};
    try { raw = JSON.parse(r.raw_json || '{}'); } catch { /* a malformed snapshot is skippable, not fatal */ }
    return { ...r, rutOffset: raw.rutOffset ?? null };
  });
}

const MIN_FOR_RATES = 8;     // below this a bin table is noise with a table around it
const MIN_FOR_SKILL = 12;    // below this a skill score says more about luck than the model

/**
 * Observed sighting rate by predicted score, plus a fitted score-to-probability curve.
 *
 * `target` picks which question is being asked: 'general' is "did I see a deer", 'buck'
 * is "did I see a buck". They are scored separately by the model and have to be verified
 * separately, or a tool that is good at one and useless at the other looks mediocre at both.
 */
export function calibration({ target = 'general', bins = 3 } = {}) {
  const sits = scoredSits();
  const xs = sits.map((s) => (target === 'buck' ? s.buck_score : s.general_score));
  const ys = sits.map((s) => (target === 'buck' ? (s.buck_count > 0 ? 1 : 0) : (s.saw_deer ? 1 : 0)));
  const n = sits.length;
  const hits = ys.reduce((a, b) => a + b, 0);

  const out = {
    target,
    n,
    hits,
    baseRate: n ? hits / n : null,
    bins: [],
    fit: null,
    table: null,
    enough: n >= MIN_FOR_RATES,
    note: null,
  };

  if (!n) {
    out.note = 'No sits with a stored prediction yet. Log sits and the tool starts grading itself.';
    return out;
  }
  if (n < MIN_FOR_RATES) {
    out.note = `${n} scored sit(s). A rate needs about ${MIN_FOR_RATES} before it means anything, so this is shown as a count, not a probability.`;
    return out;
  }

  // Quantile bins, so each one holds a comparable number of sits. Equal-width bins put
  // almost everything in the middle bucket on a calibrated 0-10 score.
  const sorted = [...xs].sort((a, b) => a - b);
  const cuts = [];
  for (let i = 1; i < bins; i++) cuts.push(sorted[Math.floor((i * sorted.length) / bins)]);

  const binOf = (x) => cuts.filter((c) => x >= c).length;
  const groups = Array.from({ length: bins }, () => ({ xs: [], ys: [] }));
  xs.forEach((x, i) => { groups[binOf(x)].xs.push(x); groups[binOf(x)].ys.push(ys[i]); });

  out.bins = groups.map((g, i) => {
    const k = g.ys.reduce((a, b) => a + b, 0);
    const w = wilson(k, g.ys.length);
    return {
      index: i,
      from: i === 0 ? 0 : +cuts[i - 1].toFixed(1),
      to: i === bins - 1 ? 10 : +cuts[i].toFixed(1),
      n: g.ys.length,
      hits: k,
      rate: g.ys.length ? k / g.ys.length : null,
      low: w.low,
      high: w.high,
    };
  }).filter((b) => b.n > 0);

  if (hits > 0 && hits < n) {
    const fit = fitLogistic(xs, ys);
    if (fit) {
      out.fit = {
        slope: +fit.b1.toFixed(4),
        // A slope at or below zero means a higher score did not go with more sightings on
        // this property. Worth stating outright rather than drawing a curve that slopes
        // the wrong way and letting it be read as a result.
        direction: fit.b1 > 0.05 ? 'higher score, more sightings'
          : fit.b1 < -0.05 ? 'BACKWARDS: higher score went with fewer sightings'
            : 'flat: the score did not separate sightings from blanks',
      };
      out.table = [3, 4, 5, 6, 7, 8, 9].map((s) => ({ score: s, p: +fit.predict(s).toFixed(3) }));
    }
  } else {
    out.note = hits === 0
      ? 'Every logged sit was a blank, so there is nothing to separate yet.'
      : 'Every logged sit produced a deer, so there is nothing to separate yet.';
  }
  return out;
}

/**
 * Does the model beat doing almost nothing?
 *
 * Two baselines, both deliberately unflattering:
 *
 *   base rate  always predict the season's overall sighting rate. Beating this is the
 *              minimum bar for the weather and stand factors earning their place.
 *   rut only   the same logistic fitted on rut-day-offset alone. The rut curve is the
 *              biggest term in the model and needs no weather at all, so this asks
 *              whether everything else is adding anything on top of a calendar.
 *
 * All three are scored leave-one-out, so none of them is graded on data it saw.
 */
export function skill({ target = 'general' } = {}) {
  const sits = scoredSits();
  const xs = sits.map((s) => (target === 'buck' ? s.buck_score : s.general_score));
  const ys = sits.map((s) => (target === 'buck' ? (s.buck_count > 0 ? 1 : 0) : (s.saw_deer ? 1 : 0)));
  const n = sits.length;
  const hits = ys.reduce((a, b) => a + b, 0);

  const out = { target, n, enough: n >= MIN_FOR_SKILL, model: null, baseRate: null, rutOnly: null, verdict: null };

  if (n < MIN_FOR_SKILL) {
    out.verdict = `${n} scored sit(s). A skill score needs about ${MIN_FOR_SKILL} before it says more about the model than about luck.`;
    return out;
  }
  if (hits === 0 || hits === n) {
    out.verdict = 'Every sit had the same outcome, so no forecast can be graded against it yet.';
    return out;
  }

  // The base rate is also scored leave-one-out: predicting from a rate that includes the
  // sit being graded would hand the baseline an advantage the model does not get.
  const basePairs = ys.map((_, i) => {
    const others = ys.filter((__, j) => j !== i);
    return [others.reduce((a, b) => a + b, 0) / others.length, ys[i]];
  });

  const model = looBrier(xs, ys);
  const rutXs = sits.map((s) => s.rutOffset);
  const rutOnly = rutXs.every((v) => v != null) ? looBrier(rutXs, ys) : null;
  const baseBrier = brier(basePairs);

  const bss = (b) => (b == null || !baseBrier ? null : +(1 - b / baseBrier).toFixed(3));

  out.baseRate = { brier: baseBrier == null ? null : +baseBrier.toFixed(4) };
  out.model = model && { brier: +model.brier.toFixed(4), n: model.n, skillVsBaseRate: bss(model.brier) };
  out.rutOnly = rutOnly && { brier: +rutOnly.brier.toFixed(4), n: rutOnly.n, skillVsBaseRate: bss(rutOnly.brier) };

  if (!out.model) {
    out.verdict = 'Not enough variation to grade the model yet.';
  } else if (out.model.skillVsBaseRate > 0.05) {
    out.verdict = out.rutOnly && out.model.brier >= out.rutOnly.brier
      ? 'The score beats guessing the base rate, but does not beat the rut curve alone. The weather and stand factors are not yet earning their place.'
      : 'The score beats both guessing the base rate and the rut curve alone.';
  } else if (out.model.skillVsBaseRate > -0.05) {
    out.verdict = 'The score is no better than guessing the season average. Too early to conclude much, but it is not yet adding anything.';
  } else {
    out.verdict = 'The score is doing WORSE than guessing the season average. If that holds as sits accumulate, the weights are wrong rather than merely imprecise.';
  }
  return out;
}
