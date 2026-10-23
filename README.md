# DeerHunter

Rifle-season hunt-day predictor for a single whitetail property.

Scores every AM and PM slot of gun season on two separate axes, filters stands by scent
safety against the forecast wind, and tells you which sits are worth taking off work for.
Built for one property and one hunter, and to keep working across seasons rather than as
a one-off script.

> Built originally for a property in the North Carolina Piedmont, which is why the shipped
> config defaults to an NC season structure and the research notes lean on southeastern
> whitetail timing. Nothing in the model is tied to that: run `setup`, set your own seasons,
> and the defaults are overwritten.

```bash
npm install
npm run setup -- --lat 38.9072 --lon -77.0369 --name "Home place"
npm run refresh     # pull weather, score the season
npm start           # dashboard on http://localhost:8091
```

`setup` resolves your NWS forecast grid, nearest observation station and county, then
computes 30-year climate normals for your coordinates. It writes `config/config.local.json`,
which is gitignored and overrides the tracked config, so your property never lands in
version control.

`setup` accepts coordinates, a US zip, or a place name:

```bash
npm run setup -- --zip 54843 --name "Home place"
npm run setup -- --place "Hayward, WI" --name "Home place"
```

A zip or place resolves to a centroid, which is close enough to pick the right forecast
grid and county but not to place a stand. Drop real pins on the Map tab afterwards.

### Set these before trusting anything

Both are location-specific and both are the highest-leverage values in the tool:

- **Your seasons**, on the Model tab or in `config/config.json`. Zones are drawn by county
  nearly everywhere. The original spec for this tool named the wrong zone and an opening
  date four weeks late, which would have hidden the first month of the season outright.
- **`peakRutDate`** in `config/scoring.json`. The entire rut curve is computed as
  day-offsets from this one date. Regional estimates vary by a week or more, and your own
  past seasons beat any published average.

## Seasons

Define as many as you hunt. Each has a name, a date range, a weapon and a colour. The tool
scores the **union** of every enabled season and skips the gaps between them, and the
calendar stripes each day with the colours of whatever is open — overlapping seasons show
as a gradient, because on those days both genuinely are.

**Weapon is not cosmetic.** It scales the scent-safety threshold:

| Weapon | Effective range | Scent threshold |
|---|---|---|
| Archery | ~35 yd | ×1.25 |
| Crossbow | ~45 yd | ×1.20 |
| Muzzleloader / slug | ~125 yd | ×1.10 |
| Rifle | ~250 yd | ×1.00 (baseline) |

A rifle hunter kills the deer at 150 yards. An archer waits while it walks to 30, so it
spends far longer inside the scent cone. At ×1.25 the 115° safe-angle threshold becomes
144°, and the same morning can honestly read **safe for gun and blown for bow**. On a real
four-stand property this flipped two of one stand's safe winds and one of another's.

Where seasons overlap, the **strictest open weapon governs** — the conservative read, and
the one that protects the hunter most likely to be let down by a permissive answer.

Scope is whitetail. You can label a season anything, but the rut curve, the lockdown dip
and the time-of-day curve are all whitetail-tuned and do not change.

### Outside the US

NWS is US-only. Leave `nws.gridId` null and the tool still runs: wind, barometric pressure
and temperature come from Open-Meteo, which is global. You lose NWS precipitation
probability and sky cover, and the station-observation backfill.

---

## Sits are windows, not moments

Each session is **five hours** anchored on sunrise or sunset: an hour on the dark side for
walking in or sitting it out, plus four hours of sit time in the light.

- **AM** `sunrise − 1h` to `sunrise + 4h`
- **PM** `sunset − 4h` to `sunset + 1h`

Weather is aggregated across that whole window rather than sampled at one instant, which
is how a front arriving at 9am now shows up in the morning score. Wind direction is
averaged as a **vector**, never arithmetically — 350° and 10° average to 0°, not 180° —
and the resultant length gives a `steadiness` measure from 0 to 1.

There is no midday slot, and at five hours each there is barely room for one: the gap
between windows is 3.2 hours on opening day, 2.3 in mid-November and 1.7 by late December.

