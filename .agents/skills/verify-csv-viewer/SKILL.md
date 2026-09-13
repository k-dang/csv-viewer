---
name: verify-csv-viewer
description: Drive CSV Viewer over CDP the way a user does, on either runtime - the Electron desktop app or the web build. Use when proving open, search, edit, stats, export, or comparison behavior, capturing screenshots, or checking a local CSV Viewer instance started by this skill's launcher.
---

# Verify CSV Viewer

CSV Viewer ships two runtimes over one shared UI. Users open CSV files, browse them in AG Grid, search and filter rows, edit cells and rows, inspect column value counts, and compare two open Working CSVs. There is no CLI.

- **desktop** is the Electron app. CSV Sources are files on disk, opened through Recent CSV Sources or a native OS dialog. `window.csvViewer` IPC exists only here.
- **web** is the browser build, served by the real dev server and driven in a real installed browser. CSV Sources are `File` objects held for the page's lifetime, opened through an `<input type="file">`. There are no Recent CSV Sources and no native dialogs.

Prefer **web** for shared UI and Export CSV verification. Use **desktop** for Recent CSV Sources, source identity, and the preload path for dropped files. Both runtimes support opening multiple files through `drop`; native Open/Export dialogs still require a human.

Drive only an instance started by `control-csv-viewer.mjs launch`. Never attach to a user's `pnpm run dev` window or the default Electron userData directory.

All helper commands below are run from the repo root:

```powershell
node .agents/skills/verify-csv-viewer/bin/control-csv-viewer.mjs <command>
```

Read `features/README.md` before driving. Use the matching feature file. A proof that uses one convenient entry point is incomplete when that file lists others.

## Launch

Launch the **built** app, not `pnpm run dev`. Dev mode opens a detached DevTools window, binds Vite to `127.0.0.1:5173` (shared, not isolatable), and is easy to confuse with a session the user already has open.

```powershell
node .agents/skills/verify-csv-viewer/bin/control-csv-viewer.mjs launch
```

For the web target, add `--web`:

```powershell
node .agents/skills/verify-csv-viewer/bin/control-csv-viewer.mjs launch --web
```

Rebuild first after source changes (either target):

```powershell
node .agents/skills/verify-csv-viewer/bin/control-csv-viewer.mjs launch --rebuild
```

One run at a time. `launch` refuses while `current.json` points at a live pid, so `cleanup` between targets.

What launch does:

1. Installs with `pnpm install` if `node_modules/` is missing.
2. Runs `pnpm run build:desktop` if `apps/desktop/dist-electron/main.cjs` or `apps/desktop/dist-renderer/index.html` is missing, or if `--rebuild` is set.
3. Creates `.agents/skills/verify-csv-viewer/runs/<id>/user-data/` and writes `recent-files.json` pointing at `fixtures/phase-2-sample.csv` and `fixtures/phase-2-sample-edited.csv`.
4. Starts `apps/desktop` through `apps/desktop/scripts/launch-electron.cjs` with `--user-data-dir`, `--remote-debugging-port`, and `--remote-allow-origins=*`. Vite is not started. `VITE_DEV_SERVER_URL` is unset so the window loads the desktop app's `dist-renderer/index.html`.
5. Waits until CDP answers, the renderer shows heading `CSV Viewer`, and a read-only Recent CSV Sources IPC call succeeds.
6. Writes `.agents/skills/verify-csv-viewer/runs/current.json` (pid, CDP port, userData dir).

Electron is spawned detached. The launch command returns once ready and leaves the window running.

Ready means stdout JSON has `"status": "ready"` and `inspect.ready` is `true`. On desktop the empty window shows `No CSV open`, `Open CSV`, `Recent CSV Sources`, `phase-2-sample.csv`, and `phase-2-sample-edited.csv`. Recent CSV Sources exist only on that empty window.

What `launch --web` does differently:

1. Builds nothing. It starts the web dev server exactly the way `pnpm run dev:web` does - same script, same `--host 127.0.0.1` - with `--port <isolated> --strictPort` appended. The workspace packages export TypeScript source, so there is no build step to wait for.
2. Finds an installed Chrome, Edge or Chromium and starts it against a throwaway profile with `--remote-debugging-port`. Set `CSV_VIEWER_VERIFY_BROWSER` to override the search. There is no preload and no IPC bridge, so the page runs its real web composition.
3. Pre-seeds that profile's download preferences so Export CSV lands in `runs/<id>/downloads/` instead of raising a Save As dialog.
4. Seeds no Recent CSV Sources: web declares `recentCsvSources: false`, so its empty window has `No CSV open`, `Open CSV`, and `Select your CSV Sources again after reload.` and no Recent list at all.

