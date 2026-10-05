// Empirical-Bayes reweighting: how the tool gets smarter without getting stupid.
//
// Heuristics and statistics are not mutually exclusive. Every factor keeps a
// prior_weight (the research-grounded default, which never changes) and a
// current_weight (what scoring uses, which drifts as evidence accumulates).
//
// The update, per factor and per target (buck / general):
//
//   1. Pull every logged sit that has a usable snapshot for this factor.
//   2. Split into a high bucket and a low bucket by the factor's own effect value,
//      using terciles so the two buckets are genuinely separated rather than split
//      down the middle of a cluster.
//   3. Compare actual sighting rates between buckets: observed_delta = rate_high - rate_low.
//   4. Convert that sighting-rate difference into the weight that would have produced it:
//        fitted_weight = observed_delta * sightingRateToScorePoints / (meanEff_high - meanEff_low)
//        fitted_delta  = fitted_weight - prior_weight
//   5. Shrink by sample size:  shrinkage = n / (n + k),  k = 20.
//        Ten sits gets about a third weight on the data, sixty about three-quarters.
//        This is standard empirical Bayes: the prior yields only as fast as the
//        evidence earns it, rather than a dozen noisy sits swinging the model.
//   6. new_current = prior + shrinkage * fitted_delta, clipped to +/- 20% of prior
//      (with an absolute floor so zero-prior factors are not frozen forever).
//   7. Log every adjustment. Nothing changes silently.
//
// Run at season's end by default; on demand any time; and explicitly as part of the
// annual review. See ANNUAL_REVIEW.md.

import { getDb } from './db.js';
import { loadScoring, saveScoring } from './config.js';
import { nowIso } from './timeutil.js';

// Which outcome column answers "did this factor help?" for each score.
// buck    -> did a buck show up
// general -> did any deer show up
const OUTCOME = {
  buck: (sit) => (sit.buck_count > 0 ? 1 : 0),
  general: (sit) => (sit.saw_deer ? 1 : 0),
};

function loadSitsWithSnapshots(season) {
  const db = getDb();
  const sql = `
    SELECT s.id, s.date, s.slot, s.stand_id, s.saw_deer, s.deer_count, s.buck_count, s.season,
           sn.factors_json
      FROM sits s
      JOIN sit_snapshots sn ON sn.sit_id = s.id
     ${season ? 'WHERE s.season = ?' : ''}
     ORDER BY s.date`;
  const rows = season ? db.prepare(sql).all(season) : db.prepare(sql).all();
  return rows.map((r) => ({ ...r, factors: JSON.parse(r.factors_json) }));
}

function terciles(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(sorted.length * p)))];
  return { lowCut: at(1 / 3), highCut: at(2 / 3) };
}

/**
 * Fit one factor against one outcome. Returns null when the data cannot support a fit,
 * with a reason, rather than returning a number nobody should trust.
 */
export function fitFactor(sits, factorKey, target, scoring) {
  const rw = scoring.reweighting;
  const usable = sits.filter((s) => typeof s.factors?.[factorKey] === 'number');
  if (usable.length < rw.minSitsPerBucket * 2) {
    return { skipped: true, reason: `only ${usable.length} sits with a snapshot for this factor; need ${rw.minSitsPerBucket * 2}`, n: usable.length };
  }

  const effects = usable.map((s) => s.factors[factorKey]);
  const { lowCut, highCut } = terciles(effects);

  const high = usable.filter((s) => s.factors[factorKey] >= highCut);
  const low = usable.filter((s) => s.factors[factorKey] <= lowCut);

  if (high.length < rw.minSitsPerBucket || low.length < rw.minSitsPerBucket) {
    return { skipped: true, reason: `buckets too small (high=${high.length}, low=${low.length}, need ${rw.minSitsPerBucket} each)`, n: usable.length };
  }

  const outcome = OUTCOME[target];
  const rateHigh = high.reduce((a, s) => a + outcome(s), 0) / high.length;
  const rateLow = low.reduce((a, s) => a + outcome(s), 0) / low.length;

  const meanHigh = high.reduce((a, s) => a + s.factors[factorKey], 0) / high.length;
  const meanLow = low.reduce((a, s) => a + s.factors[factorKey], 0) / low.length;
  const separation = meanHigh - meanLow;

  if (Math.abs(separation) < rw.minEffectSeparation) {
    // The buckets barely differ in the factor's own value, so dividing by the gap
    // blows the fitted weight up into nonsense. Skip rather than fabricate.
    return { skipped: true, reason: `effect separation ${separation.toFixed(2)} below ${rw.minEffectSeparation}; this factor barely varied across your sits`, n: usable.length };
  }

  const observedDelta = rateHigh - rateLow;
  const fittedWeight = (observedDelta * rw.sightingRateToScorePoints) / separation;

  return {
    skipped: false,
    n: usable.length,
    nHigh: high.length,
    nLow: low.length,
    rateHigh: +rateHigh.toFixed(3),
    rateLow: +rateLow.toFixed(3),
    meanHigh: +meanHigh.toFixed(3),
    meanLow: +meanLow.toFixed(3),
    separation: +separation.toFixed(3),
    observedDelta: +observedDelta.toFixed(3),
    fittedWeight: +fittedWeight.toFixed(3),
  };
}

