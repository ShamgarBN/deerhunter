# Working on DeerHunter

Read before changing any scoring number: the `_methodology` field in
`config/scoring.json`, and `ANNUAL_REVIEW.md`'s "Things that are deliberate, not bugs."

This model is grounded in GPS-collar research rather than hunting-app consensus, which was
a deliberate choice. Several things look like bugs at a glance and are documented as
intentional: moon weighted zero and frozen, no standalone cold-front factor, a rut curve
that peaks during chasing rather than at the breeding date, land cover sampled but
unscored, and proximity curves fitted to the property instead of set to round numbers.
Flag a research disagreement rather than resolving it in a commit.

Weights are meant to drift from logged sit data through `npm run reweight`, not from
reasoning about what sounds right. A new factor gets added through that system with a
stated prior.

`config/map.json` and `config/config.local.json` are gitignored and hold the property's
real coordinates and a Discord webhook. Keep it that way: the repo is public, and the
tool is written to be property-agnostic.

Update `ANNUAL_REVIEW.md` alongside any change that answers or invalidates one of its
questions. It is the handoff to next season's session and is the first thing to go stale.

## The desktop build has two incompatible native binaries

`better-sqlite3` is compiled C++ and Node and Electron have different ABIs, so one build
cannot serve both. `npm run build:dmg` rebuilds for Electron, packages, then rebuilds for
Node, and the restore runs even when packaging fails. Do not replace that script with a
bare `electron-builder` call: it leaves the checkout unable to run any CLI command, and
the error says nothing about why.

Keep `better-sqlite3` at 13 or newer. Version 11 does not compile against Electron 45's
V8 at all.

`config.local.json` and `map.json` hold the webhook and the real stand coordinates and are
excluded from the bundle by an explicit allow-list in `build.files`. Do not replace that
list with a `config/**` glob.