## Wind you can and cannot trust

The scent check used to take a direction and render a confident verdict at any speed,
including 1 mph mornings. Below about 3 mph thermals decide where scent goes and the
compass bearing means very little, so the tool was most assertively wrong on exactly the
calm mornings you would most want to hunt.

Three inputs now gate it: **speed** (a floor at 3 mph, fully reliable by 8), **steadiness**
(how much the direction held across the four hours) and **gustiness** (gusts far above
sustained speed mean mixing air, not a clean plume). Below the confidence threshold the
verdict becomes `unreliable` and the geometry is demoted to a note. Saying "I can't tell
you" beats a clean answer that is arbitrary.

## Two scores, never one

| | Buck score | General activity score |
|---|---|---|
| Answers | Is a mature, rut-influenced buck moving in daylight? | Will I see a deer at all, any age or sex? |
| Driven by | Rut phase, above everything else | Food, water, pressure and weather |
| Peaks | Chasing week | Cold late-season evenings on food |

Both are shown side by side on every day. Which one matters on a given sit is your call.
The tool never collapses them into one "hunt rating", because a 9.9/4.4 day and a
4.4/7.6 day are both good days for completely different hunts, and averaging them
destroys exactly the information you need.

At 77 days, the season **contains the entire rut curve** — day −32 through +44 from the
Nov 18 peak. Opening day is early pre-rut, seeking opens Oct 29, chasing runs Nov 11–16,
and the second rut lands mid-December, all inside gun season. That's the case for the
calendar view: the difference between the best and worst weeks is large and knowable in
advance.

---

## How it's grounded

This model follows the GPS-collar research (Auburn, Penn State, Mississippi State) rather
than the popular hunting-app consensus. That was a deliberate choice, and three
consequences look wrong at a glance:

**Moon phase carries a weight of exactly zero.** Multiple independent studies, including
MSU Deer Lab's 48-collar work, found no measurable effect on movement, and specifically
none for the solunar overhead/underfoot theory. Moon phase and illumination appear all
over the UI because they're a reference point worth having; they do not move the number.
The factor is also marked `frozen`, so the reweighting system reports what it would have
fitted but never writes it. Without that, random noise across a few dozen sits is enough
to nudge a zero-prior weight off zero and quietly undo the reason it's zero.

**There's no cold-front factor.** Temperature departure from normal covers that ground at
a modest weight, and it's flagged in the config as the best candidate for reweighting to
move, because it has the least research consensus of anything in the model. Hunting
content treats temperature as the dominant predictor; the collar synthesis found minimal
measured effect on movement distance. The weight splits the difference and lets your own
data settle it.

**Rain is modeled together with wind, not alone.** The Penn State finding is that bucks
cut movement roughly in half on rainy days, and does don't show the same response, which
is why the buck weight is more than double the general weight. The same research found
strong wind increases buck movement regardless of rain. So the factor takes both: below
12 mph rain suppresses fully, between 12 and 18 the suppression fades, above 18 it flips
slightly positive.

All of this is spelled out in `config/scoring.json` under `_methodology` and in the code
comments, so a future reviewer doesn't "fix" it back toward folklore.

---

## The rut curve

Modeled as day-offsets from a single configurable peak-breeding date, not a bell curve
centered on it. The distinction is the whole point: dominant bucks that have paired with
an estrous doe effectively vanish for a day or two during peak breeding itself, so raw
daylight sightings dip right when the rut is biologically peaking.

| Days from peak | Phase | What happens |
|---|---|---|
| −35 to −21 | Early pre-rut | Slightly above baseline, food patterns still hold |
| −20 to −8 | Seeking | Daylight cruising climbs hard |
| −7 to −2 | **Chasing** | **Curve peaks here.** Most sustained daylight buck movement of the year |
| −1 to +3 | Peak breeding / lockdown | Drops off the chasing peak; elevated but erratic as subordinate bucks keep searching |
| +4 to +14 | Post-rut lull | Sharp drop, hardest stretch of the season |
| +21 to +35 | Second rut | Modest bump centered on +28, from unbred does and doe fawns cycling |

