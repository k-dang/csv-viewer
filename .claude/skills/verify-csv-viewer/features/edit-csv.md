# Edit a CSV

Editing changes the in-memory Working CSV. Cell values stay text. Insert, append, and delete target source rows. Undo and redo walk that history one recorded command at a time. Export CSV writes a different file: through an OS dialog on desktop, as a browser download on web.

## Sub-features

- `edit-cell` changes one visible cell and marks the tab dirty.
- `edit-insert` inserts a row above or below the single selected source row. An active search, sort, or filter does not block it.
- `edit-append` appends an empty row when no rows are selected and no query is active.
- `edit-delete` deletes selected rows.
- `edit-undo-redo` restores and re-applies those changes.
- `edit-blocked-append` keeps Append row disabled under search, sort, or filter. Insert row above/below stay enabled with one selected row.
- `edit-export` is the Export CSV path. Desktop needs a human for the OS dialog; web is provable unattended.

## How to get to it (user POV)

- Double-click a grid cell, type, press Enter.
- Select one row, then `Insert row above` or `Insert row below`.
- With no row selected, choose `Append row`.
- Select one or more rows, then `Delete selected rows`.
- Choose `Undo edit` and `Redo edit`.
- Choose `Export CSV`, or `File → Export CSV...` / `Ctrl+Shift+E`, then pick a destination in the OS dialog.
- Close a tab with its close button, or `File → Close Tab` / `Ctrl+W`; a dirty tab asks to confirm first.

## Driving it with control-csv-viewer

Preconditions:

- `doctor` is `ok`.
- `phase-2-sample.csv` is active, `5 visible of 5 rows`, no search, no `Unexported Changes`.
- A copy of `fixtures/phase-2-sample.csv` bytes is kept for later comparison.

Count your edits as you go. Each bullet below records exactly one command, and the undo at the end needs one click per recorded command.

- **Edit a cell.** Run `click --role gridcell --name "Ada Lovelace" --double`, then `fill --focused --value "Ada Lovelace Edited"`, then `press --key Enter`. Wait for `Ada Lovelace Edited` and `Unexported Changes`. `Undo edit` enables. `Export CSV` stays enabled whether or not the tab is dirty.
- **Undo.** Run `click --role button --name "Undo edit"`. Read `text`: `Ada Lovelace` is back without `Edited`. `Redo edit` enables.
- **Redo.** Run `click --role button --name "Redo edit"`. `Unexported Changes` and `Ada Lovelace Edited` return.
- **Append.** A cell edit clears the selection, so `Append row` is enabled. Run `click --role button --name "Append row"`. Wait for `6 visible of 6 rows`.
- **Insert.** Click a grid cell to select one source row, then `click --role button --name "Insert row above"`. Wait for `7 visible of 7 rows`. Insert deselects rows.
- **Delete.** Run `click --role gridcell --name "Grace Hopper"` to reselect, then `click --role button --name "Delete selected rows"`. Wait for `6 visible of 6 rows` and confirm Grace is gone.
- **Blocked append.** Run `fill --role searchbox --name "Global search" --value "Ada"` and wait for `1 visible of 6 rows`. Click `Append row` and read `"disabled": true` from the JSON. Then `click --role gridcell --name "Ada Lovelace Edited"` and click `Insert row above`: it reports `"disabled": false` and inserts, but the count line stays `1 visible of 6 rows` because the empty row does not match `Ada`. That insert is a fifth recorded command. Clear query with `click --role button --name "Clear query"` and wait for `7 visible of 7 rows`.
- **Source.** `fixtures/phase-2-sample.csv` bytes still match the pre-edit copy while `Unexported Changes` is showing.
- **Export skip.** Do not click `Export CSV`. Report `edit-export` as unreachable without a human OS dialog.
- **Proof.** Snapshot and screenshot `evidence/edit-csv/dirty.aria.txt` and `dirty.png` while `Unexported Changes`, `Ada Lovelace Edited`, and `CSV Viewer` are visible.
- **Return to clean.** Click `Undo edit` once per recorded command. The recipe above records five (cell edit, append, insert, delete, insert under query), so that is five clicks, not one. Confirm with `text` that `Unexported Changes` is gone and the row count is back to `5 visible of 5 rows` before `Close phase-2-sample.csv`.

## Web differences

Editing is shared, but export is only provable on web.

- `Export CSV` writes through an `<a download>` click with no dialog. The status line reads `Download started` (desktop says `Export complete`), and the file lands in the run's `downloads/` directory, which `doctor` prints as `downloadDir`.
- That makes `edit-export` verifiable end to end: edit a cell, export, then read the downloaded bytes and confirm they contain `Ada Lovelace Edited` and that `Unexported Changes` has cleared. Do not settle for the desktop-only negative proof.
- Exported CSVs are written with LF line endings even when the source fixture uses CRLF. Compare content, not bytes, or the diff is noise.
- Repeated exports of one source do not overwrite each other: Chrome writes `phase-2-sample.csv`, then `phase-2-sample (1).csv`. Read the newest file by modification time. Copy anything you need into `evidence/` before `cleanup`.
- Export moves the dirty baseline. After a web export, every undo makes `Unexported Changes` reappear because the revision no longer matches the exported one. To close the tab without `window.confirm`, undo to the row count you want and export once more, or export only at the end.
- Closing a dirty tab uses the same `window.confirm` and wedges the run the same way.

## Gotchas

- Closing a dirty tab opens `window.confirm` (`Unexported Changes will be lost.`), which blocks the renderer. The helper never sends `Page.handleJavaScriptDialog`, so every later command hangs and the run is lost. Undo all the way to clean before closing. The exact confirm text is only verifiable from source, never from CDP.
- Undo is one step per recorded command, not one step back to clean. The dirty marker clears only when the current revision matches the last exported one.
- If `fill --focused` throws `No value setter`, the AG Grid editor did not take focus. Capture `text` and a screenshot, then stop. Do not reach for `window.csvViewer.call({ operation: 'csv.edit-cell', ... })` from CDP eval; that skips the user path.
- Insert needs exactly one selected row; the query does not matter. Append needs zero selected rows and no query. Delete needs a selection. `#metadata-title` does not clear the grid selection. A cell edit leaves Append enabled; click a row after that if you need Insert.
- Disabled state is only readable from `click`'s JSON output. The AX snapshot does not carry it, so `edit-blocked-append` cannot be proven from a snapshot or screenshot.
- Dirty UI is not persistence. The proof that Export CSV did not run is the unchanged fixture on disk.
- `File → Export CSV...` and `File → Close Tab` reach the same handlers as the buttons, but CDP cannot trigger Electron menu accelerators. Cover that translation with the intent unit tests instead.