A web run therefore owns **two** processes. `current.json` records `pid` (the browser) and `vitePid`; `doctor` reports `viteAlive`; `cleanup` stops both.

Web readiness is that the app rendered past its own startup gate: the `h1` stops reading `Checking browser support` (or `This browser cannot start CSV Viewer Web`) and becomes `CSV Viewer`. That is the proof DuckDB-Wasm started.

The dev server port is private to the run and `--strictPort` makes a collision fail loudly rather than drift. Never pass the port through pnpm's `--` separator: pnpm forwards `--` to vite as a literal argument, vite ignores the port flags, and the server silently binds 5173 - the shared port this skill must never touch.

Because it is the dev server, this target does not exercise the production bundle. A claim about built asset emission needs `pnpm run build:web` and a human.

Launch refuses if `current.json` points at a live pid. Cleanup first. Do not start a second instance against the same run file.

Teardown is `cleanup`. Do not `taskkill` by process name.

## Doctor

Run this first whenever the window looks wrong, CDP errors, or a previous run may still be alive.

```powershell
node .agents/skills/verify-csv-viewer/bin/control-csv-viewer.mjs doctor
```

Require all of:

- `"status": "ok"`
- `alive` true for the pid in `current.json`
- `inspect.heading` is `CSV Viewer`
- `inspect.hasHealth` true. On desktop that means the read-only `csv.get-recent-sources` IPC call succeeded; on web it means the `h1` is `CSV Viewer` rather than a startup-gate heading
- `target` matches the runtime you meant to drive
- on web, `viteAlive` true: a dead dev server leaves the browser showing a stale page that still passes a naive text check
- `userDataDir` is under `.agents/skills/verify-csv-viewer/runs/`

If doctor fails, cleanup and launch again. If there is no `current.json`, launch. Do not probe default userData (`%APPDATA%\csv-viewer` or `%APPDATA%\CSV Viewer`) and do not connect to a random CDP port.

## Drive

Use the helper. Do not open `http://127.0.0.1:5173` in Cursor's browser. That page has no preload API.

```powershell
node .agents/skills/verify-csv-viewer/bin/control-csv-viewer.mjs click --role button --name "phase-2-sample.csv"
node .agents/skills/verify-csv-viewer/bin/control-csv-viewer.mjs click --role button --name "Close stats panel" --nth 0
node .agents/skills/verify-csv-viewer/bin/control-csv-viewer.mjs fill --role searchbox --name "Global search" --value "Ada"
node .agents/skills/verify-csv-viewer/bin/control-csv-viewer.mjs fill --focused --value "Ada Lovelace Edited"
node .agents/skills/verify-csv-viewer/bin/control-csv-viewer.mjs type --text "Ada"
node .agents/skills/verify-csv-viewer/bin/control-csv-viewer.mjs wait --text "1 visible of 5 rows" --timeout 10000
node .agents/skills/verify-csv-viewer/bin/control-csv-viewer.mjs press --key Enter
node .agents/skills/verify-csv-viewer/bin/control-csv-viewer.mjs snapshot --path evidence/open-csv/after.aria.txt
node .agents/skills/verify-csv-viewer/bin/control-csv-viewer.mjs screenshot --path evidence/open-csv/after.png
node .agents/skills/verify-csv-viewer/bin/control-csv-viewer.mjs text
node .agents/skills/verify-csv-viewer/bin/control-csv-viewer.mjs upload --role button --name "Open CSV" --nth 0 --file fixtures/phase-2-sample.csv
```

Relative `--path` values resolve under `.agents/skills/verify-csv-viewer/`.

Stable handles from this renderer:

