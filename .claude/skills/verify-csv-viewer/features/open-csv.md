# Open a CSV

Open CSV creates and focuses a CSV Tab while preserving existing tabs and edits. File drops work anywhere in both runtimes. CSV Sources remain unchanged on disk.

## Sub-features

- `open-empty` shows the empty window, Open CSV, and a file-drop hint.
- `open-drop` highlights a file drag and opens CSV, TSV, or TXT files, ignoring extension case.
- `open-drop-batch` opens multiple files sequentially, retains successes, and summarizes rejected or failed items.
- `open-drop-blocked` declines drops during loading and blocks them during modal dialogs.
- `open-recent` opens a desktop Recent CSV Source.
- `open-tab` shows the file tab, metadata, row counts, and grid values.
- `open-reopen` reloads the active source into its existing CSV Tab.
- `open-close` closes a tab and returns to the empty window when none remain.
- `open-second` opens a second CSV and keeps both tabs.
- `open-already-open` focuses an existing desktop CSV Tab without replacing edits. Web creates a new source for each selection.
- `open-cycle` switches tabs with Ctrl+Tab and Ctrl+Shift+Tab.
- `open-dialog` selects a file through Open CSV or the desktop File menu.

## How to get to it (user POV)

- Drop one or more CSV, TSV, or TXT files anywhere in the window.
- Choose Open CSV in the header or empty card and select a file.
- On desktop, choose a Recent CSV Source on the empty window, File > Open CSV, or Ctrl+O.
- Use Reopen to reload the active source. Desktop also supports File > Reopen CSV and Ctrl+R.
- Select a tab or use Ctrl+Tab and Ctrl+Shift+Tab.
- Close with the tab close button. Desktop also supports File > Close Tab and Ctrl+W.

## Driving it with control-csv-viewer

Preconditions:

- Launch the intended runtime through the helper and require `doctor` status `ok`.
- Begin on the empty window with fixtures `phase-2-sample.csv` and `phase-2-sample-edited.csv` available.
- Commands below are helper subcommands. Evidence paths resolve under the skill directory.

- **Empty state.** Capture `snapshot --path evidence/drag-and-drop/empty.aria.txt` and `screenshot --path evidence/drag-and-drop/empty.png`. Require CSV Viewer, No CSV open, Open CSV, and the drop hint.
- **Highlight.** Run `drop --file fixtures/phase-2-sample.csv --hover`. Capture a screenshot showing Drop files to open. Run the same command with `--cancel` to remove the highlight without opening a file. Test dark and light themes.
- **Mixed batch.** Run `drop --files '["fixtures/phase-2-sample.csv","README.md","fixtures/phase-2-sample-edited.csv"]'`. Require two tabs, the edited fixture active, its row counts and grid values, and a summary naming README.md. No drop highlight remains. Capture both a snapshot and screenshot.
- **Duplicate and edits.** Select the first fixture, edit Ada's cell, and require Unexported Changes. Run `drop --file fixtures/phase-2-sample.csv`. Desktop keeps two tabs and the edited value. Web adds a third tab containing the original data; selecting the first tab restores its edited value.
- **Modal blocking.** With two CSV tabs open, choose Compare and wait for Choose a Candidate. Drop another file. The dialog and tab count remain unchanged, and no navigation occurs. Cancel the dialog before further drops.
- **Busy and failures.** `e2e/drag-and-drop.spec.ts` holds source acquisition to prove that another drop receives the busy message. It also verifies folder rejection, browser capacity, uppercase TSV parsing, and mixed-drop continuation. Renderer tests cover acquisition exceptions and parse failures.
- **Recent source.** On the empty desktop window, run `click --role button --name "phase-2-sample.csv"`. Require a CSV Tab, metadata, and grid values. This proves the recent-source entry point separately from dropping.
- **Picker.** On web, run `upload --role button --name "Open CSV" --nth 0 --file fixtures/phase-2-sample.csv`. Desktop picker and menu dialogs require a human; leave those paths explicitly unverified in unattended runs.
- **Reopen and close.** Reopen a clean active tab. Close clean tabs with their Close buttons, then require No CSV open. Desktop Recent CSV Sources return. A dirty reopen or close requires confirmation.
- **Source preservation.** Compare fixture bytes with their pre-run contents. On desktop, the isolated recent-files.json must still list successfully opened fixture paths.

## Web differences

- Web has no Recent CSV Sources or application menu. Open CSV is driveable through `upload`.
- Dropping the same file again creates another tab. Names and sizes do not establish source identity.
- Web accepts at most 100 MB per source and 200 MB total reserved source bytes.
- Reopen reads the selected File held in memory. Reloading the page requires selecting sources again.
- Ctrl+Tab may be intercepted by the browser.

## Gotchas

- Native desktop Open/Export dialogs are not driveable over CDP. File drops provide a separate entry point; they do not verify those dialogs.
- The empty screen has two Open CSV buttons. Use `--nth 0`.
- Wait for grid values after metadata appears. The row count can paint before the cells.
- An edited tab's accessible name includes Unexported Changes. An exact filename match can select a different tab when names repeat.
- A drop during loading is declined, not queued. Retry after loading completes.
- Folders are rejected even when their names end in .csv. Text and in-app grid drags must retain their normal behavior.
- Mixed-drop errors remain visible after successful files open. The last successful open receives focus, including an already-open desktop source.
- Desktop dirty reopen uses a native confirmation. Finish verification before invoking it without a human.
