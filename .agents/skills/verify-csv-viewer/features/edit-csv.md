# Edit a CSV

Editing changes the in-memory Working CSV. Cell values stay text. Insert, append, and delete target source rows. Column insert, delete, rename, and reorder change the Working CSV schema only. Undo and redo walk that history one recorded command at a time. Export CSV writes a different file: through an OS dialog on desktop, as a browser download on web.

## Sub-features

- `edit-cell` changes one visible cell and marks the tab dirty.
- `edit-insert` inserts a row above or below the single selected source row. An active search, sort, or filter does not block it.
- `edit-append` appends an empty row when no rows are selected and no query is active.
- `edit-delete` deletes selected rows.
- `edit-undo-redo` restores and re-applies those changes.
- `edit-rename` renames the focused column header in place, rejects blank, duplicate, and reserved names, and is undone like other edits.
- `edit-column` inserts an empty column left or right of the focused column and deletes the focused column. Undo restores a deleted column at its old position with its cells. Delete column is disabled when one column remains.
- `edit-reorder` drags one column header onto another and keeps that order on the Working CSV. Undo restores the previous order.
- `edit-blocked-append` keeps Append row disabled under search, sort, or filter. Insert row above/below stay enabled with one selected row.
- `edit-export` is the Export CSV path. Desktop needs a human for the OS dialog; web is provable unattended.

## How to get to it (user POV)

- Double-click a grid cell, type, press Enter.
- Select one row, then `Insert row above` or `Insert row below`.
- With no row selected, choose `Append row`.
- Select one or more rows, then `Delete selected rows`.
- Choose `Undo edit` and `Redo edit`.
- Right-click a column header to open the Column Menu at the pointer. Choose `Rename column`: the Column name field opens under the header with the old name selected. Type a new header, press Enter.
- Right-click a column header, then choose `Insert column left`, `Insert column right`, or `Delete column`. A right-click on a cell opens the Cell Menu (`Copy value`, `Filter to this value`, `Exclude this value`) instead.
- Drag a column header onto another column header. The grid and later exports use that order.
- Focus a column header by pressing Up from a cell on the first row, then press F2. The same Column name field opens. A click on the header sorts that column and counts as a query. Append row then stays disabled until Clear query. F2 while a cell, the search box, or any other control is focused leaves rename closed.
- Choose `Export CSV`, or `File → Export CSV...`, then pick a destination in the OS dialog.
- Close a tab with its close button, or `File → Close Tab`; a dirty tab asks to confirm first.

## Driving it with control-csv-viewer

Preconditions:

- `doctor` is `ok`.
- `phase-2-sample.csv` is active, `5 visible of 5 rows`, no search, no `Unexported Changes`.
- A copy of `fixtures/phase-2-sample.csv` bytes is kept for later comparison.

Count your edits as you go. Each bullet below records exactly one command, and the undo at the end needs one click per recorded command.