`peakRutDate` in `config/scoring.json` is the one value the whole curve hangs on. Change
it there or on the Model tab and every day in the season re-shapes. It ships at
**2026-11-18**; regional estimates for Central NC span about Nov 15-20 and shift year to
year. Ben chose to log a season before moving it.

With a Nov 18 peak the second rut lands **Dec 9-23**, which the UI flags, since most
hunters have written the season off by then.

---

## Wind: a stand filter, not a movement predictor

Wind does two completely different jobs and the model keeps them apart. It barely affects
whether deer move, but it decides whether you get smelled.

Scent travels the direction the wind blows *toward*, which is `(windDirection + 180) mod 360`.
For each stand, the tool computes the bearing to every bedding and food point within
range and grades the angle between them:

- **more than 115°** off — clear, the plume misses entirely
- **60° to 115°** — marginal, the edge of the plume brushes it
- **under 60°** — direct hit

Bedding outranks food, because deer approach food *from* bedding: a bedding direct hit
reads unsafe outright, while food alone is a caution. The grading matters; an earlier
binary version reported zero safe winds for any stand pinched between bedding and food,
which is technically defensible and practically useless.

**Your manual tags always win.** Tag a stand's safe winds from experience on the Map tab
and those override the geometry everywhere, with the computed verdict shown alongside as
a note rather than auto-resolved. A persistent disagreement is usually information: it
normally means a bedding marker is in the wrong place.

### Thermals

Morning thermals rise; evening thermals fall and pool into low ground, where a thermal
drain can pull scent from 50+ acres into one valley. Modeling that properly needs
elevation data this property's map doesn't carry, and a number invented from a terrain
dropdown would be worse than a sentence. So each stand gets a rough terrain tag and the
tool emits plain-text cautions when the combination is the known-bad one — a valley
stand in the evening, or a stand below likely bedding at first light.

Switch the map to the **Topo** basemap to read contour lines when tagging.

---

## The map

A real Leaflet slippy map over live aerial imagery, not a static screenshot with
percentage offsets on top. Four basemaps, all keyless, all verified working:

| Layer | Use |
|---|---|
| Aerial (Esri) | Default. Highest-resolution satellite for this area |
| Aerial (USGS) | Different capture dates, useful for leaf-off vs leaf-on |
| Topo (contours) | How you tag stands ridge / midslope / valley |
| Streets | Road and parcel context |

Points are stored as real WGS84 coordinates, which is what makes the rest honest:
stand-to-bedding bearings are true compass bearings and distances are real yards. Marker
types are stand, food, water, bedding, game trail, scrape/rub, access route, parking and
other; trails and access routes draw as lines.

### Pins, areas or lines

**Food, water and bedding can each be a dropped pin, a drawn boundary, or a drawn line.**
Pick the type, then toggle Pin / Area / Line.

| Shape | Use it for | Distance measured to |
|---|---|---|
| **Pin** | A seep, a lone white oak, a mineral site | The point |
| **Area** | A field, a food plot, a pond, a bedding thicket | Nearest edge, zero if you're inside |
| **Line** | A creek, a drainage, a hedgerow, a bedding strip along a bottom | Nearest point anywhere along the run |

Trails and access routes are a separate thing: they stay reference-only and never score.
That one is a decision rather than a gap: scoring an access route that passes close to
bedding was raised and declined. A water line does score.

This changes the numbers, not just the picture:

- **Distance measures to the nearest edge**, and a stand inside the boundary reads zero.
  Measuring to a field's centroid instead understates a stand on the field edge by roughly
  half — in testing, a stand 98 yards off a field read 197 yards to its centroid.
- **A creek pinned at one end reports a badly wrong distance.** A stand 167 yards from the
  nearest bend read 440 yards to a pin dropped at the creek's north end. Scored out, that
  same stand came to 9.94 as a line versus 8.15 as a pin — a 1.8-point swing on the general
  score, from representation alone. Water carries a lot of weight in a drought year, so that
  error is enough to send you to the wrong stand.
