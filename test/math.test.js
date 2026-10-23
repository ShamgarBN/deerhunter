// Tests for the parts that cannot be eyeballed.
//
// This suite is deliberately narrow. It does not test the dashboard, the API or anything
// that touches the network: those fail loudly and get noticed. It covers the arithmetic
// where a wrong answer looks entirely reasonable on screen - a scent bearing off by the
// sign, a probability that reads 0.84 when it should read 0.48, a front factor firing on
// the wrong half of a weather system. Nobody catches those by looking.
//
// Run with: npm test   (node:test, no dependency)

import test from 'node:test';
import assert from 'node:assert/strict';

import { destinationPoint, bearingDeg, distanceYards, angularDiff, degToCompass } from '../src/geo.js';
import { sitWindow, minutesFromLightAnchor, SIT_HOURS, DARK_HOURS } from '../src/astro.js';
import { pressureEffect, proximityEffect, frontalEffect } from '../src/scoring.js';
import { wilson, brier, fitLogistic, looBrier } from '../src/skill.js';
import { beddingBearing } from '../src/bedding.js';

const HOME = { lat: 35.95831, lon: -78.431 };
const close = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b} (tol ${tol})`);

// --- geometry ---------------------------------------------------------------
// Every scent verdict and every proximity score is downstream of these.

test('destinationPoint is the exact inverse of bearing and distance', () => {
  for (const bearing of [0, 45, 90, 180, 270, 315, 359]) {
    for (const yards of [10, 100, 500, 2000]) {
      const p = destinationPoint(HOME, bearing, yards);
      close(distanceYards(HOME, p), yards, 0.5, `distance at ${bearing}deg/${yards}yd`);
      close(angularDiff(bearingDeg(HOME, p), bearing), 0, 0.1, `bearing at ${bearing}deg/${yards}yd`);
    }
  }
});

test('destinationPoint returns null rather than NaN coordinates on missing input', () => {
  assert.equal(destinationPoint(HOME, null, 100), null);
  assert.equal(destinationPoint(HOME, 90, null), null);
  assert.equal(destinationPoint({ lat: null, lon: null }, 90, 100), null);
});

test('angularDiff wraps the short way around north', () => {
  assert.equal(angularDiff(350, 10), 20);     // not 340
  assert.equal(angularDiff(10, 350), 20);
  assert.equal(angularDiff(0, 180), 180);     // the maximum
});

test('degToCompass bins to the nearest of 16 points, including the wrap at north', () => {
  assert.equal(degToCompass(0), 'N');
  assert.equal(degToCompass(359), 'N');
  assert.equal(degToCompass(90), 'E');
  assert.equal(degToCompass(225), 'SW');
});

// --- sit windows ------------------------------------------------------------

test('sit windows are five hours and bracket the light the documented way', () => {
  const am = sitWindow('2026-11-15', 'AM', HOME.lat, HOME.lon);
  const pm = sitWindow('2026-11-15', 'PM', HOME.lat, HOME.lon);
  const hours = (w) => (w.end - w.start) / 3600000;
  close(hours(am), SIT_HOURS + DARK_HOURS, 0.01, 'AM window length');
  close(hours(pm), SIT_HOURS + DARK_HOURS, 0.01, 'PM window length');
  // AM opens before sunrise, PM closes after sunset.
  assert.ok(am.start < am.sunrise, 'AM starts before sunrise');
  assert.ok(pm.end > pm.sunset, 'PM ends after sunset');
});

test('minutesFromLightAnchor is signed and seasonally honest', () => {
  // The whole reason the column exists: the same clock time is after sunrise in November
  // and before it in December, and a raw clock column would conflate them.
  const nov = minutesFromLightAnchor('2026-11-15', 'AM', '07:05', HOME.lat, HOME.lon);
  const dec = minutesFromLightAnchor('2026-12-20', 'AM', '07:05', HOME.lat, HOME.lon);
  assert.ok(nov > 0, 'after sunrise in mid-November');
  assert.ok(dec < 0, 'before sunrise just before Christmas');
  assert.ok(nov > dec, 'sunrise drifts later into December');
});

test('minutesFromLightAnchor rejects unparseable times instead of guessing', () => {
  for (const bad of ['quarter past', '', null, '25:00', '12:99', '7:5']) {
    assert.equal(minutesFromLightAnchor('2026-11-15', 'AM', bad, HOME.lat, HOME.lon), null, `rejects ${bad}`);
  }
});

// --- hunting pressure -------------------------------------------------------

test('pressure recovery crosses zero at exactly the configured half-recovery day', () => {
  for (const days of [2, 3, 5]) {
    close(pressureEffect(days, days).effect, 0, 1e-9, `crosses zero at ${days}d`);
  }
});

test('pressure recovery is monotonic and bounded, and a fresh stand is not a free +1', () => {
  let prev = -Infinity;
  for (const d of [0, 1, 2, 3, 5, 8, 13, 21]) {
    const e = pressureEffect(d, 3).effect;
    assert.ok(e >= prev, `monotonic at ${d}d`);
    assert.ok(e >= -1 && e <= 1, `bounded at ${d}d`);
    prev = e;
  }
  assert.equal(pressureEffect(0, 3).effect, -1, 'just hunted is the full penalty');
  // Capped below +1 on purpose: at the opener every stand is untouched, and a full +1
  // would hand every slot the same bonus and discriminate nothing.
  assert.equal(pressureEffect(null, 3).effect, 0.85);
  assert.equal(pressureEffect(null, 3).detail.neverHunted, true);
});

// --- proximity --------------------------------------------------------------

test('proximity falls off through the fitted anchors in the right direction', () => {
  const curve = { near: 15, mid: 85, far: 325 };
  const at = (d) => proximityEffect(d, curve.near, curve.mid, curve.far).effect;
  assert.equal(at(10), 1, 'inside near is full credit');
  assert.equal(at(15), 1, 'at near is full credit');
  close(at(85), 0, 1e-9, 'neutral at mid');
  assert.equal(at(325), -1, 'worst at far');
  assert.equal(at(1000), -1, 'clamped beyond far');
  assert.ok(at(30) > at(60) && at(60) > at(120), 'monotonically decreasing');
});

test('unmarked proximity is neutral, never a penalty', () => {
  const r = proximityEffect(null, 15, 85, 325);
  assert.equal(r.effect, 0);
  assert.equal(r.detail.unmarked, true);
});

// --- frontal passage --------------------------------------------------------

const scoring = { frontal: { tempDropFullF: 12, pressureRiseFullHpa: 5, pressureFallFullHpa: 5, preFrontalCeiling: 0.45 } };

test('frontal passage needs the conjunction, not either ingredient alone', () => {
  const post = frontalEffect({ tempChange24h: -14, pressureChange24h: 6, skyCover: 10 }, scoring);
  assert.ok(post.effect > 0.8, 'cold + rising + clearing is a strong front');
  assert.equal(post.detail.shape, 'post-frontal');

  // This is the case the factor exists for: cold alone, with the barometer still falling,
  // is the front still arriving and must NOT score as a post-frontal morning.
  const stillFalling = frontalEffect({ tempChange24h: -14, pressureChange24h: -4, skyCover: 80 }, scoring);
  assert.equal(stillFalling.detail.shape, 'none');
  assert.equal(stillFalling.effect, 0);

  const risingButWarm = frontalEffect({ tempChange24h: 10, pressureChange24h: 6, skyCover: 10 }, scoring);
  assert.equal(risingButWarm.effect, 0, 'rising barometer on a warming day is not a front');
});

test('frontal passage is one-sided and never penalises', () => {
  const cases = [
    { tempChange24h: 0, pressureChange24h: 0, skyCover: 50 },
    { tempChange24h: 20, pressureChange24h: -20, skyCover: 100 },
    { tempChange24h: -20, pressureChange24h: 20, skyCover: 0 },
  ];
  for (const wx of cases) {
    const e = frontalEffect(wx, scoring).effect;
    assert.ok(e >= 0 && e <= 1, `stays in [0,1] for ${JSON.stringify(wx)}`);
  }
});

test('the pre-frontal case is capped below the post-frontal one', () => {
  const pre = frontalEffect({ tempChange24h: -1, pressureChange24h: -9, skyCover: 90 }, scoring);
  assert.equal(pre.detail.shape, 'pre-frontal');
  assert.ok(pre.effect <= scoring.frontal.preFrontalCeiling + 1e-9, 'respects the ceiling');
});

test('frontal passage is neutral when the readings are missing, not zeroed by a missing sky', () => {
  assert.equal(frontalEffect({ tempChange24h: null, pressureChange24h: 5 }, scoring).effect, 0);
  // Past the forecast horizon sky cover is absent for every slot; temperature and
  // pressure are still real and the factor must still work.
  const noSky = frontalEffect({ tempChange24h: -14, pressureChange24h: 6, skyCover: null }, scoring);
  assert.ok(noSky.effect > 0, 'still fires without a sky reading');
});

// --- bedding inference ------------------------------------------------------

test('bedding lies opposite the travel in the evening and along it in the morning', () => {
  // Deer leave bed for food in the evening and return in the morning. Getting this
  // backwards would send him looking for bedding in the food plot.
  assert.equal(beddingBearing({ slot: 'PM', travelDeg: 90 }), 270);
  assert.equal(beddingBearing({ slot: 'AM', travelDeg: 90 }), 90);
  assert.equal(beddingBearing({ slot: 'PM', travelDeg: 0 }), 180);
  assert.equal(beddingBearing({ slot: 'AM', travelDeg: null }), null, 'no heading, no claim');
});

// --- probability and skill --------------------------------------------------

test('wilson refuses to claim certainty from a tiny sample', () => {
  const perfect = wilson(3, 3);
  assert.equal(perfect.mid, 1);
  assert.ok(perfect.low < 0.6, 'three out of three is not proof, lower bound stays well below 1');
  const none = wilson(0, 5);
  assert.equal(none.mid, 0);
  assert.ok(none.high > 0.3, 'nought out of five does not rule it out');
  assert.deepEqual(wilson(0, 0), { low: 0, high: 1, mid: null }, 'no data means no interval');
});

test('wilson brackets the point estimate and stays inside [0,1]', () => {
  for (const [k, n] of [[1, 10], [5, 10], [9, 10], [50, 100]]) {
    const w = wilson(k, n);
    assert.ok(w.low >= 0 && w.high <= 1, `inside [0,1] for ${k}/${n}`);
    assert.ok(w.low <= w.mid && w.mid <= w.high, `brackets the estimate for ${k}/${n}`);
  }
});

test('brier scores the known anchors', () => {
  assert.equal(brier([[1, 1], [0, 0]]), 0, 'perfect confident forecast');
  assert.equal(brier([[0.5, 1], [0.5, 0]]), 0.25, 'coin flip');
  assert.equal(brier([[0, 1], [1, 0]]), 1, 'confidently wrong');
  assert.equal(brier([]), null, 'no forecasts, no score');
});

test('the logistic fit stays finite under perfect separation', () => {
  // Without the ridge penalty this is where the slope runs to infinity and the model
  // starts reporting probabilities of 0 and 1 from a dozen sits.
  const xs = [1, 2, 3, 4, 5, 6, 7, 8];
  const fit = fitLogistic(xs, [0, 0, 0, 0, 1, 1, 1, 1]);
  assert.ok(Number.isFinite(fit.b1), 'slope is finite');
  assert.ok(fit.predict(1) > 0.001 && fit.predict(8) < 0.999, 'never claims certainty');
  assert.ok(fit.predict(8) > fit.predict(1), 'slopes the right way');
});

test('the logistic fit handles a flat relationship without blowing up', () => {
  const xs = [1, 2, 3, 4, 5, 6, 7, 8];
  const fit = fitLogistic(xs, [0, 1, 0, 1, 0, 1, 0, 1]);
  assert.ok(Number.isFinite(fit.b1));
  assert.ok(Math.abs(fit.b1) < 1, 'alternating outcomes produce a near-flat slope');
});

test('leave-one-out brier punishes noise and rewards signal', () => {
  const xs = [1, 2, 3, 4, 5, 6, 7, 8];
  const signal = looBrier(xs, [0, 0, 0, 0, 1, 1, 1, 1]);
  const noise = looBrier(xs, [0, 1, 0, 1, 0, 1, 0, 1]);
  assert.ok(signal.brier < 0.25, 'real separation beats a coin flip');
  assert.ok(noise.brier > 0.25, 'pure noise does worse than a coin flip out of sample');
  assert.equal(looBrier([1, 2], [0, 1]), null, 'refuses to score two points');
  assert.equal(looBrier(xs, [1, 1, 1, 1, 1, 1, 1, 1]), null, 'one class is not gradeable');
});
