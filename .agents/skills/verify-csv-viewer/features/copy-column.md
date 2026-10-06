# Copy a column

The status bar below the row grid names the focused column and shows how many values the current query leaves in it. `Copy column` in the Column Menu (right-click a column header) or Ctrl+Shift+A copies those values to the clipboard one per line (nulls as empty lines). The grid tints the same column. Copying does not edit the CSV.

## Sub-features

- `column-focus` names the column of the last focused cell (click or arrow-key navigation) or right-clicked header, and tints that column in the grid.
- `column-copy` copies the focused column under the current sort, filters, and global search, from `Copy column` in the Column Menu or Ctrl+Shift+A (Cmd+Shift+A) while a column is focused.
- `column-notice` confirms successful clipboard writes with a bottom-right toast showing `Copied N values` (`Copied 1 value` for a single row) and `From <column>`. It closes after three seconds while the window is focused, or with `Close toast`.

## How to get to it (user POV)

- With a CSV open, click any grid cell or move to one with the arrow keys. The status bar changes from `Right-click a column header to edit the column.` to the column name.
- Right-click the column header and choose `Copy column`, or press Ctrl+Shift+A (Cmd+Shift+A on macOS) while a column is focused. Plain Ctrl+C copies only the focused cell.
- Paste anywhere to get the values.

## Driving it with control-csv-viewer

Preconditions:

- `doctor` is `ok`.
- `phase-2-sample.csv` is active with `5 visible of 5 rows` and no search.

- **Idle.** The text `Right-click a column header to edit the column.` is visible and no `Copy column` item exists.
- **Focus.** Run `click --role gridcell --name "grace@example.com"`. Wait for `email`, then wait for `5 values`. `wait --text "email 5 values"` times out. `text` puts a line break between those status-bar nodes. The `email` column, header included, is tinted.
- **Copy.** Run `click --right --role columnheader --name "email"`, then `click --role menuitem --name "Copy column"`. Wait for `Copied 5`.
- **Proof.** Screenshot `evidence/copy-column/copied.png` showing `CSV Viewer`, the status line `email 5 values`, `Copied 5`, and the tinted column. That status line is one visual row. `wait` still needs the two strings from the Focus step.
- **Shortcut.** Run `click --role button --name "Close toast" --nth 0` to clear the earlier toast, then `click --role gridcell --name "Ada Lovelace"` and `press --key "Control+Shift+a"`. Wait for `Copied 5` and `From name`.
- **Cell copy.** Run `click --role button --name "Close toast" --nth 0`, then `click --role gridcell --name "Ada Lovelace"` to put focus back on the cell (closing the toast moves it away), then `press --key "Control+c"`. Wait for `Copied 1 value`: plain Ctrl+C copies only the focused cell.
- **Editing keeps its own copy.** Close every earlier toast with `click --role button --name "Close toast" --nth 0` and confirm `text` has no `Copied`. Run `click --role gridcell --name "Grace Hopper" --double`, then `press --key "Control+Shift+a"`. `text` still contains no `Copied`. Run `press --key Escape`.
- **Scoped copy.** Run `fill --role searchbox --name "Global search" --value "active"`. Wait for `4 visible of 5 rows`. Run `click --right --role columnheader --name "name"` then `click --role menuitem --name "Copy column"`. Wait for `name`, `4 values`, and `Copied 4`. `wait --text "name 4 values"` times out for the same reason as `email 5 values`.
- **Source.** `fixtures/phase-2-sample.csv` is unchanged.

## Web differences

None. The clipboard write is the browser Clipboard API on both targets.

## Gotchas

- The clipboard is not readable through the helper. Prove the copy by `Copied N` matching the visible row count. The workspace contract returns the value array, nulls included. The newline join is checked in `packages/ui/src/csv/csv-tab.test.ts` and `e2e/clipboard.spec.ts`.
- The toast timer is three seconds. It pauses after the window blurs, or while the pointer is over the toast. A launch that never blurs the window does not pause it, so `Copied N values` can disappear about three seconds later. Take the screenshot as soon as the toast appears. If `Close toast` is already gone, continue. While a toast is still up, run `click --role button --name "Close toast" --nth 0` once per toast, then re-run `text` until `Copied` is gone before the editing check.
- A visible toast is `role="dialog"`, and the drop zone declines drops while any dialog is open. Close every toast before a `drop`, or the drop silently does nothing.
- The status bar count has no singular form: a one-row query reads `1 values`, while the toast reads `Copied 1 value`.
- Ctrl+Shift+A is Copy column for the focused column from anywhere in the window except a text field (global search, an open cell editor), so it still works after a click on a toast or button. Plain Ctrl+C copies the focused cell's raw value only while that cell has focus, no editor is open, and no text is selected; text selected across cells goes to the browser's own copy.
- Clicking a cell also selects its row, so the row highlight and the column tint overlap on that cell. That is expected.
- The count follows the query, so after a search the status bar reads the filtered count, not the CSV's row count.
- `wait` and `text` split the status bar. The column name and `N values` are separate lines there, even when the screen shows them on one line. `Copied N values` stays one string.