| Control | Handle |
| --- | --- |
| Product title | heading `CSV Viewer` |
| IPC health | `doctor` reports `inspect.hasHealth: true` |
| Empty state | text `No CSV open` |
| Open from disk | button `Open CSV`. Two of them render on the empty window (header and card), so pass `--nth 0`. On desktop this is a native OS dialog: do not click it. On web, drive it with `upload --file <path>` |
| Open seeded fixture | button whose name contains `phase-2-sample.csv` or `phase-2-sample-edited.csv` |
| Delimiter | textbox `Delimiter` (`#csv-delimiter`, placeholder `Auto`) |
| Header mode | combobox `Headers` (`#csv-header-mode`), options `Auto`, `First row`, `None` |
| Compare | button `Compare…` (ellipsis character `…`, U+2026). Rendered only while a CSV tab is active, so it is absent on the empty window and absent while a Comparison Tab is active. Disabled until two CSV tabs are open. Use `drop --file <path>` to open a second CSV on either runtime. |
| Reopen | button `Reopen` |
| Theme | button `Switch to dark mode` / `Switch to light mode` |
| Tabs | tablist `Open CSV and Comparison Tabs`, tab named with the file name |
| Close tab | button `Close phase-2-sample.csv` |
| File heading | `#metadata-title` text, e.g. `phase-2-sample.csv` |
| Row counts | `5 visible of 5 rows` (locale-formatted) |
| Query badge | `Ready`, `Querying`, or `Query failed` |
| Global search | searchbox `Global search` (`#global-search`) |
| Clear query | button `Clear query` |
| Insert / append / delete | buttons `Insert row above`, `Insert row below`, `Append row`, `Delete selected rows` |
| Export | button `Export CSV`. Never disabled, dirty or not. On desktop this is a native OS dialog: do not click it. On web it downloads into the run's `downloads/` directory and the status line reads `Download started` |
| Undo / redo | buttons `Undo edit`, `Redo edit` |
| Dirty marker | text `Unexported Changes` |
| Grid | `aria-label="CSV row grid"` |
| Stats | button `Open stats panel` / `Close stats panel`. The panel is `<aside aria-label="Stats Panel">` with no `role`, so `--role region` never matches it; wait for text `Column Value Counts` instead. While open, two Close buttons share the Close name; use `--nth 0` |
| Stats column | combobox `Stats Column`. A click alone does not open it; follow with `press --key ArrowDown`, then `click --role option --name "status"`. The option name is exactly `status`, so `--exact` also works here, but `Close stats panel` needs substring matching |
| Candidate picker | dialog `Choose a Candidate`, button `Close Candidate picker`, button `Cancel`. Pick a candidate by its subtitle, not its file name: on web that is `This browser session`, on desktop the source path. The bare file name also matches the tab and its close button |
| Comparison | region `CSV comparison`, button `Swap sides`, button `Apply key`, button `Refresh comparison`, heading `Choose a Comparison Key` |
| Comparison key | `--role checkbox --name "id"`. Do not add `--exact`: the checkbox `value` joins the name, so it reads `id on` |

`--name` is a substring match unless `--exact` is set. Prefer the full visible label. When two visible controls share a name, pass `--nth 0` (first match) or `--nth 1`.

Disabled state is only readable from `click`, which prints `"disabled": true` and exits `0` without the control acting. The `snapshot` AX dump omits it. Prove every "button is disabled" claim from that JSON field, never from a snapshot or screenshot.

Base UI popups (the `Stats Column` select) do not open from a synthetic click. Click the trigger, then `press --key ArrowDown`, then click the option.

On **desktop**, native File dialogs (`Open CSV`, menu `File → Open CSV...`, `Export CSV`) are OS windows. CDP cannot fill them. Open files through `drop --file <path>` or the seeded Recent CSV Sources list on the empty window. Prove edits with in-window state (`Unexported Changes`, cell text, undo/redo enabled). Do not click `Export CSV` unless a human is present to finish the dialog.

On **web** there are no native dialogs. `upload --file` answers the file input, so a second CSV, the comparison feature, and the Export CSV round trip are all provable unattended. Exported bytes land in `runs/<id>/downloads/` (`doctor` prints `downloadDir`); read them to prove the export really contains the edit. Repeated exports of one source overwrite each other there, so copy anything you need into `evidence/` before the next one.

AG Grid cells are driveable with `--role gridcell --name <visible value>` and `--double` for edit mode, then `fill --focused` and `press --key Enter`. The row-count line paints before the rows do, so after opening a file or switching tabs wait for a cell value such as `Ada Lovelace`, not just `5 visible of 5 rows`, before addressing a gridcell. Column header filters use AG Grid's own widgets and a 1500ms filter debounce. Global search is the stable query path. Search is a case-insensitive substring: `active` also matches `inactive`.

