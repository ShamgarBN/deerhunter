# Annual pre-season tune-up

Hand the block below to whatever version of Claude Code exists next season, the same way
`/reflect` and `/handoff` get used on the other projects. Run it before the season opens,
with enough lead time that a rut-date change can still affect PTO planning — mid-to-late
September is about right.

Everything the review needs is already in the repo: the sit log and score history live in
`data/deerhunter.db`, the weights and their research provenance in `config/scoring.json`,
and the property in `config/map.json`.

---

## The prompt

```
Review this hunt-predictor project ahead of the upcoming rifle season. Specifically:

1. Pull the full sit log and season history from last season. Compare actual sightings
   against what the tool predicted, by factor, and run the reweighting update described
   in the main build prompt if it hasn't already run.

2. Recheck the core research this tool is built on: rut-timing science, the moon-phase
   studies, and the weather/movement GPS-collar research. Note anything that's been
   superseded or meaningfully added to since the last review, and flag it to Ben rather
   than changing the model unilaterally.

3. Verify the National Weather Service API and the moon/sun calculation library are still
   current and still the best free option available. Note any breaking changes.

4. Ask Ben whether anything about the property changed: new stands, new food plots, water
   sources that dried up or came back, drought status, anything the map should reflect.

5. Ask whether any factors got missed originally or are worth adding now that a season of
   real data exists.

6. Update the documentation and code comments to reflect whatever changes come out of this
   review, so the next annual pass has an accurate starting point.
```

---

## Notes for whoever runs it

### Commands that do the mechanical parts

```bash
node src/cli.js sits                  # the raw log
npm run reweight                      # dry-run the fit, writes nothing
npm run reweight -- --apply           # write it, with every change logged
npm run reweight -- --history         # what has already moved, and why
npm run score -- --calibrate          # refit the 0-10 scale after map changes
```

### Things that are deliberate, not bugs

Read `config/scoring.json`'s `_methodology` field before changing any weight. The short
version: this model is grounded in GPS-collar research rather than the popular
hunting-app consensus, and that was Ben's explicit choice. Three consequences look wrong
at a glance and are not:

- **Moon carries a weight of exactly zero** and is `frozen: true`, so reweighting reports
  what it would have fitted but never writes it. Multiple independent studies found no
  measurable movement effect. If several seasons of real data ever show a consistent and
  sizeable moon effect, unfreeze it deliberately, here, with Ben in the loop. Do not let
  it drift in on noise.
- **There is no cold-front factor.** Temperature departure covers it at a modest weight,
  flagged `reweightCandidate: true` because it has the least research consensus of
  anything in the model. It is the first thing that should move if the data says so.
- **The rut curve peaks during chasing, not at the peak breeding date.** Lockdown drops
  it. That is real and it is the whole reason the curve is a table of day-offsets rather
  than a bell curve. Do not "fix" it to peak at day 0.
- **The proximity curves are fitted to this property, not chosen.** `proximityCurves` in
  `config/scoring.json` keeps a `fittedFrom` list of the real stand-to-feature distances
  each curve came from. The numbers look arbitrary and are not. A fixed threshold cannot
  discriminate when every stand lands on one side of it, which is exactly what the
  original 60 yd food and 80 yd water guesses did: two water sources 13 and 38 yd out
  both scored a flat +1. Re-run `npm run score -- --calibrate` after the map changes
  instead of hand-editing them. The fit declines to run with fewer than two stands, or
  when stands sit within 40 yd of each other, where stretching the curve would invent a
  distinction out of noise.

Wind appears in exactly two places and does two different jobs: inside the precipitation
factor as the documented rain-cancelling interaction, and in `src/wind.js` as a stand
filter that never touches the movement score. Keep it that way.

### Raised with Ben and declined

A mid-build audit flagged these as genuine model gaps. Ben considered each and said no,
with reasons that are specific to how he hunts this property. They are closed, not
pending, so do not re-propose them as oversights. Each note says what would reopen it.

- **Hunting pressure stays per-stand.** `lastHuntedByStand[s.id]` in `src/scoring.js`
  means sitting one stand does not decay any other stand's score. The audit argued deer
  respond to intrusion across the property rather than per-stand bookkeeping. Ben's
  answer: he enters from various points, so a sit at one stand genuinely does not
  disturb the approach to another. A property-wide term assumes one entry corridor, which
  is wrong here. Reopens only if he starts entering from a single access point.
- **Access routes stay unscored.** The geometry to detect walking past bedding in the
  dark already exists, and the audit called that a known sit-killer. Ben declined. They
  remain reference-only lines on the map, the same as game trails.
- **Food gets no seasonality.** Standing beans in October and bare stubble in November
  are one static distance, and a mast crop that is gone by December never changes. The
  audit flagged it; Ben was not concerned enough to spend time on it. Leave it alone
  unless he raises it, and do not model it as a silent improvement.
- **Stand height stays unscored.** The field is stored and served but no scoring code
  reads it, and that is correct here: every stand on this property sits 6-8 ft up, so the
  variable has no spread to discriminate on. This is the same trap the old fixed proximity
  thresholds fell into, from the other direction. The field is kept as metadata rather
  than dropped, because a future tower stand at 20 ft would give it real variance and
  reopen the question.

### Check the season dates and zone first, every year

State wildlife agencies publish fresh season dates annually and redraw zones from time to
time, often for disease management. Zones are drawn by county nearly everywhere.

