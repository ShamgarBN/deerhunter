// Great-circle distance and true compass bearings.
//
// The whole scent-safety model reduces to one question: is the wind carrying my
// scent toward a bearing where deer are, or away from it? That needs real bearings,
// which needs real coordinates, which is why map points are stored as lat/lng.

const R_YARDS = 6371000 * 1.09361; // Earth radius in yards

const toRad = (d) => (d * Math.PI) / 180;
const toDeg = (r) => (r * 180) / Math.PI;

export function distanceYards(a, b) {
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const la1 = toRad(a.lat);
  const la2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
  return 2 * R_YARDS * Math.asin(Math.min(1, Math.sqrt(h)));
}

// Initial bearing from a to b, in degrees clockwise from true north.
export function bearingDeg(a, b) {
  const la1 = toRad(a.lat);
  const la2 = toRad(b.lat);
  const dLon = toRad(b.lon - a.lon);
  const y = Math.sin(dLon) * Math.cos(la2);
  const x =
    Math.cos(la1) * Math.sin(la2) -
    Math.sin(la1) * Math.cos(la2) * Math.cos(dLon);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/**
 * The inverse of bearingDeg + distanceYards: where you land starting at `from`, walking
 * `bearing` degrees true for `yards`.
 *
 * Needed to put an observation back on the map. A sighting is recorded the way it is seen
 * from the stand, as a bearing and a distance, because that is what a hunter can actually
 * estimate. Drawing it requires turning that polar pair back into a coordinate.
 */
export function destinationPoint(from, bearing, yards) {
  if (from?.lat == null || from?.lon == null || bearing == null || yards == null) return null;
  const d = yards / R_YARDS;
  const br = toRad(bearing);
  const la1 = toRad(from.lat);
  const lo1 = toRad(from.lon);
  const la2 = Math.asin(Math.sin(la1) * Math.cos(d) + Math.cos(la1) * Math.sin(d) * Math.cos(br));
  const lo2 = lo1 + Math.atan2(
    Math.sin(br) * Math.sin(d) * Math.cos(la1),
    Math.cos(d) - Math.sin(la1) * Math.sin(la2),
  );
  return { lat: toDeg(la2), lon: ((toDeg(lo2) + 540) % 360) - 180 };
}

// Smallest angle between two compass bearings, 0-180.
export function angularDiff(a, b) {
  const d = Math.abs(((a - b) % 360 + 360) % 360);
  return d > 180 ? 360 - d : d;
}

const COMPASS_16 = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];

export function degToCompass(deg) {
  if (deg == null || Number.isNaN(deg)) return null;
  const i = Math.round((((deg % 360) + 360) % 360) / 22.5) % 16;
  return COMPASS_16[i];
}

export function compassToDeg(name) {
  const i = COMPASS_16.indexOf(String(name || '').toUpperCase());
  return i === -1 ? null : i * 22.5;
}

export { COMPASS_16 };

// --- area features ----------------------------------------------------------
//
// A bean field is not a point. Measuring to its centroid understates how close a stand
// on the field edge really is, and for the scent check it is worse than that: scent can
// blow across half a field while the bearing to the centroid reads clear.
//
// So food, water and bedding can each be drawn as a polygon instead of dropped as a pin.
// Distance is measured to the nearest EDGE (zero when the stand is inside), and the
// scent check samples the whole boundary rather than one representative point.
//
// The math below treats lat/lon as a local plane scaled by cos(latitude). Over a sub-100
// acre property that error is far below the precision of a hand-drawn field boundary.

const latLonToXY = (p, originLat) => ({
  x: p.lon * Math.cos(toRad(originLat)),
  y: p.lat,
});

// Closest point on segment ab to p, all in the projected plane.
function closestOnSegment(p, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return a;
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return { x: a.x + t * dx, y: a.y + t * dy };
}