Wait for observable text. After search or filter, wait for the visible-row line and `Ready`. After opening a file, wait for `#metadata-title` and `Ready`. After Apply key, wait for `Changed `, `Baseline-only `, `Candidate-only `, and `Unchanged `, or for `This draft is not a Valid Comparison Key.`

## Evidence

Put artifacts under `.agents/skills/verify-csv-viewer/evidence/<feature-id>/`. Cleanup must not delete this directory.

Proof standards:

- Exercise the real UI. Do not call `window.csvViewer.*` from CDP eval to open, edit, or compare. That skips the user path.
- Capture before and after. Empty state plus the opened grid, query typed plus the filtered count, cell before plus `Unexported Changes`.
- Every artifact set includes a snapshot (`.aria.txt`) and a screenshot (`.png`) that show `CSV Viewer` and the feature's observable result.
- Record the feature id and the entry point used (recent-files button, header Compare, searchbox, and so on).
- Opening a CSV also writes `recent-files.json` in the isolated userData dir. After a successful open, that file must still list the fixture path. The fixture bytes on disk must be unchanged. The app does not overwrite CSV sources.
- Desktop Export CSV requires a human to finish the OS dialog. An enabled button is not export proof. Web exports are driveable. Comparison is driveable on both runtimes after opening files with `drop`.

## Cleanup

```powershell
node .agents/skills/verify-csv-viewer/bin/control-csv-viewer.mjs cleanup
```

Cleanup kills the pids from `current.json` (process trees, not process names): the app or browser, plus the dev server on web. It then deletes that run directory (profile, logs, and on web `downloads/`) and `current.json`. It leaves `.agents/skills/verify-csv-viewer/evidence/` in place.

Copy any exported CSV you still need out of `downloads/` into `evidence/` before cleanup. The run directory does not survive.

If launch or doctor fails partway through, run cleanup before the next launch so ports and pids are not left behind.

## Helpers

`bin/control-csv-viewer.mjs` is the only helper.

| Command | Purpose |
| --- | --- |
| `launch [--web] [--rebuild]` | Start an isolated instance of the chosen target and wait until healthy. Desktop builds if needed and seeds Recent CSV Sources; web starts the dev server and a real browser, and captures downloads. `--rebuild` applies to desktop only |
| `doctor` | Read-only health of the recorded instance |
| `click --role <role> --name <name> [--exact] [--double] [--nth N]` | Click a visible control (CDP mouse at the control center). `--nth` is 0-based when names collide |
| `fill --role <role> --name <name> --value <text>` | Replace a textbox/searchbox value and fire input events |
| `fill --focused --value <text>` | Replace the active editor (AG Grid cell editor) |
| `type --text <text>` | Insert text at the current caret via CDP |
| `press --key <key>` | Key down/up (`Enter`, `Escape`, `Tab`). Chords use `+` with `Control`, `Meta`, `Shift`, or `Alt` (`Control+c`) |
| `drop --file <path>` or `drop --files <JSON array>` | Both runtimes. Sends file-backed Chromium drag input at the window center. Add `--hover` for the highlight, `--cancel` to cancel, or `--x` and `--y` to target another location |
| `upload --role <role> --name <name> --file <path>` | Web only. Arms file-chooser interception, clicks the control, and answers the chooser with `--file` (resolved from the repo root) |
| `wait --text <substring> [--timeout 10000]` | Poll `document.body.innerText` |
| `snapshot --path <file>` | Visible text plus a compact AX dump |
| `screenshot --path <file>` | PNG of the renderer |
| `text` | Print full visible text |
| `cleanup` | Stop the recorded pid and delete run state only |

Exit code `0` is success. `doctor` exits `2` when unhealthy. Other failures exit `1`.

## Isolate

Two `pnpm run dev` processes cannot share port 5173. The desktop target does not use Vite at all, and the web target starts its own dev server on a port private to the run, so neither collides with a dev server the user has open. Two built processes can run if they have different `--user-data-dir` and CDP ports, but the helper keeps one recorded run, and desktop and web share that one slot. If `current.json` is live, launch exits: `cleanup` before switching targets. Never drive a window this run did not start.
