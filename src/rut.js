// Rut phase curve.
//
// This is modeled as a curve of day-offsets from a single configurable peak-breeding
// date, NOT a bell curve centered on that peak. The distinction is the whole point.
//
// Dominant bucks that have paired with an estrous doe effectively disappear for a day
// or two during peak breeding itself. That is "lockdown". So raw daylight sightings
// dip right at the peak even though the rut is, biologically, peaking. The curve
// therefore tops out during CHASING (roughly -7 to -2 days) and steps down at the peak,
// staying elevated but erratic as younger and subordinate bucks keep searching.
//
// Do not "correct" this to peak at day 0. It is deliberate and it matches what hunters
// actually experience during lockdown week.

const MS_PER_DAY = 86400000;

export function dayOffset(dateStr, peakDateStr) {
  const d = Date.parse(`${dateStr}T12:00:00Z`);
  const p = Date.parse(`${peakDateStr}T12:00:00Z`);
  return Math.round((d - p) / MS_PER_DAY);
}

// Piecewise-linear interpolation across the anchor table in scoring.json.
function interpolate(anchors, x) {
  if (x <= anchors[0][0]) return anchors[0][1];
  const last = anchors[anchors.length - 1];
  if (x >= last[0]) return last[1];
  for (let i = 0; i < anchors.length - 1; i++) {
    const [x0, y0] = anchors[i];
    const [x1, y1] = anchors[i + 1];
    if (x >= x0 && x <= x1) {
      if (x1 === x0) return y1;
      return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
    }
  }
  return last[1];
}

export function phaseFor(offset, scoring) {
  const found = scoring.rutCurve.phases.find((p) => offset >= p.from && offset <= p.to);
  if (found) return found;
  return { key: 'baseline', label: 'Pre-season baseline', blurb: 'Outside the modeled rut window. Movement is food- and weather-driven.', from: -999, to: -36 };
}

export function rutFor(dateStr, scoring) {
  const offset = dayOffset(dateStr, scoring.peakRutDate);
  const phase = phaseFor(offset, scoring);
  return {
    offset,
    phase: phase.key,
    phaseLabel: phase.label,
    blurb: phase.blurb,
    buckBase: interpolate(scoring.rutCurve.buckAnchors, offset),
    generalBase: interpolate(scoring.rutCurve.generalAnchors, offset),
  };
}

// Dates worth flagging in the UI. The second-rut window in particular: with a Nov 18
// peak that lands in mid-to-late December, when most hunters have already quit.
export function seasonHighlights(scoring, season) {
  const peak = scoring.peakRutDate;
  const shift = (days) => {
    const d = new Date(`${peak}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  };
  return [
    { key: 'seeking',  label: 'Seeking opens',      date: shift(-20), note: 'Daylight cruising starts climbing.' },
    { key: 'chasing',  label: 'Chasing window',     date: shift(-7),  through: shift(-2), note: 'Most sustained daylight buck movement of the season. Best PTO block if you only get one.' },
    { key: 'lockdown', label: 'Lockdown',           date: shift(-1),  through: shift(3),  note: 'Sightings dip off the chasing peak. Midday sits are live; odd hours matter.' },
    { key: 'postrut',  label: 'Post-rut lull',      date: shift(4),   through: shift(14), note: 'Hardest stretch of the season. Save your PTO.' },
    { key: 'second',   label: 'Second rut',         date: shift(21),  through: shift(35), note: 'Secondary bump centered near ' + shift(28) + '. Most hunters have written the season off by then.' },
  ].filter((h) => !season || (h.date <= season.end));
}