/**
 * Run the full update.
 * @param {object} opts
 *   dryRun  - compute and report without writing (default true; the CLI opts in to writing)
 *   season  - restrict to one season label, or null for all history
 */
export function runReweight({ dryRun = true, season = null } = {}) {
  const scoring = loadScoring();
  const rw = scoring.reweighting;
  const sits = loadSitsWithSnapshots(season);
  const db = getDb();
  const results = [];

  for (const factorKey of Object.keys(scoring.factors)) {
    for (const target of ['buck', 'general']) {
      const prior = scoring.factors[factorKey][target].prior;
      const old = scoring.factors[factorKey][target].current;
      const frozen = scoring.factors[factorKey].frozen === true;
      const fit = fitFactor(sits, factorKey, target, scoring);

      if (fit.skipped) {
        results.push({ factor: factorKey, target, skipped: true, reason: fit.reason, n: fit.n, prior, old, current: old });
        continue;
      }

      const shrinkage = fit.n / (fit.n + rw.shrinkageK);
      const fittedDelta = fit.fittedWeight - prior;
      let next = prior + shrinkage * fittedDelta;

      // Clip: no factor moves more than 20% from its prior in one season. The absolute
      // floor exists because 20% of a zero prior is zero, which would freeze the moon
      // factor at exactly zero forever no matter what the data said. A documented
      // deviation from the literal spec, and the reason moon can eventually surface.
      const limit = Math.max(Math.abs(prior) * rw.maxDriftFraction, rw.minAbsoluteDrift);
      const clippedLow = prior - limit;
      const clippedHigh = prior + limit;
      const clipped = next < clippedLow || next > clippedHigh;
      next = Math.min(clippedHigh, Math.max(clippedLow, next));
      next = +next.toFixed(4);

      // A frozen factor still gets fitted and reported, so a genuine signal would be
      // visible in the report, but the value is never written. Moon is frozen by
      // default: random noise across a few dozen sits is enough to nudge a zero-prior
      // weight off zero, which would quietly undo the reason it is zero.
      if (frozen) {
        results.push({
          factor: factorKey, target, skipped: false, frozen: true,
          prior, old, current: old, change: 0,
          wouldHaveBeen: next,
          shrinkage: +shrinkage.toFixed(3),
          fittedWeight: fit.fittedWeight,
          fittedDelta: +fittedDelta.toFixed(3),
          n: fit.n, nHigh: fit.nHigh, nLow: fit.nLow,
          rateHigh: fit.rateHigh, rateLow: fit.rateLow, separation: fit.separation,
        });
        continue;
      }

      results.push({
        factor: factorKey, target, skipped: false, frozen: false,
        prior, old, current: next,
        change: +(next - old).toFixed(4),
        shrinkage: +shrinkage.toFixed(3),
        fittedWeight: fit.fittedWeight,
        fittedDelta: +fittedDelta.toFixed(3),
        clipped,
        n: fit.n, nHigh: fit.nHigh, nLow: fit.nLow,
        rateHigh: fit.rateHigh, rateLow: fit.rateLow,
        separation: fit.separation,
      });

      if (!dryRun && Math.abs(next - old) > 1e-6) {
        scoring.factors[factorKey][target].current = next;
        db.prepare(`
          INSERT INTO weight_adjustments
            (factor, target, prior_weight, old_weight, new_weight, fitted_delta, shrinkage,
             sample_n, rate_high, rate_low, clipped, season, reason, created_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        `).run(
          factorKey, target, prior, old, next, fittedDelta, shrinkage,
          fit.n, fit.rateHigh, fit.rateLow, clipped ? 1 : 0, season,
          `sighting rate ${(fit.rateHigh * 100).toFixed(0)}% in the high bucket vs ${(fit.rateLow * 100).toFixed(0)}% in the low bucket across ${fit.n} sits`,
          nowIso(),
        );
      }
    }
  }

  if (!dryRun) saveScoring(scoring);

  return {
    dryRun,
    season,
    totalSits: sits.length,
    results,
    applied: results.filter((r) => !r.skipped && !r.frozen && Math.abs(r.change ?? 0) > 1e-6).length,
    skipped: results.filter((r) => r.skipped).length,
    frozen: results.filter((r) => r.frozen).length,
  };
}

// Reset every current_weight back to its prior. The escape hatch when the model has
// drifted somewhere unhelpful and Ben wants the research defaults back.
export function resetToPriors() {
  const scoring = loadScoring();
  const db = getDb();
  let n = 0;
  for (const key of Object.keys(scoring.factors)) {
    for (const target of ['buck', 'general']) {
      const f = scoring.factors[key][target];
      if (f.current !== f.prior) {
        db.prepare(`
          INSERT INTO weight_adjustments
            (factor, target, prior_weight, old_weight, new_weight, clipped, reason, created_at)
          VALUES (?,?,?,?,?,0,?,?)
        `).run(key, target, f.prior, f.current, f.prior, 'manual reset to priors', nowIso());
        f.current = f.prior;
        n++;
      }
    }
  }
  saveScoring(scoring);
  return { reset: n };
}

export function adjustmentHistory(limit = 200) {
  return getDb().prepare('SELECT * FROM weight_adjustments ORDER BY created_at DESC, id DESC LIMIT ?').all(limit);
}
