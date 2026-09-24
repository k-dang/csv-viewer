# Copy a column

The Column Bar sits in the status bar below the row grid. It names the focused column, shows how many values the current query leaves in it, and copies those values to the clipboard one per line (nulls as empty lines). The grid tints the same column. It does not edit the CSV.

## Sub-features

- `column-focus` names the column of the last focused cell (click or arrow-key navigation) and tints that column in the grid.
- `column-copy` copies the focused column under the current sort, filters, and global search, from the `Copy column` button or Ctrl+Shift+A (Cmd+Shift+A) while a column is focused.
- `column-notice` confirms successful clipboard writes with a bottom-right toast showing `Copied N values` (`Copied 1 value` for a single row) and `From <column>`. It closes after three seconds while the window is focused, or with `Close toast`.

## How to get to it (user POV)

- With a CSV open, click any grid cell or move to one with the arrow keys. The Column Bar changes from `Select a cell to copy its column.` to the column name.
- Choose `Copy column`, or press Ctrl+Shift+A (Cmd+Shift+A on macOS) while a column is focused. Plain Ctrl+C copies only the focused cell.
- Paste anywhere to get the values.

## Driving it with control-csv-viewer

Preconditions:

- `doctor` is `ok`.
- `phase-2-sample.csv` is active with `5 visible of 5 rows` and no search.

- **Idle.** The text `Select a cell to copy its column.` is visible and no `Copy column` button exists.
- **Focus.** Run `click --role gridcell --name "grace@example.com"`. Wait for `email 5 values`. The `email` column, header included, is tinted.
- **Copy.** Run `click --role button --name "Copy column"`. Wait for `Copied 5`.
- **Proof.** Screenshot `evidence/copy-column/copied.png` showing `CSV Viewer`, `email 5 values`, `Copied 5`, and the tinted column.
- **Shortcut.** Run `click --role button --name "Close toast" --nth 0` to clear the earlier toast, then `click --role gridcell --name "Ada Lovelace"` and `press --key "Control+Shift+a"`. Wait for `Copied 5` and `From name`.
- **Cell copy.** Run `click --role button --name "Close toast" --nth 0`, then `click --role gridcell --name "Ada Lovelace"` to put focus back on the cell (closing the toast moves it away), then `press --key "Control+c"`. Wait for `Copied 1 value`: plain Ctrl+C copies only the focused cell.
- **Editing keeps its own copy.** Close every earlier toast with `click --role button --name "Close toast" --nth 0` and confirm `text` has no `Copied`. Run `click --role gridcell --name "Grace Hopper" --double`, then `press --key "Control+Shift+a"`. `text` still contains no `Copied`. Run `press --key Escape`.
- **Scoped copy.** Run `fill --role searchbox --name "Global search" --value "active"`. Wait for `4 visible of 5 rows`. Run `click --role gridcell --name "Ada Lovelace"` then `click --role button --name "Copy column"`. Wait for `name 4 values` and `Copied 4`.
- **Source.** `fixtures/phase-2-sample.csv` is unchanged.

## Web differences

None. The clipboard write is the browser Clipboard API on both targets.

## Gotchas

- The clipboard is not readable through the helper. Prove the copy by `Copied N` matching the visible row count; the joined text itself is covered by the workspace contract tests.
- Toasts close after three seconds only while the window is focused; hovering, focusing, or an unfocused window pauses the timer. A launched run is unfocused by definition, so toasts linger well past three seconds and repeated copies stack, including when the column stays the same. Do not wait for auto-close: run `click --role button --name "Close toast" --nth 0` once per toast, then re-run `text` until `Copied` is gone before the editing check.
- A visible toast is `role="dialog"`, and the drop zone declines drops while any dialog is open. Close every toast before a `drop`, or the drop silently does nothing.
- The Column Bar count has no singular form: a one-row query reads `1 values`, while the toast reads `Copied 1 value`.
- Ctrl+Shift+A is Copy column for the focused column from anywhere in the window except a text field (global search, an open cell editor), so it still works after a click on a toast or button. Plain Ctrl+C copies the focused cell's raw value only while that cell has focus, no editor is open, and no text is selected; text selected across cells goes to the browser's own copy.
- Clicking a cell also selects its row, so the row highlight and the column tint overlap on that cell. That is expected.
- The count follows the query, so after a search the bar reads the filtered count, not the CSV's row count.