// Ray casting. Used so a stand inside a field reads zero distance rather than the
// distance to whichever edge happens to be nearest.
export function pointInRing(p, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [yi, xi] = ring[i];
    const [yj, xj] = ring[j];
    if ((xi > p.lon) !== (xj > p.lon)) {
      const yAt = ((yj - yi) * (p.lon - xi)) / (xj - xi) + yi;
      if (p.lat < yAt) inside = !inside;
    }
  }
  return inside;
}

// Nearest point on the ring boundary, returned as {lat, lon}.
export function nearestPointOnRing(p, ring) {
  const origin = p.lat;
  const pp = latLonToXY(p, origin);
  let best = null;
  let bestD2 = Infinity;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = latLonToXY({ lat: ring[j][0], lon: ring[j][1] }, origin);
    const b = latLonToXY({ lat: ring[i][0], lon: ring[i][1] }, origin);
    const c = closestOnSegment(pp, a, b);
    const d2 = (c.x - pp.x) ** 2 + (c.y - pp.y) ** 2;
    if (d2 < bestD2) { bestD2 = d2; best = c; }
  }
  if (!best) return null;
  return { lat: best.y, lon: best.x / Math.cos(toRad(origin)) };
}

export function distanceToRingYards(p, ring) {
  if (!ring || ring.length < 3) return null;
  if (pointInRing(p, ring)) return 0;
  const near = nearestPointOnRing(p, ring);
  return near ? distanceYards(p, near) : null;
}

// Evenly spaced samples along the boundary, used by the scent check so a plume that
// clips one corner of a bedding area is not missed by a single centroid bearing.
export function sampleRing(ring, maxSamples = 48) {
  if (!ring || ring.length < 3) return [];
  const out = [];
  const perEdge = Math.max(1, Math.floor(maxSamples / ring.length));
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [lat0, lon0] = ring[j];
    const [lat1, lon1] = ring[i];
    for (let k = 0; k < perEdge; k++) {
      const t = k / perEdge;
      out.push({ lat: lat0 + (lat1 - lat0) * t, lon: lon0 + (lon1 - lon0) * t });
    }
  }
  return out;
}

export function ringCentroid(ring) {
  if (!ring || !ring.length) return null;
  // Area-weighted centroid, falling back to the vertex mean for a degenerate ring.
  let a = 0; let cx = 0; let cy = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [y0, x0] = ring[j];
    const [y1, x1] = ring[i];
    const f = x0 * y1 - x1 * y0;
    a += f; cx += (x0 + x1) * f; cy += (y0 + y1) * f;
  }
  if (Math.abs(a) < 1e-12) {
    return { lat: ring.reduce((s, r) => s + r[0], 0) / ring.length, lon: ring.reduce((s, r) => s + r[1], 0) / ring.length };
  }
  a *= 0.5;
  return { lat: cy / (6 * a), lon: cx / (6 * a) };
}

export function ringAcres(ring) {
  if (!ring || ring.length < 3) return null;
  const originLat = ring[0][0];
  const k = Math.cos(toRad(originLat));
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const x0 = ring[j][1] * k; const y0 = ring[j][0];
    const x1 = ring[i][1] * k; const y1 = ring[i][0];
    a += x0 * y1 - x1 * y0;
  }
  const sqDeg = Math.abs(a) / 2;
  const metersPerDeg = 111320;
  return +((sqDeg * metersPerDeg * metersPerDeg) / 4046.86).toFixed(2);
}

// --- line features ----------------------------------------------------------
//
// A creek is neither a pin nor a polygon. Measuring to a single point on it is wrong in
// the same way measuring to a field's centroid is wrong, and worse for a creek that runs
// the length of the property: a stand 40 yards off the water can read several hundred
// yards to whichever point happened to get dropped.
//
// So water, food and bedding can each be drawn as a polyline. Distance is to the nearest
// point anywhere along the path, and the scent check samples the whole run.