This matters more than it sounds. The original build spec for this tool named the wrong
zone and an opening date four weeks late, which would have hidden the first month of the
season outright. Verify against the current official sheet before anything else, and
confirm the property's county from its coordinates rather than assuming. `npm run setup`
does this via the Census Bureau geocoder, falling back to the FCC block API. Worth
re-checking both still respond: the FCC endpoint returned a backend authentication error
mid-build, having worked earlier the same day.

Also check the antlerless-season column. This tool doesn't model antlerless restrictions,
and if that becomes relevant it's a scope change worth discussing rather than quietly
encoding.

### Land cover is wired in but deliberately unscored

The tool samples NLCD 2021 (30 m, keyless, via MRLC) at every stand and feature, detects
edge habitat, and lets Ben override it with hand-drawn woods/field areas. It carries **no
scoring weight**, by design.

If a season of sit-log data suggests edge proximity predicts sightings, that is a real
candidate for a new factor — and the right way to add it is through the reweighting system
with a stated prior, not by asserting a weight. Raise it with Ben rather than adding it
unilaterally.

Re-check when reviewing: whether MRLC has published a newer NLCD vintage (the layer name
is in `src/cover.js` as `NLCD_2021_Land_Cover_L48`; the capabilities document lists what is
available), and whether the USDA CropScape crop-type API has become usable, which would
give per-year crop identification that NLCD cannot.

### Sighting detail is captured but unscored

`sightings` hangs off `sits` and holds what a deer count throws away: bearing from the
stand, distance, what the animal was doing, and the time, normalised to signed minutes
from sunrise or sunset so a 7:05am sighting in October and one in December are comparable.

This is the first review that may have some. It is worth real attention, because it is the
only data here that a reweighting pass cannot use and cannot reconstruct:

- Does movement cluster at a particular offset from first light, and does that offset move
  as the rut progresses? The sit windows are five hours; if everything happens in one of
  them, that is worth knowing before Ben spends the other four in a stand.
- Do bearings cluster? Consistent approach directions are evidence about bedding and trail
  placement that the map may currently have in the wrong place, and the scent geometry
  depends on those markers being right.
- Does behavior split by rut phase the way the curve assumes? Chasing observations
  clustering away from the modelled chasing window is the single best reason to move the
  peak rut date off its default.

Do not add a scoring factor from it unilaterally. If it suggests one, raise it with Ben
and put it through the reweighting system with a stated prior, the same as any other.

### Comparing predictions against what happened

`fetchArchive` in `src/weather.js` pulls real hourly weather (including barometric
pressure) for any past date range from the Open-Meteo archive, free and keyless. Nothing
calls it in normal operation; it exists for this review. Use it to rebuild the actual
conditions for last season's logged sits, then compare those against what the tool
predicted before running the reweighting pass.

### Questions worth asking Ben directly

- Did the rut feel early or late compared to the Nov 18 default? A season of logged sits
  plus his read is better evidence than another regional average. The date is one value
  in `config/scoring.json` and the whole curve moves with it.
- Which stands did he actually sit, and did the scent-safety verdicts match what happened?
  A stand where the geometry says unsafe but he has never been busted usually means a
  bedding marker is in the wrong place on the map.
- Is the drought over? Severity updates itself from the US Drought Monitor on every
  refresh, so the question is no longer what to set it to, it is whether to trust it.
  Check `drought.mode`, and `drought.asOf` to confirm a refresh actually landed. USDM
  reads the whole county, area-weighted across categories rather than taking the worst
  one present. If Ben knows his own water better than a county-level map does,
  `mode: "manual"` pins his number and still logs what USDM would have said.
- Do the alert thresholds still catch the right slice? They ship split, 8.5 buck and 7.5
  deer, because one cut-off cannot serve two differently-shaped distributions: on this
  property 7.5 caught 17% of buck slots but 40% of general ones. Both are settable from
  the Model tab, which reports the hit rate two ways. Judge against the whole-season
  figure, not the forecast-window one. In October the forecast reaches only pre-rut, and
  tuning to that number sets the threshold far too low for November.

### Verify before trusting

API and data-source details drift. Each of these was checked on 2026-09-18 and should be
re-checked:

| What | Endpoint / package | Checked |
|---|---|---|
| NWS gridpoint forecast | `api.weather.gov/gridpoints/{office}/{x},{y}` | ~8 days temp/sky, ~4 days QPF, pressure unusable (unitless) |
| NWS observations | `api.weather.gov/stations/{id}/observations` | works, reports barometric pressure |
| Open-Meteo forecast + archive | `api.open-meteo.com`, `archive-api.open-meteo.com` | all wind and pressure; 16-day hourly; full historical record |
| NOAA daily normals | `ncei.noaa.gov/access/services/data/v1` dataset `normals-daily` | optional US station normals |
| Esri World Imagery tiles | `services.arcgisonline.com/.../World_Imagery` | keyless, native to z19 |
| USGS imagery + topo tiles | `basemap.nationalmap.gov/arcgis/rest/services/...` | keyless, native only to **z16** here; z17+ returns 404 |
| USDM county statistics | `usdmdataservices.unl.edu/api/CountyStatistics/...` | keyless, weekly area-percent by category |
| suncalc | npm `suncalc` 1.9.0 | sun times and moon illumination |

Re-check the USGS zoom limits if the map looks blank when zoomed in. Each layer sets
`maxNativeZoom` in `public/map.js` so Leaflet upscales rather than requesting tiles that
do not exist; if USGS extends coverage, raising that number sharpens the layer.

If a source dies, the fallbacks already exist: scoring degrades to climatology when the
forecast is unavailable, and the map has four interchangeable basemaps.