- **The scent check samples the whole boundary or run and keeps the worst case.** A plume
  that clips one corner of a bedding thicket busts the sit just as thoroughly as one down
  the middle, and a single centroid bearing calls that corner clear. The effect is large:
  the same stand tested against a 7-acre thicket had 2 safe wind sectors as an area versus
  5 as a pin, and a linear bedding strip along a bottom left just one fully safe wind. The
  stricter answer is the correct one.

Acreage and run length are computed and shown. A shape's marker sits at a derived anchor
(ring centroid, or the midpoint by distance along a run) and is label-only, which is why it
doesn't drag; to reshape, delete and redraw.

### Basemap zoom limits

The two USGS services stop publishing tiles above **zoom 16** in many areas; z17 and
beyond return 404. Each layer therefore declares `maxNativeZoom`, so Leaflet stops requesting at
the native limit and upscales instead of rendering an empty layer. Past z16 the USGS
layers go soft rather than blank, which is the right tradeoff: a blurry contour line still
tells you where the ridge is. Esri imagery is native all the way to z19.

Water points carry an **active/dry flag**, and dry water contributes nothing to scoring.
In a drought year that flag matters more than a complete inventory.

An optional image overlay is available in `config/map.json` if you want to pin an onX or
plat screenshot on top for boundaries the aerial doesn't show.

---

## Drought

Severity runs 0 to 1 and scales the food and water weights by `1 + 0.8 × severity`.

**It updates itself.** Every refresh pulls the current US Drought Monitor map for your
county — free, keyless, keyed by the FIPS code `setup` resolves — and writes the new
severity, logging every change so it never moves silently.

Severity is **area-weighted** across the county rather than taking the worst category
present, so a corner in D3 doesn't read as uniformly extreme. USDM percentages are
cumulative (`d0: 100` means 100% is at D0 *or worse*, not that the county is uniformly
D0), which is an easy thing to get backwards; the conversion differences them into
exclusive shares first.

| USDM | Severity |
|---|---|
| none | 0 |
| D0 abnormally dry | 0.30 |
| D1 moderate | 0.50 |
| D2 severe | 0.75 |
| D3 extreme | 0.90 |
| D4 exceptional | 1.00 |

Pin your own number with the slider on the Model tab and it switches to **manual**: USDM
still gets checked and logged each refresh, it just stops overwriting you. That's the
right call if you know your own water better than a county-level map does.

In a normal-rainfall year this lands near zero on its own, which is correct — water isn't
a limiting resource in most places most years.

---

## Scores, calibration and where the numbers come from

Factor weights are in **score points at full effect**: a precipitation weight of 1.5 means
a soaking rain costs the buck score 1.5 points. Keeping that unit readable matters,
because the reweighting system writes these numbers and you read them.

The raw weighted sum isn't naturally bounded to 0-10, and where it lands depends on the
property — a place with food and water inside 150 yards of every stand genuinely sits
higher than one where the nearest water is half a mile off. Rather than fudge weights
until the numbers look nice, `npm run score -- --calibrate` simulates the whole season
against a spread of plausible weather and pressure states, then fits an affine map so the
5th percentile lands near 2 and the 95th near 9. **Calibration changes what the numbers
look like, never how days rank against each other.**

It runs automatically on the first refresh after you've marked two stands, and it warns
rather than silently amplifying if the model turns out to barely discriminate.

The top and bottom of the scale compress through a soft knee instead of hard-clamping, so
four stands during chasing week don't all read "10.0" with the ordering between them gone.

**The day-level score is the best achievable stand**, not a blend. An earlier version
combined the best food distance from one stand with the best water distance from another
and produced a day score of 9.2 on a property where no individual stand exceeded 4.5 —
a number describing a stand that doesn't exist.

---

### Proximity curves fit your property

The food and water curves are fitted to your own stand distances by
`npm run score -- --calibrate`, not left as absolute guesses. Absolute thresholds can't
discriminate when a property's numbers happen to sit on one side of them: shipped defaults
gave full credit inside 80 yards of water, so two stands 13 and 38 yards out both scored a
flat +1 and the factor said nothing about which to sit.