export function nearestPointOnPath(p, path) {
  if (!path || path.length < 2) return null;
  const origin = p.lat;
  const pp = latLonToXY(p, origin);
  let best = null;
  let bestD2 = Infinity;
  for (let i = 1; i < path.length; i++) {
    const a = latLonToXY({ lat: path[i - 1][0], lon: path[i - 1][1] }, origin);
    const b = latLonToXY({ lat: path[i][0], lon: path[i][1] }, origin);
    const c = closestOnSegment(pp, a, b);
    const d2 = (c.x - pp.x) ** 2 + (c.y - pp.y) ** 2;
    if (d2 < bestD2) { bestD2 = d2; best = c; }
  }
  if (!best) return null;
  return { lat: best.y, lon: best.x / Math.cos(toRad(origin)) };
}

export function distanceToPathYards(p, path) {
  const near = nearestPointOnPath(p, path);
  return near ? distanceYards(p, near) : null;
}

export function pathLengthYards(path) {
  if (!path || path.length < 2) return 0;
  let total = 0;
  for (let i = 1; i < path.length; i++) {
    total += distanceYards({ lat: path[i - 1][0], lon: path[i - 1][1] }, { lat: path[i][0], lon: path[i][1] });
  }
  return Math.round(total);
}

// Samples spaced along the run, so a long creek is tested end to end rather than at its
// vertices only. Density is capped so a hand-drawn 40-point path stays cheap to evaluate.
export function samplePath(path, maxSamples = 48) {
  if (!path || path.length < 2) return [];
  const out = [];
  const perSeg = Math.max(1, Math.floor(maxSamples / (path.length - 1)));
  for (let i = 1; i < path.length; i++) {
    const [lat0, lon0] = path[i - 1];
    const [lat1, lon1] = path[i];
    for (let k = 0; k < perSeg; k++) {
      const t = k / perSeg;
      out.push({ lat: lat0 + (lat1 - lat0) * t, lon: lon0 + (lon1 - lon0) * t });
    }
  }
  out.push({ lat: path.at(-1)[0], lon: path.at(-1)[1] });
  return out;
}

// Midpoint by distance along the run, used as the label pin for a line feature. The
// vertex mean would drift toward whichever end you clicked more densely.
export function pathMidpoint(path) {
  if (!path || !path.length) return null;
  if (path.length === 1) return { lat: path[0][0], lon: path[0][1] };
  const half = pathLengthYards(path) / 2;
  let run = 0;
  for (let i = 1; i < path.length; i++) {
    const a = { lat: path[i - 1][0], lon: path[i - 1][1] };
    const b = { lat: path[i][0], lon: path[i][1] };
    const seg = distanceYards(a, b);
    if (run + seg >= half) {
      const t = seg === 0 ? 0 : (half - run) / seg;
      return { lat: a.lat + (b.lat - a.lat) * t, lon: a.lon + (b.lon - a.lon) * t };
    }
    run += seg;
  }
  return { lat: path.at(-1)[0], lon: path.at(-1)[1] };
}

// One call that works for every shape. Everything downstream uses this rather than
// branching on whether a feature happens to be a pin or an area.
export function distanceToFeatureYards(from, feature) {
  const ring = feature?.shape?.ring;
  if (ring && ring.length >= 3) return distanceToRingYards(from, ring);
  const path = feature?.shape?.path;
  if (path && path.length >= 2) return distanceToPathYards(from, path);
  if (feature?.lat == null || feature?.lon == null) return null;
  return distanceYards(from, feature);
}

// Points to test in the scent check: the boundary for an area, the whole run for a line,
// the pin itself otherwise.
export function scentTargets(feature) {
  const ring = feature?.shape?.ring;
  if (ring && ring.length >= 3) return sampleRing(ring);
  const path = feature?.shape?.path;
  if (path && path.length >= 2) return samplePath(path);
  if (feature?.lat == null) return [];
  return [{ lat: feature.lat, lon: feature.lon }];
}
