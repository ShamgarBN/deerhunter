// User-defined seasons.
//
// The tool was built around one hardcoded gun season. That was never right: season
// structure is set per state and per county, hunters run several overlapping seasons in a
// year, and which one is open changes what a given day is worth to you.
//
// A season is a labeled date range with a weapon. Everything else follows from those
// three things, including the one piece that is more than a calendar: WEAPON CHANGES THE
// SCENT MATH.
//
// A rifle hunter can kill a deer at 150 yards. An archer needs it inside 30. The same
// wind that is merely a caution for gun ruins a bow sit, because the deer has to walk
// most of the way to you before you can do anything about it. So each weapon carries a
// scent-strictness multiplier applied to the safe-angle threshold, and the same morning
// can honestly read safe for rifle and blown for archery.
//
// Scope: whitetail. The rut curve, the lockdown dip and the time-of-day curve are all
// tuned to whitetail behavior. You can label a season anything you like, but the model
// underneath does not change.

export const WEAPON_PROFILES = {
  archery: {
    label: 'Archery',
    effectiveRangeYards: 35,
    scentStrictness: 1.25,
    note: 'Deer must close to bow range before you can act, so it spends far longer inside your scent cone than it would for a rifle. Scent threshold is tightened 25%.',
  },
  crossbow: {
    label: 'Crossbow',
    effectiveRangeYards: 45,
    scentStrictness: 1.2,
    note: 'Marginally more reach than vertical bow, same fundamental problem: the deer has to come to you.',
  },
  muzzleloader: {
    label: 'Muzzleloader',
    effectiveRangeYards: 125,
    scentStrictness: 1.1,
    note: 'More reach than archery and usually one shot. Slightly tighter than rifle.',
  },
  shotgun: {
    label: 'Shotgun / slug',
    effectiveRangeYards: 125,
    scentStrictness: 1.1,
    note: 'Slug-gun range sits between muzzleloader and rifle.',
  },
  rifle: {
    label: 'Rifle',
    effectiveRangeYards: 250,
    scentStrictness: 1.0,
    note: 'The baseline the scent geometry was calibrated against. Reach enough to kill a deer before it reaches your scent cone.',
  },
  any: {
    label: 'Any weapon',
    effectiveRangeYards: 250,
    scentStrictness: 1.0,
    note: 'Treated as rifle, since that is the permissive case.',
  },
};

export const weaponProfile = (w) => WEAPON_PROFILES[w] ?? WEAPON_PROFILES.any;

const DEFAULT_COLORS = ['#16c784', '#f0b429', '#5ac8fa', '#c084fc', '#ea3943', '#4c9aff', '#8b9bb0'];

export function normalizeSeason(s, i = 0) {
  const weapon = WEAPON_PROFILES[s.weapon] ? s.weapon : 'any';
  return {
    id: s.id || `season-${i}-${(s.label || weapon).toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
    label: s.label || weaponProfile(weapon).label,
    weapon,
    start: s.start,
    end: s.end,
    color: s.color || DEFAULT_COLORS[i % DEFAULT_COLORS.length],
    enabled: s.enabled !== false,
    notes: s.notes ?? '',
  };
}

export function loadSeasons(cfg) {
  const raw = Array.isArray(cfg.seasons) ? cfg.seasons : [];
  return raw
    .map(normalizeSeason)
    .filter((s) => s.start && s.end)
    .sort((a, b) => a.start.localeCompare(b.start));
}

export const enabledSeasons = (cfg) => loadSeasons(cfg).filter((s) => s.enabled);

/** Every season open on a date, earliest-starting first. Seasons routinely overlap. */
export function seasonsOn(date, seasons) {
  return seasons.filter((s) => date >= s.start && date <= s.end);
}

/**
 * The span the tool scores: the union of every enabled season.
 *
 * Union rather than the single widest season, because archery in September and gun in
 * November are both worth scoring and the gap between them is not.
 */
export function scoringRange(seasons) {
  const on = seasons.filter((s) => s.enabled);
  if (!on.length) return null;
  return {
    start: on.reduce((a, s) => (s.start < a ? s.start : a), on[0].start),
    end: on.reduce((a, s) => (s.end > a ? s.end : a), on[0].end),
  };
}

/** Dates covered by at least one enabled season, so gaps between seasons are skipped. */
export function coveredDates(seasons, allDates) {
  const on = seasons.filter((s) => s.enabled);
  return allDates.filter((d) => on.some((s) => d >= s.start && d <= s.end));
}

/**
 * Scent strictness for a date: the STRICTEST weapon open that day.
 *
 * If archery and gun overlap, the archery threshold governs. That is the conservative
 * read and the useful one: a stand reported safe should be safe for whatever you choose
 * to carry, and a bowhunter checking a day during gun season is the person most likely to
 * be let down by a permissive answer.
 */
export function strictnessOn(date, seasons) {
  const open = seasonsOn(date, seasons.filter((s) => s.enabled));
  if (!open.length) return { strictness: 1, weapon: null, seasons: [] };
  const strictest = open.reduce((a, s) =>
    (weaponProfile(s.weapon).scentStrictness > weaponProfile(a.weapon).scentStrictness ? s : a));
  return {
    strictness: weaponProfile(strictest.weapon).scentStrictness,
    weapon: strictest.weapon,
    weaponLabel: weaponProfile(strictest.weapon).label,
    governedBy: strictest.label,
    seasons: open.map((s) => ({ id: s.id, label: s.label, weapon: s.weapon, color: s.color })),
  };
}

/**
 * Legacy shape migration.
 *
 * The first build carried `season` (one gun season) plus loose `archery` and
 * `blackpowder` sub-objects that nothing scored. Fold all three into the seasons array so
 * an existing install keeps working without anyone hand-editing config.
 */
export function migrateLegacy(cfg) {
  if (Array.isArray(cfg.seasons) && cfg.seasons.length) return null;
  const old = cfg.season;
  if (!old?.start) return null;

  const out = [];
  if (old.archery?.start) {
    out.push(normalizeSeason({ label: 'Archery', weapon: 'archery', start: old.archery.start, end: old.archery.end, color: '#16c784' }, 0));
  }
  if (old.blackpowder?.start) {
    out.push(normalizeSeason({ label: 'Blackpowder', weapon: 'muzzleloader', start: old.blackpowder.start, end: old.blackpowder.end, color: '#f0b429' }, 1));
  }
  out.push(normalizeSeason({ label: old.label || 'Gun', weapon: 'rifle', start: old.start, end: old.end, color: '#5ac8fa', notes: old.zone ? `Zone: ${old.zone}` : '' }, 2));
  return out;
}