Fitted, the nearest stand earns full credit, the median sits at neutral, and the far end
runs past the worst stand. On the property this was built for that took the spread between
the best and worst stand from near zero to **two full buck points**. Guardrails leave the
defaults alone when there are fewer than two stands, or when they sit so close together
that stretching the curve would manufacture a distinction out of noise.

## Learning from your own season

Every factor keeps a `prior_weight` (the research-grounded default, which never changes)
and a `current_weight` (what scoring uses, which drifts as evidence accumulates).

1. Bucket your logged sits into terciles by each factor's own value.
2. Compare actual sighting rates between the high and low buckets.
3. Convert that difference into the weight that would have produced it.
4. Shrink by sample size: `shrinkage = n / (n + 20)`. Ten sits gets about a third weight
   on the data, sixty about three-quarters. Standard empirical Bayes — the prior yields
   only as fast as the evidence earns it.
5. `new = prior + shrinkage × fitted_delta`, clipped so nothing moves more than 20% from
   its prior in one season.
6. Log everything. Nothing changes silently.

It skips factors honestly rather than fabricating: too few sits, buckets too small, or a
factor that barely varied across your season all produce a stated reason instead of a
number.

```bash
npm run reweight              # preview, writes nothing
npm run reweight -- --apply   # write, with an audit trail
npm run reweight -- --history # what has moved, and why
npm run reweight -- --reset   # back to research priors
```

Runs at season's end by default, on demand any time, and as part of the annual review.

### The sit log

Four fields: date, slot, stand, saw-deer. Conditions attach themselves from the tool's
own weather history — rut offset, temperature departure, wind, rain, pressure trend,
cloud, moon — so nobody is reconstructing "was it windy that morning?" from memory in
March. That's what makes the reweighting trustworthy. A form nobody fills in produces no
data to learn from.

### Sighting detail

A count tells you deer showed up. It can't tell you they came from the northeast at 85
yards, forty minutes before first light, feeding. That second thing is what teaches a
property, and no amount of reweighting recovers it later from a number.

So a logged sit can carry any number of **sightings**, each with a time, how many deer and
how many of those were bucks, a compass bearing from the stand, a distance, and what the
animal was doing. Every field is optional.

It is deliberately not part of the logging form. That form stays four fields you can
finish with cold hands before climbing down; detail gets added afterwards from the sit
list, which also means you can add it to a sit logged weeks ago. A sit with no detail is
exactly as valid as it was before the feature existed.

Times are stored twice: the clock reading as entered, and **signed minutes from the light
anchor** — sunrise for a morning sit, sunset for an evening one. The second is the one
worth comparing, because sunrise drifts about 45 minutes across a season. 7:05am is
fourteen minutes *after* sunrise in mid-November and sixteen minutes *before* it just
before Christmas, and a raw clock column would quietly treat those as the same morning.

**Nothing here is scored.** It is recorded now so the annual review has something to work
with, the same arrangement land cover has. Sighting totals never overwrite the sit's own
count either: if the detail adds up to more deer than the sit records, the form says so
and leaves both alone rather than guessing which one you meant.

---

## Is the score working?

A score is ordinal until something grades it. "6.8" beats "4.2" and that is the entire
claim. The Model tab turns it into a sighting rate by comparing what the tool predicted
against what the sit log says actually happened.

Two things are reported, separately for buck and for any deer, because the model scores
them separately and a tool that is good at one and useless at the other would otherwise
average out to looking mediocre at both:

**Calibration.** Sits are binned by predicted score and each bin shows the observed
sighting rate with a 95% range. The range is a Wilson interval, not the textbook normal
one, which at these sample sizes would report three-for-three as a flat 100% with no
uncertainty at all. A fitted curve then reads off a probability at each score.

