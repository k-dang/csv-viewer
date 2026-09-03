---
name: verify-csv-viewer
description: Drive the CSV Viewer Electron desktop app over CDP the way a user does. Use when proving open, search, edit, stats, or comparison behavior, capturing screenshots, or checking a local CSV Viewer instance started by this skill's launcher.
---

# Verify CSV Viewer

CSV Viewer is a local Electron desktop app. Users open CSV files from disk, browse them in AG Grid, search and filter rows, edit cells and rows, inspect column value counts, and compare two open Working CSVs. There is no web server to hit and no CLI. The Vite URL at `http://127.0.0.1:5173` is renderer-only. `window.csvViewer` IPC exists only inside Electron, so a normal browser tab cannot prove this app.

Drive only an instance started by `control-csv-viewer.mjs launch`. Never attach to a user's `pnpm run dev` window or the default Electron userData directory.

All helper commands below are run from the repo root:

```powershell
node .agents/skills/verify-csv-viewer/bin/control-csv-viewer.mjs <command>
```

Read `features/README.md` before driving. Use the matching feature file. A proof that uses one convenient entry point is incomplete when that file lists others.

## Launch

Launch the **built** Electron app, not `pnpm run dev`. Dev mode opens a detached DevTools window, binds Vite to `127.0.0.1:5173` (shared, not isolatable), and is easy to confuse with a session the user already has open.

```powershell
node .agents/skills/verify-csv-viewer/bin/control-csv-viewer.mjs launch
```

Rebuild first after source changes:

```powershell
node .agents/skills/verify-csv-viewer/bin/control-csv-viewer.mjs launch --rebuild
```

What launch does:

1. Installs with `pnpm install` if `node_modules/` is missing.
2. Runs `pnpm run build:desktop` if `apps/desktop/dist-electron/main/main.js` or `apps/desktop/dist-renderer/index.html` is missing, or if `--rebuild` is set.
3. Creates `.agents/skills/verify-csv-viewer/runs/<id>/user-data/` and writes `recent-files.json` pointing at `fixtures/phase-2-sample.csv` and `fixtures/phase-2-sample-edited.csv`.
4. Starts `apps/desktop` through `apps/desktop/scripts/launch-electron.cjs` with `--user-data-dir`, `--remote-debugging-port`, and `--remote-allow-origins=*`. Vite is not started. `VITE_DEV_SERVER_URL` is unset so the window loads the desktop app's `dist-renderer/index.html`.
5. Waits until CDP answers, the renderer shows heading `CSV Viewer`, and a read-only Recent CSV Sources IPC call succeeds.
6. Writes `.agents/skills/verify-csv-viewer/runs/current.json` (pid, CDP port, userData dir).

Electron is spawned detached. The launch command returns once ready and leaves the window running.

Ready means stdout JSON has `"status": "ready"` and `inspect.ready` is `true`. The empty window shows `No CSV open`, `Open CSV`, `Recent files`, `phase-2-sample.csv`, and `phase-2-sample-edited.csv`. Recent files exist only on that empty window.

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
- `inspect.hasHealth` true because the read-only `csv.get-recent-sources` IPC call succeeded
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
```

Relative `--path` values resolve under `.agents/skills/verify-csv-viewer/`.

Stable handles from this renderer:

| Control | Handle |
| --- | --- |
| Product title | heading `CSV Viewer` |
| IPC health | `doctor` reports `inspect.hasHealth: true` |
| Empty state | text `No CSV open` |
| Open from disk | button `Open CSV` (native OS dialog, do not click during automated proof) |
| Open seeded fixture | button whose name contains `phase-2-sample.csv` or `phase-2-sample-edited.csv` |
| Delimiter | textbox `Delimiter` (`#csv-delimiter`, placeholder `Auto`) |
| Header mode | combobox `Header mode` (`#csv-header-mode`), options `Auto header`, `First row headers`, `No headers` |
| Compare | button `Compare…` (ellipsis character `…`, U+2026). Hidden on the empty window. Disabled until two CSV tabs are open. Unattended runs cannot open a second CSV (Recent files unmount after the first open; `Open CSV` is a native dialog). |
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
| Export | button `Export CSV` (native OS dialog, do not click during automated proof) |
| Undo / redo | buttons `Undo edit`, `Redo edit` |
| Dirty marker | text `Unexported Changes` |
| Grid | `aria-label="CSV row grid"` |
| Stats | button `Open stats panel` / `Close stats panel`, region `Stats Panel`. While open, two Close buttons share that name; use `--nth 0` |
| Stats column | combobox `Stats Column`, then `--role option --name "status"` (not `--exact`) |
| Candidate picker | dialog `Choose a Candidate`, button `Close Candidate picker`, button `Cancel` |
| Comparison | region `CSV comparison`, button `Swap sides`, button `Apply key`, button `Refresh comparison`, heading `Choose a Comparison Key` |

