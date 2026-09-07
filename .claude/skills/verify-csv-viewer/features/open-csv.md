# Open a CSV

Open a CSV loads a local file into a Working CSV tab, shows bounded rows in the grid, and remembers the path on the Recent CSV Sources list. The original file is not overwritten.

## Sub-features

- `open-empty` shows the empty window with health and seeded Recent CSV Sources.
- `open-recent` opens a fixture from Recent CSV Sources without the OS file dialog.
- `open-tab` shows the file name tab, heading, row counts, and grid values.
- `open-reopen` reloads the active CSV from disk with Reopen.
- `open-close` closes a tab and returns to the empty window when none remain.
- `open-second` opens a second CSV and keeps both tabs. Unattended runs cannot finish this path.
- `open-already-open` activating an already-open file focuses the existing tab instead of duplicating it. Unattended runs cannot finish this path.
- `open-cycle` cycles tabs with Ctrl+Tab and Ctrl+Shift+Tab. Needs two tabs, so unattended runs cannot finish this path.
- `open-dialog` is the Open CSV button and File menu path. Unattended runs cannot finish the OS dialog.

## How to get to it (user POV)

- Choose a name under `Recent CSV Sources` on the empty window.
- Choose `Open CSV` in the header or empty card, then pick a file in the OS dialog.
- Choose `File → Open CSV...` or press `Ctrl+O`, then pick a file in the OS dialog.
- After a CSV is open, choose `Reopen` or `File → Reopen CSV` / `Ctrl+R`.
- Move between open tabs by clicking a tab, or with `Ctrl+Tab` / `Ctrl+Shift+Tab`.
- Close with the tab close button, `File → Close Tab`, or `Ctrl+W`.

## Driving it with control-csv-viewer

Preconditions:

- `launch` has finished and `doctor` is `ok`.
- Empty window text includes `No CSV open`, `RECENT CSV SOURCES`, `phase-2-sample.csv`, and `phase-2-sample-edited.csv`.
- Fixtures exist at `fixtures/phase-2-sample.csv` and `fixtures/phase-2-sample-edited.csv`.

- **Record empty state.** Run `snapshot --path evidence/open-csv/empty.aria.txt` and `screenshot --path evidence/open-csv/empty.png`. Both show `CSV Viewer`, `No CSV open`, and the seeded Recent CSV Sources. Neither `Compare…` nor `Reopen` is present; that absence is the `open-empty` proof.
- **Open first fixture.** Choose the Recent CSV Sources button for `phase-2-sample.csv`. Run `click --role button --name "phase-2-sample.csv"`, then `wait --text "5 visible of 5 rows" --timeout 15000`. The tablist `Open CSV and Comparison Tabs` contains tab `phase-2-sample.csv`. Heading `#metadata-title` is `phase-2-sample.csv`. Badge `Ready` is visible. Grid text includes `Ada Lovelace`. `Compare…` is now rendered; `click --role button --name "Compare…"` reports `"disabled": true` with one tab open. Recent CSV Sources are gone.
- **Confirm source untouched.** The bytes of `fixtures/phase-2-sample.csv` still match the pre-open file. Isolated `userDataDir/recent-files.json` still lists that absolute path.
- **Reopen.** With `phase-2-sample.csv` active, run `click --role button --name "Reopen"`. Then read `text`. The same file stays open with `#metadata-title`, the row count, `Ada Lovelace`, no error banner, and no `Unexported Changes`.
- **Proof.** Snapshot and screenshot `evidence/open-csv/opened.aria.txt` and `opened.png` after the first successful open, before closing. They show `CSV Viewer`, `phase-2-sample.csv`, `5 visible of 5 rows`, and `Ada Lovelace`.
- **Close tabs.** Run `click --role button --name "Close phase-2-sample.csv"`, then `wait --text "No CSV open"`. Recent CSV Sources are back.
- **Skip, do not fake.** Do not click `Open CSV`. Report `open-dialog`, `open-second`, `open-already-open`, and `open-cycle` as unreachable without a human OS dialog. After one tab is open, Recent CSV Sources are gone, so a second CSV (or re-picking the already-open file) requires that dialog.

## Web differences

Web has no Recent CSV Sources (`recentCsvSources: false`) and no native dialog. Its empty window shows `No CSV open`, `Open CSV`, and `Select your CSV Sources again after reload.`

- Open every CSV with `upload --role button --name "Open CSV" --nth 0 --file fixtures/phase-2-sample.csv`. Two `Open CSV` buttons render on the empty window, so `--nth 0` is required; once a tab is open the header button is unambiguous.
- `open-second`, `open-already-open`, and `open-cycle` are reachable here, because a second `upload` needs no dialog. They are the reason to run this feature on web at all.
- CSV Sources are `File` objects held for the page's lifetime, described as `This browser session` rather than a path. Nothing is written to disk, so the "fixture bytes unchanged" check still applies but proves less.
- `Reopen` re-reads the in-memory `File`, so it discards edits exactly like desktop. A dirty Reopen raises `window.confirm` here rather than a native box, which still wedges the run.
- There is no application menu, so `Ctrl+O`, `Ctrl+R`, and `Ctrl+W` do not exist. `Ctrl+Tab` cycling is renderer-level and works on both.

## Gotchas

- `wait --text "phase-2-sample.csv"` proves nothing after clicking the Recent entry. The empty window already contains that string twice, as the entry name and inside its full-path subtitle, so the wait returns whether or not the click landed. `5 visible of 5 rows` is the discriminating wait.
- Reopen on a clean file is observably a no-op. `Ready` and the row counts are both on screen before the click: the badge renders `Ready` while idle, and both counts are seeded from the open-time row count. Do not treat either as evidence that Reopen ran.
- Reopening a file with `Unexported Changes` raises a **native** Electron discard dialog that CDP cannot dismiss, which wedges the run. Only Reopen a clean tab.
- `click --name "phase-2-sample.csv"` can match the Recent CSV Sources button or, after open, the tab. The Recent control's `title` is the full path, so the name also contains the fixture path. After a file is open the Recent list is gone. Use `--role tab` to switch and `--role button` with `Close phase-2-sample.csv` to close.
- `Open CSV` is ambiguous on the empty window: the header button and the empty-card button share the name, so `click` reports ambiguous without `--nth`. It is a native dialog either way, so do not click it.
- The window follows OS color scheme on a fresh userData dir (`csv-viewer-theme` in localStorage). Dark or light is fine when the heading and expected feature state are legible.
- Opening is async. Wait for the visible-row line, not a fixed sleep. The row count paints before the rows do, so wait for a cell value such as `Ada Lovelace` before addressing a `gridcell`, or the click reports `No control matched role=gridcell`.
- `pnpm run dev` also shows this UI but uses default userData and a DevTools window. Doctor must see the recorded pid and a userData path under `runs/`.
- Locale formatting may insert separators in row counts on some machines. If `5 visible of 5 rows` misses, read `text` and match the actual formatted line.
- Compare stays disabled until two CSV tabs are open. That is expected on `open-recent` for a single file.
