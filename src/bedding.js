// Where the sightings say bedding is, versus where the map says it is.
//
// The scent model is only as good as the bedding markers: standVerdict asks whether your
// scent blows toward bedding, so a thicket you never marked is a stand the tool will
// happily call safe while you get winded from it every time. Nothing else in the tool can
// catch that, because every other input is downstream of the same markers.
//
// The sighting log can catch it, because it is the one source that does not come from the
// map. This looks for directions that keep producing deer and have nothing marked behind
// them.

import { getDb } from './db.js';
import { loadMap, loadConfig } from './config.js';
import { destinationPoint, bearingDeg, distanceYards, degToCompass, angularDiff } from './geo.js';

/**
 * Which way bedding lies from a sighting, given the slot.
 *
 * Evening and morning are mirror images, and conflating them would smear the two into
 * noise. In the evening deer are leaving bed for food, so bedding is back along the way
 * they came. In the morning they are heading back to bed, so bedding is ahead of them.
 *
 * Without a travel bearing there is no directional claim to make. The bearing from the
 * stand to the animal is NOT a substitute: it says where the deer was standing, which is
 * a point on the route and says nothing about which end of it the bedding is at.
 */
export function beddingBearing({ slot, travelDeg }) {
  if (travelDeg == null) return null;
  return slot === 'AM' ? travelDeg : (travelDeg + 180) % 360;
}

const SECTOR = 45;  // eight-point sectors: finer than that is false precision from a hunter's estimate

/**
 * Candidate bedding directions with nothing marked behind them.
 *
 * `toleranceDeg` is how far off a marked bedding area can be and still count as "that is
 * already on the map". It is wide on purpose: a bedding thicket is an area, estimated
 * bearings are rough, and the cost of a false "you missed one" is a wasted walk, while the
 * cost of a false "already marked" is the thing this exists to catch.
 */
export function beddingGaps({ minSightings = 2, toleranceDeg = 50, projectYards = 250 } = {}) {
  const db = getDb();
  const map = loadMap();
  const cfg = loadConfig();

  const stands = new Map(map.points.filter((p) => p.type === 'stand').map((p) => [p.id, p]));
  const bedding = map.points.filter((p) => p.type === 'bedding');

  const rows = db.prepare(`
    SELECT g.travel_deg, g.bearing_deg, g.distance_yards, g.deer_count, g.buck_count,
           s.slot, s.date, s.stand_id, s.stand_label
      FROM sightings g JOIN sits s ON s.id = g.sit_id
     WHERE g.travel_deg IS NOT NULL
  `).all();

  const usable = [];
  for (const r of rows) {
    const stand = r.stand_id ? stands.get(r.stand_id) : null;
    if (!stand || r.bearing_deg == null || r.distance_yards == null) continue;
    const bear = beddingBearing({ slot: r.slot, travelDeg: r.travel_deg });
    if (bear == null) continue;
    const seen = destinationPoint({ lat: stand.lat, lon: stand.lon }, r.bearing_deg, r.distance_yards);
    usable.push({ ...r, stand, seen, beddingBearing: bear });
  }

  // Group by stand and eight-point sector of the inferred bedding direction, so the
  // question stays "from this stand, that way" rather than an average over the property.
  const groups = new Map();
  for (const u of usable) {
    const sector = Math.round(u.beddingBearing / SECTOR) % (360 / SECTOR);
    const key = `${u.stand.id}|${sector}`;
    if (!groups.has(key)) groups.set(key, { stand: u.stand, sector, items: [] });
    groups.get(key).items.push(u);
  }

  const gaps = [];
  const confirmed = [];
  for (const g of groups.values()) {
    if (g.items.length < minSightings) continue;
    const center = g.sector * SECTOR;
    const origin = { lat: g.stand.lat, lon: g.stand.lon };

    // Is anything already marked that way? Measured as the bearing from the stand to each
    // bedding feature, which is the same frame the scent check uses.
    const matches = bedding
      .map((b) => ({ b, off: angularDiff(bearingDeg(origin, { lat: b.lat, lon: b.lon }), center) }))
      .filter((m) => m.off <= toleranceDeg)
      .sort((a, b) => a.off - b.off);

    const deer = g.items.reduce((a, x) => a + (x.deer_count ?? 1), 0);
    const bucks = g.items.reduce((a, x) => a + (x.buck_count ?? 0), 0);
    const entry = {
      standId: g.stand.id,
      standLabel: g.stand.label,
      bearing: center,
      compass: degToCompass(center),
      sightings: g.items.length,
      deer,
      bucks,
      dates: [...new Set(g.items.map((x) => x.date))].sort(),
      // Where to walk if you go looking. A nominal projection, not a claim about range:
      // it says "that way from this stand", at a distance you can actually cover on foot.
      lookAt: destinationPoint(origin, center, projectYards),
      projectedYards: projectYards,
    };

    if (matches.length) {
      confirmed.push({
        ...entry,
        matchedLabel: matches[0].b.label,
        matchedOffDeg: Math.round(matches[0].off),
        matchedYards: Math.round(distanceYards(origin, { lat: matches[0].b.lat, lon: matches[0].b.lon })),
      });
    } else {
      gaps.push(entry);
    }
  }

  const sortKey = (x) => -(x.sightings * 10 + x.bucks);
  gaps.sort((a, b) => sortKey(a) - sortKey(b));
  confirmed.sort((a, b) => sortKey(a) - sortKey(b));

  return {
    gaps,
    confirmed,
    stats: {
      sightingsTotal: rows.length,
      withTravelAndPosition: usable.length,
      beddingMarked: bedding.length,
      minSightings,
      toleranceDeg,
    },
    // Said plainly rather than left for the caller to infer from an empty array, because
    // "no gaps found" and "not enough data to find any" look identical otherwise.
    verdict: usable.length < minSightings
      ? `Not enough yet: ${usable.length} sighting(s) carry both a position and a heading, and a direction needs ${minSightings} before it is worth walking.`
      : gaps.length
        ? `${gaps.length} direction(s) producing deer with no bedding marked behind them.`
        : 'Every direction that produced deer already has bedding marked behind it.',
    property: cfg.property?.name ?? null,
  };
}