`--name` is a substring match unless `--exact` is set. Prefer the full visible label. When two visible controls share a name, pass `--nth 0` (first match) or `--nth 1`.

Native File dialogs (`Open CSV`, menu `File → Open CSV...`, `Export CSV`) are OS windows. CDP cannot fill them. Open files through the seeded Recent files list on the empty window. Prove edits with in-window state (`Unexported Changes`, cell text, undo/redo enabled). Do not click `Export CSV` unless a human is present to finish the dialog.

AG Grid cells are driveable with `--role gridcell --name <visible value>` and `--double` for edit mode, then `fill --focused` and `press --key Enter`. Column header filters use AG Grid's own widgets and a 1500ms filter debounce. Global search is the stable query path. Search is a case-insensitive substring: `active` also matches `inactive`.

Wait for observable text. After search or filter, wait for the visible-row line and `Ready`. After opening a file, wait for `#metadata-title` and `Ready`. After Apply key, wait for `Changed `, `Baseline-only `, `Candidate-only `, and `Unchanged `, or for `This draft is not a Valid Comparison Key.`

## Evidence

Put artifacts under `.agents/skills/verify-csv-viewer/evidence/<feature-id>/`. Cleanup must not delete this directory.

Proof standards:

- Exercise the real UI. Do not call `window.csvViewer.*` from CDP eval to open, edit, or compare. That skips the user path.
- Capture before and after. Empty state plus the opened grid, query typed plus the filtered count, cell before plus `Unexported Changes`.
- Every artifact set includes a snapshot (`.aria.txt`) and a screenshot (`.png`) that show `CSV Viewer` and the feature's observable result.
- Record the feature id and the entry point used (recent-files button, header Compare, searchbox, and so on).
- Opening a CSV also writes `recent-files.json` in the isolated userData dir. After a successful open, that file must still list the fixture path. The fixture bytes on disk must be unchanged. The app does not overwrite CSV sources.
- Export CSV is not provable without a human finishing the OS dialog. Do not mark Export verified from an enabled button alone. `Compare…` is not provable in an unattended run: the second CSV requires that same OS dialog.

## Cleanup

```powershell
node .agents/skills/verify-csv-viewer/bin/control-csv-viewer.mjs cleanup
```

Cleanup kills the pid from `current.json` (process tree, not the name `electron`), deletes that run directory (userData, logs), and deletes `current.json`. It leaves `.agents/skills/verify-csv-viewer/evidence/` in place.

If launch or doctor fails partway through, run cleanup before the next launch so ports and pids are not left behind.

## Helpers

`bin/control-csv-viewer.mjs` is the only helper.

| Command | Purpose |
| --- | --- |
| `launch [--rebuild]` | Build if needed, seed recent files, start isolated Electron, wait until healthy |
| `doctor` | Read-only health of the recorded instance |
| `click --role <role> --name <name> [--exact] [--double] [--nth N]` | Click a visible control (CDP mouse at the control center). `--nth` is 0-based when names collide |
| `fill --role <role> --name <name> --value <text>` | Replace a textbox/searchbox value and fire input events |
| `fill --focused --value <text>` | Replace the active editor (AG Grid cell editor) |
| `type --text <text>` | Insert text at the current caret via CDP |
| `press --key <key>` | Key down/up (`Enter`, `Escape`, `Tab`) |
| `wait --text <substring> [--timeout 10000]` | Poll `document.body.innerText` |
| `snapshot --path <file>` | Visible text plus a compact AX dump |
| `screenshot --path <file>` | PNG of the renderer |
| `text` | Print full visible text |
| `cleanup` | Stop the recorded pid and delete run state only |

Exit code `0` is success. `doctor` exits `2` when unhealthy. Other failures exit `1`.

## Isolate

Two `pnpm run dev` processes cannot share port 5173, and this skill does not use Vite. Two built Electron processes can run if they have different `--user-data-dir` and CDP ports, but the helper keeps one recorded run. If `current.json` is live, launch exits. Never drive an Electron window this run did not start.
