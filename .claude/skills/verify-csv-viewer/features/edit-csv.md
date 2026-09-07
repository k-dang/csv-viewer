# Edit a CSV

Editing changes the in-memory Working CSV. Cell values stay text. Insert, append, and delete target source rows. Undo and redo walk that history one recorded command at a time. Export CSV writes a different file through an OS dialog and is not completable from CDP.

## Sub-features

- `edit-cell` changes one visible cell and marks the tab dirty.
- `edit-insert` inserts a row above or below the single selected source row when no query is active.
- `edit-append` appends an empty row when no rows are selected and no query is active.
- `edit-delete` deletes selected rows.
- `edit-undo-redo` restores and re-applies those changes.
- `edit-blocked-insert` keeps insert/append disabled under search, sort, or filter.
- `edit-export` is the Export CSV path. Unattended runs cannot finish the OS dialog.

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
- **Blocked insert.** Run `fill --role searchbox --name "Global search" --value "Ada"`. Click `Append row` and read `"disabled": true` from the JSON. Clear query with `click --role button --name "Clear query"` before further inserts.
- **Source.** `fixtures/phase-2-sample.csv` bytes still match the pre-edit copy while `Unexported Changes` is showing.
- **Export skip.** Do not click `Export CSV`. Report `edit-export` as unreachable without a human OS dialog.
- **Proof.** Snapshot and screenshot `evidence/edit-csv/dirty.aria.txt` and `dirty.png` while `Unexported Changes`, `Ada Lovelace Edited`, and `CSV Viewer` are visible.
- **Return to clean.** Click `Undo edit` once per recorded command. The recipe above records four (cell edit, append, insert, delete), so that is four clicks, not one. Confirm with `text` that `Unexported Changes` is gone and the row count is back to `5 visible of 5 rows` before `Close phase-2-sample.csv`.

## Gotchas

- Closing a dirty tab opens `window.confirm` (`Unexported Changes will be lost.`), which blocks the renderer. The helper never sends `Page.handleJavaScriptDialog`, so every later command hangs and the run is lost. Undo all the way to clean before closing. The exact confirm text is only verifiable from source, never from CDP.
- Undo is one step per recorded command, not one step back to clean. The dirty marker clears only when the current revision matches the last exported one.
- If `fill --focused` throws `No value setter`, the AG Grid editor did not take focus. Capture `text` and a screenshot, then stop. Do not reach for `window.csvViewer.call({ operation: 'csv.edit-cell', ... })` from CDP eval; that skips the user path.
- Insert needs exactly one selected row and no active sort, filter, or search. Append needs zero selected rows and no query. Delete needs a selection. `#metadata-title` does not clear the grid selection. A cell edit leaves Append enabled; click a row after that if you need Insert.
- Disabled state is only readable from `click`'s JSON output. The AX snapshot does not carry it, so `edit-blocked-insert` cannot be proven from a snapshot or screenshot.
- Dirty UI is not persistence. The proof that Export CSV did not run is the unchanged fixture on disk.
- `File → Export CSV...` and `File → Close Tab` reach the same handlers as the buttons, but CDP cannot trigger Electron menu accelerators. Cover that translation with the intent unit tests instead.
