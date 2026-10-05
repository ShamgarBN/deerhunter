// Wind as a STAND FILTER, not a movement predictor.
//
// This is the one place wind is allowed to matter, and it is deliberately isolated from
// scoring.js. The collar research found wind has negligible-to-modest effect on whether
// deer move at all, but it is decisive for whether Ben can sit a given stand without
// being smelled. Letting "wind" appear in both the movement model and the stand filter
// would be double-counting one variable doing two unrelated jobs.
//
// The only exception is the rain/wind interaction inside scoring.js, where wind speed
// modulates the rain effect. That is a documented finding, not a second wind term.
//
// Geometry:
//   Meteorological wind direction is where the wind comes FROM.
//   Scent travels the direction the wind blows TOWARD = (windDir + 180) mod 360.
//   A stand is scent-safe relative to a point when the angle between the scent
//   bearing and the stand-to-point bearing exceeds the safety threshold.
//
// Verdicts are graded rather than binary. A scent plume is a cone, not a ray: it
// spreads roughly 30-45 degrees either side as it moves downwind. So the angle off
// a point falls into three bands:
//   > safeAngleThresholdDeg (default 115)  clear, the plume misses entirely
//   grazingAngleDeg to threshold           marginal, the edge of the plume brushes it
//   < grazingAngleDeg (default 60)         direct hit
// Without the middle band every stand pinched between bedding and food reports zero
// safe winds, which is technically defensible and practically useless.

import { distanceYards, bearingDeg, angularDiff, degToCompass, compassToDeg, COMPASS_16,
         distanceToFeatureYards, scentTargets } from './geo.js';

export const scentBearing = (windDirDeg) => (windDirDeg + 180) % 360;

// Evaluate one stand against every nearby bedding and food point for a given wind.
//
// `strictness` scales the safe-angle threshold by weapon. A rifle hunter kills the deer
// at 150 yards; an archer waits while it walks to 30, spending far longer inside the
// scent cone. At 1.25 the 115-degree threshold becomes 144, so a wind that is a caution
// for gun reads blown for bow. Same geometry, different tolerance, which is the honest
// difference between the two hunts.
export function evaluateStand(stand, map, windDirDeg, cfg, strictness = 1) {
  const thr = Math.min(175, cfg.scent.safeAngleThresholdDeg * strictness);
  const grazing = Math.min(thr - 5, (cfg.scent.grazingAngleDeg ?? 60) * strictness);
  const scent = scentBearing(windDirDeg);
  const conflicts = [];
  const clear = [];

  for (const p of map.points) {
    if (p.type !== 'bedding' && p.type !== 'food') continue;
    if (p.type === 'water' && p.active === false) continue;
    const radius = p.type === 'bedding' ? cfg.scent.beddingRadiusYards : cfg.scent.foodRadiusYards;
    const dist = distanceToFeatureYards(stand, p);
    if (dist == null || dist > radius) continue;

    // For an area, test the whole boundary and keep the WORST case. A plume that clips
    // one corner of a bedding thicket busts the sit just as thoroughly as one down the
    // middle, and a single centroid bearing would report that corner as clear.
    const targets = scentTargets(p);
    let off = 180;
    let toPoint = bearingDeg(stand, p);
    for (const t of targets) {
      if (distanceYards(stand, t) > radius * 1.25) continue;
      const b = bearingDeg(stand, t);
      const o = angularDiff(scent, b);
      if (o < off) { off = o; toPoint = b; }
    }
    const band = off > thr ? 'clear' : off > grazing ? 'marginal' : 'direct';
    const entry = {
      id: p.id,
      type: p.type,
      label: p.label,
      distanceYards: Math.round(dist),
      bearingDeg: Math.round(toPoint),
      bearingCompass: degToCompass(toPoint),
      scentOffsetDeg: Math.round(off),
      band,
      isArea: !!(p.shape?.ring?.length >= 3),
      safe: band === 'clear',
    };
    if (band === 'clear') clear.push(entry); else conflicts.push(entry);
  }

  // Bedding outranks food. Blowing scent into a food source costs you that food source
  // for the evening; blowing it into bedding costs you the deer, and possibly the stand
  // for a week. Deer approach food FROM bedding, so bedding-relative safety is what
  // actually keeps a sit from getting busted.
  const bedDirect = conflicts.some((c) => c.type === 'bedding' && c.band === 'direct');
  const bedMarginal = conflicts.some((c) => c.type === 'bedding' && c.band === 'marginal');
  const foodDirect = conflicts.some((c) => c.type === 'food' && c.band === 'direct');

  let verdict = 'safe';
  if (bedDirect) verdict = 'unsafe';
  else if (bedMarginal || foodDirect) verdict = 'caution';

  // Numeric margin for ranking winds against each other. The worst offset against a
  // bedding point drives it, because that is the one that ends the hunt.
  const bedOffsets = [...conflicts, ...clear].filter((c) => c.type === 'bedding').map((c) => c.scentOffsetDeg);
  const margin = bedOffsets.length ? Math.min(...bedOffsets) : 180;

  return {
    verdict,
    margin,
    thresholdDeg: Math.round(thr),
    strictness,
    windDirDeg: Math.round(windDirDeg),
    windCompass: degToCompass(windDirDeg),
    scentBearingDeg: Math.round(scent),
    scentCompass: degToCompass(scent),
    conflicts: conflicts.sort((a, b) => a.distanceYards - b.distanceYards),
    clear: clear.sort((a, b) => a.distanceYards - b.distanceYards),
    evaluatedPoints: conflicts.length + clear.length,
  };
}