**Skill.** Does the score beat doing almost nothing? Two baselines, both chosen to be
unflattering: always predicting the season's average sighting rate, and the same fit using
only the rut day-offset, which needs no weather at all. If the full model cannot beat a
calendar, the weather and stand factors are not earning their place yet, and it says so in
those words.

Everything is scored **leave-one-out**: each sit is predicted by a model refitted without
it. Grading a fit on the sits it was fitted to measures memorisation, and at a dozen sits
it measures almost nothing else. The logistic fit is ridge-penalised for the same reason:
with few sits it is entirely possible for every sighting to sit above every blank, and an
unpenalised fit answers that with probabilities of 0 and 1, which is the most confident
possible way to be wrong.

Both refuse to run early rather than printing a number: roughly 8 sits before a rate, 12
before a skill score. "Not enough data" and "no effect found" look identical in a table,
so the tool says which one it is.

## Bedding the map may be missing

Every scent verdict is measured against your bedding markers. A thicket you never marked
is a stand this tool will cheerfully call safe while you get winded from it every time,
and nothing else in the tool can catch that, because every other input is downstream of
the same markers.

The sighting log can, because it is the only input that does not come from the map. Each
sighting with a heading implies a direction bedding lies in, and the two slots are mirror
images: in the evening deer are leaving bed for food, so bedding is back the way they
came; in the morning they are heading back to it. Directions that keep producing deer with
nothing marked behind them get flagged, with a coordinate to walk to.

The bearing from the stand to the animal is deliberately **not** used for this. It says
where the deer was standing, which is a point on the route and says nothing about which
end of it the bedding is at.

## Backups

```bash
npm run backup                 # now
npm run backup -- --keep 60    # and keep more of them
```

The sit log, the conditions frozen at log time, the sightings, and weights that have
drifted from their research priors toward this property are the whole point of the tool,
and they live in one SQLite file on one machine. A timestamped JSON export plus
spreadsheet CSVs are written nightly at 3:40, and the last 30 are kept.

Retention is by count rather than age, so a tool left alone for a month still has history
when it comes back instead of having quietly expired everything. Weather and scores are
left out because a refresh rebuilds both. **The Discord webhook is redacted**, with the key
left in place so a restore makes obvious what has to be pasted back: a backup is a file
that gets copied to other disks and attached to messages.

## Tests

```bash
npm test
```

Node's built-in runner, no dependency. The suite is deliberately narrow: it covers the
arithmetic where a wrong answer still looks reasonable on screen. A scent bearing off by a
sign, a probability that reads 0.84 when it should read 0.48, a front factor firing on the
wrong half of a weather system, bedding inferred on the wrong end of a deer's route.
Nobody catches those by looking at the dashboard. Things that fail loudly are not covered,
because they get noticed anyway.

## Data sources

All free, all keyless, all verified working on 2026-09-18.

| Source | Used for |
|---|---|
| **NWS** `api.weather.gov` | Temperature, precipitation, sky cover; station observations. US only |
| **Open-Meteo** forecast | All wind (speed, direction, **gusts**), **barometric pressure**, and coverage past the NWS horizon |
| **Open-Meteo** archive | Historical hourly weather for past dates, used by the annual review |
| **NOAA NCEI** daily normals | Optional US station normals via `npm run normals -- --station <GHCN id>` |
| **suncalc** | Sunrise, sunset, legal light, moon phase and illumination, computed locally |
| **Esri / USGS / OSM** tiles | Map basemaps |