- **Edit a cell.** Run `click --role gridcell --name "Ada Lovelace" --double`, then `fill --focused --value "Ada Lovelace Edited"`, then `press --key Enter`. Wait for `Ada Lovelace Edited` and `Unexported Changes`. `Undo edit` enables. `Export CSV` (visible label `Export`) is available on clean and dirty tabs, and disables while that tab has an export in progress, when the status bar reads `Exporting…`.
- **Undo.** Run `click --role button --name "Undo edit"`. Read `text`: `Ada Lovelace` is back without `Edited`. `Redo edit` enables.
- **Redo.** Run `click --role button --name "Redo edit"`. `Unexported Changes` and `Ada Lovelace Edited` return.
- **Rename.** Run `click --right --role columnheader --name "email"`, then `click --role menuitem --name "Rename column"`. Wait until the `Rename` button is visible. The Column name field opens only after the menu closes, and an immediate `type` misses it. Then `type --text "work_email"` (the old name is selected, so typing replaces it), then `press --key Enter`. Use `type` for this first name, not `fill`. `fill` focuses the field itself and would hide a focus bug. Wait for `work_email` in the status bar. The header stays between `name` and `signup_date`. `Unexported Changes` remains. Duplicate: open Rename again, wait for `Rename`, `type --text "name"`, then `press --key Enter`, and wait for `CSV column name already exists.` Blank and reserved stay in that same field. A later `type` does not replace the rejected draft, so set it with `fill --role textbox --name "Column name" --value " "`, then `press --key Enter`, and wait for `CSV column name cannot be blank.`, then `fill` `__csvViewerRowId`, `press --key Enter`, and wait for `CSV column name is reserved.` Escape closes the field. Undo once to restore `email`.
- **Rename with F2.** Click `gridcell` `Ada Lovelace` (first row), then `press --key ArrowUp` so the `name` column header is focused. `press --key F2`, then `type --text "full_name"`, then `press --key Enter`. Wait for `full_name` in the status bar. Undo once to restore `name`. F2 while the search box is focused does not open Column name: `fill --role searchbox --name "Global search" --value ""` is enough to focus it, then `press --key F2`, and Column name stays absent.
- **Insert and delete columns.** Run `click --right --role columnheader --name "email"`, then `click --role menuitem --name "Insert column right"`, and wait for `New column` in the header row, between `email` and `signup_date`. Undo once. Right-click the `email` header again, run `click --role menuitem --name "Delete column"`, and confirm with `text` that `grace@example.com` is gone. Undo once: the `email` header and `grace@example.com` return between `name` and `signup_date`.
- **Reorder.** Run `drag --role columnheader --name "id" --exact --to-name "signup_date"`. `id` moves to the position after `signup_date`. The header row starts `name`, `email`, `signup_date`, `id`, and the other six columns stay in order. `Unexported Changes` appears. Undo once and `id` is first again. Reorder is its own recorded command. Undo it here so the five row commands below stay the ones you count.
- **Append.** A cell edit clears the selection, so `Append row` is enabled. Run `click --role button --name "Append row"`. Wait for `6 visible of 6 rows`.
- **Insert.** Click a grid cell to select one source row, then `click --role button --name "Insert row above"`. Wait for `7 visible of 7 rows`. Insert deselects rows.
- **Delete.** Run `click --role gridcell --name "Grace Hopper"` to reselect, then `click --role button --name "Delete selected rows"`. Wait for `6 visible of 6 rows` and confirm Grace is gone.
- **Blocked append.** Run `fill --role searchbox --name "Global search" --value "Ada"` and wait for `1 visible of 6 rows`. Click `Append row` and read `"disabled": true` from the JSON. Then `click --role gridcell --name "Ada Lovelace Edited"` and click `Insert row above`: it reports `"disabled": false` and inserts. Wait for `1 visible of 7 rows`: the empty row does not match `Ada`, but the total includes it. That insert is a fifth recorded command. Clear query with `click --role button --name "Clear query"` and wait for `7 visible of 7 rows`.
- **Source.** `fixtures/phase-2-sample.csv` bytes still match the pre-edit copy while `Unexported Changes` is showing.
- **Export skip.** Do not click `Export CSV`. Report `edit-export` as unreachable without a human OS dialog.
- **Proof.** Snapshot and screenshot `evidence/edit-csv/dirty.aria.txt` and `dirty.png` while `Unexported Changes`, `Ada Lovelace Edited`, and `CSV Viewer` are visible.
- **Return to clean.** Click `Undo edit` once per recorded command. The recipe above records five (cell edit, append, insert, delete, insert under query), so that is five clicks, not one. Confirm with `text` that `Unexported Changes` is gone and the row count is back to `5 visible of 5 rows` before `Close phase-2-sample.csv`.

## Web differences

Editing is shared, but export is only provable on web.

- `Export CSV` writes through an `<a download>` click with no dialog. The status bar reads `Exporting…`, then `Download started` (desktop says `Export complete`), and the file lands in the run's `downloads/` directory, which `doctor` prints as `downloadDir`.
- That makes `edit-export` verifiable end to end: edit a cell, export, then read the downloaded bytes and confirm they contain `Ada Lovelace Edited` and that `Unexported Changes` has cleared. Do not settle for the desktop-only negative proof.
- Export writes LF line endings. `fixtures/phase-2-sample.csv` and `fixtures/phase-2-sample-edited.csv` are LF already, so a CR in the download is a real mismatch.
- Repeated exports of one source do not overwrite each other: Chrome writes `phase-2-sample.csv`, then `phase-2-sample (1).csv`. Read the newest file by modification time. Copy anything you need into `evidence/` before `cleanup`.
- Export moves the dirty baseline. After a web export, every undo makes `Unexported Changes` reappear because the revision no longer matches the exported one. To close the tab without `window.confirm`, undo to the row count you want and export once more, or export only at the end.
- Closing a dirty tab uses the same `window.confirm` and wedges the run the same way.

## Gotchas

- Closing a dirty tab opens `window.confirm` (`Close phase-2-sample.csv?` then `Unexported Changes will be lost.`) on both runtimes, which blocks the renderer. The helper never sends `Page.handleJavaScriptDialog`, so every later command hangs and the run is lost. Undo all the way to clean before closing. The exact confirm text is only verifiable from source, never from CDP.
- Undo is one step per recorded command, not one step back to clean. The dirty marker clears only when the current revision matches the last exported one.
- If `fill --focused` throws `No value setter`, the AG Grid editor did not take focus. Capture `text` and a screenshot, then stop. Do not reach for `window.csvViewer.call({ operation: 'csv.edit-cell', ... })` from CDP eval; that skips the user path.
- `drag` moves the pointer from one control to another. `drop` opens files and does not reorder columns. A drag that starts and ends on the same header records nothing.
- A click on a column header sorts it. With no row selected, that query disables Append row. Use ArrowUp from the first row when the recipe needs a focused header without a query.
- Insert needs exactly one selected row; the query does not matter. Append needs zero selected rows and no query. Delete needs a selection. `#metadata-title` does not clear the grid selection. A cell edit leaves Append enabled; click a row after that if you need Insert.
- Disabled state is only readable from `click`'s JSON output. The AX snapshot does not carry it, so `edit-blocked-append` cannot be proven from a snapshot or screenshot.
- Dirty UI is not persistence. The proof that Export CSV did not run is the unchanged fixture on disk.
- `File → Export CSV...` and `File → Close Tab` reach the same handlers as the buttons, but CDP cannot click native Electron menus. Cover that translation with the intent unit tests instead.