// Which of the 16 compass sectors are geometrically safe for this stand. Used to show
// a wind rose on the Map tab and to compare against Ben's manual tags.
export function safeWindSectors(stand, map, cfg, strictness = 1) {
  const safe = [];
  const caution = [];
  const unsafe = [];
  const ranked = [];
  for (const name of COMPASS_16) {
    const deg = compassToDeg(name);
    const r = evaluateStand(stand, map, deg, cfg, strictness);
    ranked.push({ wind: name, verdict: r.verdict, margin: r.margin });
    if (r.verdict === 'safe') safe.push(name);
    else if (r.verdict === 'caution') caution.push(name);
    else unsafe.push(name);
  }
  // Best-available ranking matters for stands hemmed in by bedding on one side and
  // food on the other, where nothing is fully clear but some winds are far less bad.
  ranked.sort((a, b) => b.margin - a.margin);
  return { safe, caution, unsafe, best: ranked.slice(0, 4), ranked };
}

// Combine Ben's experience with the computed geometry.
//
// Manual tags win. He has sat these stands and watched deer blow out of them; the
// geometry has a guessed bedding polygon and a 115-degree rule of thumb. When the two
// disagree the geometry is shown as a secondary note, never auto-resolved, because a
// disagreement is usually information (a bedding area in the wrong spot on the map,
// or a terrain funnel the flat model cannot see).
export function standVerdict(stand, map, windDirDeg, cfg, wind = null, strictness = 1) {
  const geom = evaluateStand(stand, map, windDirDeg, cfg, strictness);

  // Gate on how trustworthy the wind forecast is before reporting any verdict at all.
  //
  // The geometry is exact; the wind it is fed is not. Below roughly 3 mph thermals decide
  // where scent goes and the bearing is close to meaningless, yet the first build rendered
  // a confident safe/caution/blown call at 1 mph just as readily as at 15. It was most
  // assertively wrong on precisely the calm mornings you would most want to hunt.
  //
  // So: when confidence falls under the threshold, the verdict becomes 'unreliable' and
  // the computed geometry is demoted to a note. Saying "I cannot tell you" is worth more
  // than a clean answer that is arbitrary.
  if (wind && wind.confidence != null && wind.confidence < (wind.minConfidence ?? 0.3)) {
    return {
      ...geom,
      verdict: 'unreliable',
      source: 'wind-confidence',
      windConfidence: wind.confidence,
      windConfidenceLabel: wind.label,
      geometryVerdict: geom.verdict,
      note: `Wind is too ${wind.windMph != null && wind.windMph < 3 ? 'light' : 'inconsistent'} to call scent from a forecast bearing`
        + `${wind.windMph != null ? ` (${wind.windMph.toFixed(1)} mph` : ''}`
        + `${wind.steadiness != null ? `, steadiness ${wind.steadiness.toFixed(2)}` : ''}${wind.windMph != null ? ')' : ''}. `
        + `Geometry would say ${geom.verdict} on a ${degToCompass(windDirDeg)}, but on a morning like this thermals decide. `
        + `Read the thermal note and your own wind checker in the stand.`,
    };
  }
  const windCompass = degToCompass(windDirDeg);
  const manual = Array.isArray(stand.safeWinds) && stand.safeWinds.length
    ? stand.safeWinds.map((w) => String(w).toUpperCase())
    : null;

  if (!manual) {
    return {
      ...geom,
      source: 'geometry',
      manualTagged: false,
      windConfidence: wind?.confidence ?? null,
      windConfidenceLabel: wind?.label ?? null,
      note: map.points.some((p) => p.type === 'bedding')
        ? null
        : 'No bedding marked yet, so this verdict is based on food points alone. Mark bedding on the Map tab to make it meaningful.',
    };
  }

  // Treat an adjacent sector as tagged-safe too: nobody's experience is precise to 22.5
  // degrees, and a stand that works on a W wind works on a WNW wind.
  const adj = new Set();
  for (const w of manual) {
    const i = COMPASS_16.indexOf(w);
    if (i === -1) continue;
    adj.add(COMPASS_16[i]);
    adj.add(COMPASS_16[(i + 1) % 16]);
    adj.add(COMPASS_16[(i + 15) % 16]);
  }

  const manualSafe = manual.includes(windCompass);
  const manualAdjacent = !manualSafe && adj.has(windCompass);
  const manualVerdict = manualSafe ? 'safe' : manualAdjacent ? 'caution' : 'unsafe';

  const agrees = manualVerdict === geom.verdict;
  return {
    ...geom,
    verdict: manualVerdict,
    source: 'manual',
    manualTagged: true,
    windConfidence: wind?.confidence ?? null,
    windConfidenceLabel: wind?.label ?? null,
    manualSafeWinds: manual,
    geometryVerdict: geom.verdict,
    agrees,
    note: agrees
      ? null
      : `Your tags say ${manualVerdict} on a ${windCompass} wind; the map geometry computes ${geom.verdict}. Your tags win. A persistent disagreement usually means a bedding marker is in the wrong place.`,
  };
}

// Thermals, as plain-text cautions rather than a false-precision number.
//
// Modeling thermal flow properly needs elevation data this property's map does not
// carry, and inventing a number from a terrain dropdown would be worse than saying
// nothing. So: terrain tags plus time of day, and a sentence when the combination is
// the known-bad one.
export function thermalNotes(stand, map, slot, cfg, terrainPositions) {
  const notes = [];
  const tier = terrainPositions?.[stand.terrain]?.tier ?? null;

  if (!stand.terrain) {
    notes.push('No terrain tag on this stand. Tag it ridge, midslope or valley on the Map tab and the thermal cautions turn on.');
    return notes;
  }

  if (slot === 'PM' && stand.terrain === 'valley') {
    notes.push('Evening thermal drain: falling thermals pool into the low ground and can pull your scent off a wide area into this bottom. A valley stand in the last hour of light is the classic way to get winded by deer you never see.');
  }

  if (slot === 'AM' && tier != null) {
    const uphillBedding = map.points.filter((p) => {
      if (p.type !== 'bedding') return false;
      const pTier = terrainPositions?.[p.terrain]?.tier ?? null;
      const d = distanceToFeatureYards(stand, p);
      return pTier != null && pTier > tier && d != null && d <= cfg.scent.beddingRadiusYards;
    });
    if (uphillBedding.length) {
      notes.push(`Morning thermals rise. ${uphillBedding.map((p) => p.label).join(', ')} sits above this stand, so at first light your scent goes uphill into it regardless of what the forecast wind says. Consider a different stand or a later entry.`);
    }
  }

  if (slot === 'PM' && stand.terrain === 'ridge') {
    notes.push('Ridge position in the evening: falling thermals carry scent downhill away from you. Generally the safer evening choice on this property.');
  }

  if (stand.terrain === 'midslope') {
    notes.push('Midslope is where thermals are least predictable, especially in the 30 minutes either side of sunrise and sunset when they switch direction. Treat the wind call here as lower confidence.');
  }

  return notes;
}
