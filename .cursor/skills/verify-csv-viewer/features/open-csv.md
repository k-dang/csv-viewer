# Open a CSV

Open a CSV loads a local file into a Working CSV tab, shows bounded rows in the grid, and remembers the path on the Recent files list. The original file is not overwritten.

## Sub-features

- `open-empty` shows the empty window with health and seeded Recent files.
- `open-recent` opens a fixture from Recent files without the OS file dialog.
- `open-tab` shows the file name tab, heading, row counts, and grid values.
- `open-second` opens a second CSV and keeps both tabs.
- `open-already-open` activating an already-open Recent file focuses the existing tab instead of duplicating it.
- `open-reopen` reloads the active CSV from disk with Reopen.
- `open-close` closes a tab and returns to the empty window when none remain.
- `open-dialog` is the Open CSV button and File menu path. Unattended runs cannot finish the OS dialog.

## How to get to it (user POV)

- Choose a name under `Recent files` on the empty window.
- Choose `Open CSV` in the header or empty card, then pick a file in the OS dialog.
- Choose `File → Open CSV...` or press `Ctrl+O`, then pick a file in the OS dialog.
- After a CSV is open, choose `Reopen` or `File → Reopen CSV` / `Ctrl+R`.
- Close with the tab close button, `File → Close Tab`, or `Ctrl+W`.

## Driving it with control-csv-viewer

Preconditions:

- `launch` has finished and `doctor` is `ok`.
- Empty window text includes `No CSV open`, `Main process connected`, `phase-2-sample.csv`, and `phase-2-sample-edited.csv`.
- Fixtures exist at `fixtures/phase-2-sample.csv` and `fixtures/phase-2-sample-edited.csv`.

- **Record empty state.** Run `node .cursor/skills/verify-csv-viewer/bin/control-csv-viewer.mjs snapshot --path evidence/open-csv/empty.aria.txt` and `screenshot --path evidence/open-csv/empty.png`. Both show `CSV Viewer`, `No CSV open`, and `Main process connected`.
- **Open first fixture.** Choose the Recent files button for `phase-2-sample.csv`. Run `click --role button --name "phase-2-sample.csv"`. Wait with `wait --text "phase-2-sample.csv" --timeout 15000` then `wait --text "5 visible of 5 rows"`. The tablist `Open CSV and Comparison Tabs` contains tab `phase-2-sample.csv`. Heading `#metadata-title` is `phase-2-sample.csv`. Badge `Ready` is visible. Grid text includes `Ada Lovelace`.
- **Confirm source untouched.** The bytes of `fixtures/phase-2-sample.csv` still match the pre-open file. Isolated `userDataDir/recent-files.json` still lists that absolute path.
- **Open second fixture.** Run `click --role button --name "phase-2-sample-edited.csv"`. Wait for `phase-2-sample-edited.csv` and `5 visible of 5 rows`. Two tabs exist. Active heading is `phase-2-sample-edited.csv`. Grid text includes `Ada Lovelace Truly`.
- **Focus existing tab.** Run `click --role button --name "phase-2-sample.csv"` again, or `click --role tab --name "phase-2-sample.csv"`. There are still two tabs, not three. Active heading is `phase-2-sample.csv`.
- **Reopen.** With `phase-2-sample.csv` active, run `click --role button --name "Reopen"`. Wait for `Ready` and `5 visible of 5 rows`. The same file remains open. `Unsaved changes` is absent.
- **Close tabs.** Run `click --role button --name "Close phase-2-sample.csv"` and `click --role button --name "Close phase-2-sample-edited.csv"`. The window returns to `No CSV open` and Recent files.
- **Proof.** Snapshot and screenshot `evidence/open-csv/opened.aria.txt` and `opened.png` after the first successful open, before closing. They show `CSV Viewer`, `phase-2-sample.csv`, `5 visible of 5 rows`, `Ada Lovelace`, and `Main process connected`.
- **Skip, do not fake.** Do not click `Open CSV`. If a run must mention that path, report `open-dialog` as unreachable without a human OS dialog, and do not mark it verified.

## Gotchas

- `click --name "phase-2-sample.csv"` can match the Recent files button or, after open, the tab. The Recent files control's `title` is the full path, so the name also contains the fixture path. After a file is open the Recent list is gone. Use `--role tab` to switch and `--role button` with `Close phase-2-sample.csv` to close.
- The window follows OS color scheme on a fresh userData dir (`csv-viewer-theme` in localStorage). Dark or light is fine as long as `CSV Viewer` and `Main process connected` are visible.
- Opening is async. Wait for `Ready` and the visible-row line, not a fixed sleep.
- `pnpm run dev` also shows this UI but uses default userData and a DevTools window. Doctor must see the recorded pid and a userData path under `runs/`.
- Locale formatting may insert separators in row counts on some machines. If `5 visible of 5 rows` misses, read `text` and match the actual formatted line.
- Compare stays disabled until two CSV tabs are open. That is expected on `open-recent` for a single file.
