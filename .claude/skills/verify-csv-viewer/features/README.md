# CSV Viewer verification map

This directory is the maintained source for verifying the user-facing behavior of CSV Viewer. Read this index before driving the app, then use the matching feature file as the recipe.

## Baseline preconditions

- Launch with `node .claude/skills/verify-csv-viewer/bin/control-csv-viewer.mjs launch` so Electron uses a disposable `--user-data-dir` under `.claude/skills/verify-csv-viewer/runs/`.
- Require `doctor` status `ok`, heading `CSV Viewer`, and `inspect.hasHealth` true.
- Seeded Recent files are `fixtures/phase-2-sample.csv` and `fixtures/phase-2-sample-edited.csv`.
- Never drive a `pnpm run dev` window or the user's default Electron userData.
- Native Open/Export dialogs are out of band. Open CSVs from Recent files on the empty window. Do not click `Open CSV` or `Export CSV` in unattended runs.

## Driving conventions

- Start every recipe from the launched empty window unless the feature file says otherwise.
- Prefer `--role` plus `--name` over CSS or coordinates. Use `--nth` when two visible controls share a name.
- Treat `Compare…` as the ellipsis character `…`, not three dots.
- After each mutation, wait for concrete text (`Ready`, row counts, `Unexported Changes`, comparison badges).
- Restore the empty window by closing tabs when a recipe says to. Do not delete evidence during cleanup.

## Proof and skip reporting

- Capture the user action and the resulting state, not only the final screen.
- UI proof includes `snapshot` and `screenshot` under `evidence/<feature-id>/` with `CSV Viewer` visible.
- Opening a file is proven by the tab, `#metadata-title`, row counts, and grid values. Also confirm the fixture file on disk is unchanged.
- Edits are proven by grid text plus `Unexported Changes`. Re-read the fixture to prove the source was not overwritten.
- Report an unreachable path with the command and the unmet prerequisite. Do not report a skipped native dialog as verified through Recent files.

## Feature entry contract

Each feature file starts with an H1 title and one paragraph describing the user-visible behavior. It then uses exactly four H2 sections in this order.

1. `Sub-features` lists short IDs with one line for each behavior.
2. `How to get to it (user POV)` lists every user entry point.
3. `Driving it with control-csv-viewer` starts with `Preconditions:` and uses labeled bullets that pair each user action with an exact command and observable result.
4. `Gotchas` lists traps that can waste or invalidate a verification run.

Keep implementation details out of the map. Name only user paths, stable handles, required state, commands, and observable proof.

## Features

- [Open a CSV](./open-csv.md) covers the empty window, Recent files, tabs, reopen, and close.
- [Search and clear query](./search-filter.md) covers global search, empty matches, and Clear query.
- [Edit a CSV](./edit-csv.md) covers cell edits, insert, append, delete, undo/redo, and the undriveable Export CSV dialog.
- [Compare two CSVs](./compare-csvs.md) covers Compare…, the candidate picker, Apply key, and result badges.
- [Column value counts](./column-counts.md) covers the Stats Panel scoped to the current search and filters.

