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

Wind appears in exactly two places and does two different jobs: inside the precipitation
factor as the documented rain-cancelling interaction, and in `src/wind.js` as a stand
filter that never touches the movement score. Keep it that way.

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
- Is the drought over? `config/config.json` has `drought.severity`, and setting it to 0
  in a normal-rainfall year is the correct move, not a regression. Water stops being a
  limiting resource in the Piedmont most years, and the model should reflect that.
- Is the alert threshold right? It ships at 7.5 and was never calibrated against real
  score distributions. After a season there is enough history to set it to roughly the
  top 10-15% of slots.

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

Re-check the USGS zoom limits if the map looks blank when zoomed in. Each layer sets
`maxNativeZoom` in `public/map.js` so Leaflet upscales rather than requesting tiles that
do not exist; if USGS extends coverage, raising that number sharpens the layer.
| suncalc | npm `suncalc` 1.9.0 | sun times and moon illumination |

If a source dies, the fallbacks already exist: scoring degrades to climatology when the
forecast is unavailable, and the map has four interchangeable basemaps.
