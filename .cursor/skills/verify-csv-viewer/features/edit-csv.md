# Edit a CSV

Editing changes the in-memory Working CSV. Cell values stay text. Insert, append, and delete target source rows. Undo and redo walk that history. Export CSV writes a different file through an OS dialog and is not completable from CDP.

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
- Choose `Export CSV` and pick a destination in the OS dialog.

## Driving it with control-csv-viewer

Preconditions:

- `doctor` is `ok`.
- `phase-2-sample.csv` is active, `5 visible of 5 rows`, no search, no `Unexported Changes`.
- A copy of `fixtures/phase-2-sample.csv` bytes is kept for later comparison.

- **Edit a cell.** Run `click --role gridcell --name "Ada Lovelace" --double`, then `fill --focused --value "Ada Lovelace Edited"`, then `press --key Enter`. Wait for `Unexported Changes` and grid text `Ada Lovelace Edited`. `Undo edit` enables. `Export CSV` stays enabled whether or not the tab is dirty.
- **Undo.** Run `click --role button --name "Undo edit"`. Wait until `Unexported Changes` is gone and `Ada Lovelace` is back without `Edited`. `Redo edit` enables.
- **Redo.** Run `click --role button --name "Redo edit"`. `Unexported Changes` and `Ada Lovelace Edited` return.
- **Append.** After the cell edit, `Append row` is enabled. Run `click --role button --name "Append row"`. Wait for `6 visible of 6 rows`. Do not click `#metadata-title` to drop selection; that heading has no deselect handler.
- **Insert.** Click a grid cell to select one source row, then `click --role button --name "Insert row above"`. Wait for the visible count to increase by one. Insert deselects rows.
- **Delete.** Run `click --role gridcell --name "Grace Hopper"`, then `click --role button --name "Delete selected rows"`. Wait until Grace is gone and the visible count drops by one.
- **Blocked insert.** Run `fill --role searchbox --name "Global search" --value "Ada"`. `Insert row above`, `Insert row below`, and `Append row` are disabled. Clear query with `click --role button --name "Clear query"` before further inserts.
- **Source.** `fixtures/phase-2-sample.csv` bytes still match the pre-edit copy while `Unexported Changes` is showing.
- **Export skip.** Do not click `Export CSV`. Report `edit-export` as unreachable without a human OS dialog.
- **Proof.** Snapshot and screenshot `evidence/edit-csv/dirty.aria.txt` and `dirty.png` while `Unexported Changes` and `Ada Lovelace Edited` are visible, including `CSV Viewer` and `Main process connected`. Undo to a clean state before `Close phase-2-sample.csv`.

## Gotchas

- If `fill --focused` throws `No value setter`, the AG Grid editor did not take focus. Capture `text` and a screenshot, then stop. Do not call `window.csvViewer.editCsvCell`.
- Insert needs exactly one selected row and no active sort, filter, or search. Append needs zero selected rows and no query. Delete needs a selection. `#metadata-title` does not clear the grid selection. A cell edit leaves Append enabled; click a row after that if you need Insert.
- Closing a dirty tab opens `window.confirm` (`Unexported Changes will be lost.`). Undo to a clean state before `Close phase-2-sample.csv`.
- Dirty UI is not persistence. The proof that Export CSV did not run is the unchanged fixture on disk.
