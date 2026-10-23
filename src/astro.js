// Sun and moon, computed locally with suncalc. No network call: this is deterministic
// astronomy and hitting an API for it would only add a failure mode.
//
// Moon data is REFERENCE ONLY. It is displayed because Ben wants the number in front of
// him, and it carries a weight of exactly zero in scoring.json. Multiple independent
// collar studies, including MSU Deer Lab's 48-collar work, found no measurable movement
// effect from moon phase, and specifically none for the solunar overhead/underfoot theory.

import SunCalc from 'suncalc';
import { prettyTime, hhmm } from './timeutil.js';

// suncalc phase: 0 = new, 0.25 = first quarter, 0.5 = full, 0.75 = last quarter.
// Named by range rather than nearest-anchor so a 46% waxing moon reads "waxing crescent"
// on its way up instead of being rounded to "first quarter".
function phaseName(phase) {
  const p = ((phase % 1) + 1) % 1;
  if (p < 0.02 || p > 0.98) return 'New moon';
  if (p < 0.23) return 'Waxing crescent';
  if (p < 0.27) return 'First quarter';
  if (p < 0.48) return 'Waxing gibbous';
  if (p < 0.52) return 'Full moon';
  if (p < 0.73) return 'Waning gibbous';
  if (p < 0.77) return 'Last quarter';
  return 'Waning crescent';
}

// Noon UTC on the given local date is a safe anchor for "this day" in US Eastern.
const anchor = (dateStr) => new Date(`${dateStr}T17:00:00Z`);

export function sunMoonFor(dateStr, lat, lon, tz = 'America/New_York') {
  const d = anchor(dateStr);
  const t = SunCalc.getTimes(d, lat, lon);
  const illum = SunCalc.getMoonIllumination(d);
  let moonTimes = {};
  try { moonTimes = SunCalc.getMoonTimes(d, lat, lon) || {}; } catch { moonTimes = {}; }

  // NC legal hunting light: 30 minutes before sunrise to 30 minutes after sunset.
  const legalStart = new Date(t.sunrise.getTime() - 30 * 60000);
  const legalEnd = new Date(t.sunset.getTime() + 30 * 60000);

  return {
    date: dateStr,
    sunrise: t.sunrise.toISOString(),
    sunset: t.sunset.toISOString(),
    sunriseLocal: prettyTime(t.sunrise, tz),
    sunsetLocal: prettyTime(t.sunset, tz),
    dawn: t.dawn?.toISOString() ?? null,
    dusk: t.dusk?.toISOString() ?? null,
    legalStartLocal: prettyTime(legalStart, tz),
    legalEndLocal: prettyTime(legalEnd, tz),
    daylightHours: +((t.sunset - t.sunrise) / 3600000).toFixed(2),
    moon: {
      illumination: +(illum.fraction * 100).toFixed(1),
      phase: +illum.phase.toFixed(3),
      phaseName: phaseName(illum.phase),
      moonrise: moonTimes.rise ? prettyTime(moonTimes.rise, tz) : null,
      moonset: moonTimes.set ? prettyTime(moonTimes.set, tz) : null,
      scored: false,
      note: 'Reference only. Weighted zero: collar studies found no measurable movement effect.',
    },
  };
}

// A sit is a window, not a moment.
//
// The first version sampled one instant per slot - 45 minutes after sunrise, 75 minutes
// before sunset - which meant a front arriving at 9am did not exist in the morning score.
//
// Per Ben's own pattern, each session is FIVE hours anchored on sunrise or sunset: an
// hour on the dark side for walking in or sitting it out, and four hours of sit time in
// the light.
//
//   AM  [sunrise - 1h, sunrise + 4h]    dark walk-in, then four hours of daylight
//   PM  [sunset  - 4h, sunset  + 1h]    four hours of daylight, then an hour past dark
//
// Both bracket legal light, which in NC runs 30 minutes either side of sunrise and sunset.
export const SIT_HOURS = 4;
export const DARK_HOURS = 1;

export function sitWindow(dateStr, slot, lat, lon) {
  const t = SunCalc.getTimes(anchor(dateStr), lat, lon);
  const H = 3600000;
  if (slot === 'AM') {
    return {
      start: new Date(t.sunrise.getTime() - DARK_HOURS * H),
      end: new Date(t.sunrise.getTime() + SIT_HOURS * H),
      sunrise: t.sunrise,
      sunset: t.sunset,
    };
  }
  return {
    start: new Date(t.sunset.getTime() - SIT_HOURS * H),
    end: new Date(t.sunset.getTime() + DARK_HOURS * H),
    sunrise: t.sunrise,
    sunset: t.sunset,
  };
}

/**
 * Signed minutes between a wall-clock time and that slot's light anchor: sunrise for a
 * morning sit, sunset for an evening one. Negative is before the anchor.
 *
 * Both sides are reduced to local wall-clock minutes before subtracting, which sidesteps
 * timezone arithmetic entirely. That is safe here because both times always land on the
 * same local date: an AM window opens an hour before sunrise and a PM window closes an
 * hour after sunset, so neither crosses midnight at this latitude.
 */
export function minutesFromLightAnchor(dateStr, slot, timeStr, lat, lon, tz = 'America/New_York') {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(timeStr ?? '').trim());
  if (!m) return null;
  const mins = +m[1] * 60 + +m[2];
  if (+m[1] > 23 || +m[2] > 59) return null;
  const w = sitWindow(dateStr, slot, lat, lon);
  const anchorAt = slot === 'AM' ? w.sunrise : w.sunset;
  const [ah, am] = hhmm(anchorAt, tz).split(':').map(Number);
  return mins - (ah * 60 + am);
}