Two things forced the second source. NWS gridpoint `pressure` comes back with unit `None`
and values near zero, so the barometric factor was measurably dead — contributing nothing
in 0 of 168 slots. And NWS publishes wind direction in multi-hour blocks (5 distinct
directions in 24 hours at this grid point, against Open-Meteo's 17) with no gust series at
all, which made it impossible to tell a trustworthy wind from an untrustworthy one. Wind
therefore comes wholly from Open-Meteo so speed, direction and gust describe one forecast.

Scores are labeled with their confidence:

- **observed** — the slot has passed and this is what actually happened
- **forecast** — real NWS data, inside the 7-day window
- **outlook** — NWS data past the confidence window, softer
- **climatology** — past the forecast horizon entirely: rut curve plus climate normals

Alerts stay inside the forecast window by default.

---

## Alerts

Discord webhook, fired by the scheduled job when an upcoming slot crosses a threshold.

**Separate thresholds per score**, because the two distributions are different shapes. On
a real property a single 7.5 cut-off caught 17% of buck slots and 40% of general slots; at
8.0 it caught 15% of buck and 1% of general. One number cannot serve both.

The Model tab has the full panel: a slider per score showing what percentage of the season
it would catch, preset buttons for the top 5 / 10 / 15%, which scores fire, whether to
restrict to forecast-backed days or days you're free, and the cooldown. Aim for roughly
the **top 10-15%** — an alert that fires most days is one you learn to swipe away.

It reports two figures, and the difference matters. **Over the whole season** is what you
should choose against: that's the distribution you live with. **In the forecast window
now** is only what would fire today, and in late October that's a fortnight of pre-rut
that says nothing about the second week of November.

### The quiet check-in

Silence from a threshold alert is ambiguous. It means either nothing crossed the bar, or
nothing is running. The tool is an ordinary process on a machine that sleeps and reboots,
so the second case is real, and it fails exactly the way a quiet week looks.

So the **refresh** job posts a check-in when the channel has gone quiet, seven days by
default. It carries the best slot it can see, which keeps it worth opening rather than
pure noise. A real alert, a test message or a previous check-in all reset the clock, so an
active week produces nothing extra.

It hangs off refresh rather than the alert job deliberately. Refresh is what proves the
whole pipeline ran: if it fires, weather was fetched and the season was scored. A
heartbeat on a bare timer could keep arriving from a process that had stopped doing any
real work.

Read it the other way round and it is a liveness check: **if the check-ins stop, the tool
stopped**. Both halves are in the Model tab next to the thresholds, along with when the
webhook last fired.

```bash
npm run test-discord   # connectivity check
npm run alert          # check thresholds now
npm run refresh        # also posts the check-in if the channel has been quiet
```

---

## Dashboard

Served from the Mac mini, reachable over Tailscale from a phone. No auth: single hunter,
private tailnet.

Warm-earth palette over a condensed type scale: deliberately not a trading terminal, and
deliberately not an outdoors-brand look either — no camo, no antler icons, no woodgrain.
Scores run a **continuous** rust-to-moss ramp, so 6.9 and 7.1 read as neighbours rather
than different tiers. Each score's label is width-matched to the number above it at
runtime, because "5.5" and "10.0" are different widths and a fixed font size can only
balance one of them.

- **Today** — the front door, and the answer to "do I go, and where". Both scores over a
  dawn or dusk sky driven by the real forecast, every metric with its own graphic and a
  diverging bar showing whether it is helping or hurting, a **primary and a backup stand**
  with a line saying why the backup might beat it, and the week ahead as tiles.
- **Season** — every day of your seasons, AM and PM, both scores, banded by rut phase and
  striped with whichever seasons are open. Mark which days you're actually free; a 9.9 on a
  Tuesday you can't take off is trivia. Filter to available days or the top 15. The weekend
  button toggles between marking and clearing, and a **Clear all** appears whenever
  anything is marked. **Days already past collapse** behind a one-line toggle so the table
  opens on today; expand it and they show dimmed, with a count of how many you hunted. The
  Stands matrix does the same.
- **Stands** — which stand, on which day, at which time. A matrix of stands against every
  slot in the season, plus a per-stand card with its best slots, its best slots on days
  you're free, and how often it's scent-safe. Read the caveat at the top of that tab: rut
  and weather are shared by the whole property and move every stand together, so what
  actually separates stands is scent safety, days since last hunted, and distance to food
  and water. Only the first two change day to day, and wind only exists inside the
  forecast window.
- **Near-term** — rolling 7 or 14 days with the contributing factors visible as signed
  bars, so you can see *why* a score is what it is, plus per-stand scent verdicts and
  thermal cautions for the forecast wind.
- **Map** — the property editor described above.
- **Sit log** — quick entry and history.
- **Model** — every weight with its research provenance and how far it has drifted from
  its prior, the reweighting controls, calibration, the peak-rut date and the drought
  slider. The point of showing all of it is auditability: a model that changes silently
  under the person relying on it is worse than one that never learns.

Every GET is cached to localStorage and replayed if the fetch fails, with the cache age
shown in the header. Opening this from a stand with one bar at 5:50am shows the last
known scores, clearly labeled as stale, instead of an error page.

---

## Deploying on the Mac mini

```bash
./deploy/install-macmini.sh
```

Installs a launchd agent (`com.benniemann.deerhunter`), primes the data, and prints the
Tailscale URL. Fully separate from Scuttlebutt: own process, own port (8091), own SQLite
file, own launchd label. The scheduler runs inside the server process — refresh at 3:20am,
alerts at 7:00am, America/New_York, both editable in `config/config.json`.

---

## Layout

```
config/config.json    property, season, NWS grid, alerts, drought, scent geometry
config/scoring.json   every weight as {prior, current}, the rut curve, calibration
config/map.json       property points and lines
data/deerhunter.db    sits, snapshots, weather, scores, availability, weight audit log
data/normals-rdu.json NOAA 1991-2020 daily climate normals
src/scoring.js        the two-score engine
src/rut.js            the rut curve
src/wind.js           scent geometry and thermal notes
src/reweight.js       empirical-Bayes weight fitting
src/calibrate.js      fits the 0-10 scale to this property
src/nws.js            weather client and climatology fallback
src/jobs.js           daily refresh and alert pipeline
public/               dashboard
ANNUAL_REVIEW.md      hand this to next season's Claude Code
```

## Land cover

The tool can tell woods from field, two ways, and **your answer always wins**.

**Automatic (NLCD).** It samples the National Land Cover Database — 30 m pixels, 2021
vintage, free and keyless via MRLC — at every stand and marked feature, and caches the
result to `data/cover-cache.json`. Turn on the **Land cover (NLCD)** overlay on the Map tab
to see the classification painted over the aerial.

**Manual.** Draw **Woods** or **Field** areas on the map. These render deliberately dim,
because cover is background context, not a target, and rendering a 20-acre block of timber
as loud as a food plot would bury the things you navigate by. They have no centre pin for
the same reason. Anywhere you draw one, it overrides NLCD — same principle as your tagged
safe winds: you have walked it and the satellite has not.

### Edge detection

The one land-cover idea with a real basis for deer hunting is **edge**: the boundary
between cover and food, where deer travel and where they stage before committing to open
ground. Each stand is checked by sampling a ring about a bowshot out and testing whether
both a cover group and an open group appear. Stands sitting on an edge are flagged on the
Stands tab.

### It is not scored, on purpose

Cover carries **zero scoring weight**. Land cover is not deer preference, and weighting it
without evidence would be exactly the folklore-driven modeling the rest of this tool
avoids. It is there for context and to validate your markers — it will tell you if a
polygon you labeled Food sits in what the satellite reads as forest. If edge proximity
turns out to predict your sightings, the reweighting system is the place to establish
that, not a hunch.

Caveats worth holding onto: 30 m is about a fifth of an acre, so narrow strips and small
plots blur into their surroundings; the 2021 vintage misses anything cleared or planted
since; and a lookup failure leaves cover blank without affecting any other number.

## Scope

No ballistics or wind-drift calculator — "windage" here means wind's effect on deer and
scent, not a shooting tool. No auth, no multi-user. No GIS or elevation modeling; the
property is under 100 acres and terrain tags cover what's needed. Stand height is
recorded but deliberately unscored, because the stands on the property it was built for
are all within a couple of feet of each other and a variable with no spread cannot
discriminate. No native mobile app;
the Tailscale-reachable dashboard covers phone access.

No trail-camera ingestion. It was built once and taken back out at the owner's request,
who tracks camera data outside the tool and preferred it that way. The gap is deliberate,
so treat a proposal to add it as a scope change to raise rather than an omission to fix.
