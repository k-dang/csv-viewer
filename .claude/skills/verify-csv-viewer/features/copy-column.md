# Copy a column

The Column Bar sits between the toolbar and the row grid. It names the focused column, shows how many values the current query leaves in it, and copies those values to the clipboard one per line (nulls as empty lines). The grid tints the same column. It does not edit the CSV.

## Sub-features

- `column-focus` names the column of the last clicked cell and tints that column in the grid.
- `column-copy` copies the focused column under the current sort, filters, and global search, from the `Copy column` button or Ctrl+C (Cmd+C) on a focused cell.
- `column-notice` confirms successful clipboard writes with a bottom-right toast showing `Copied N values` and `From <column>`. It closes after three seconds or with `Close toast`.

## How to get to it (user POV)

- With a CSV open, click any grid cell. The Column Bar changes from `Select a cell to copy its column.` to the column name.
- Choose `Copy column`, or press Ctrl+C (Cmd+C on macOS) while the cell is focused and no text is selected.
- Paste anywhere to get the values.

## Driving it with control-csv-viewer

Preconditions:

- `doctor` is `ok`.
- `phase-2-sample.csv` is active with `5 visible of 5 rows` and no search.

- **Idle.** The text `Select a cell to copy its column.` is visible and no `Copy column` button exists.
- **Focus.** Run `click --role gridcell --name "grace@example.com"`. Wait for `email 5 values`. The `email` column, header included, is tinted.
- **Copy.** Run `click --role button --name "Copy column"`. Wait for `Copied 5`.
- **Proof.** Screenshot `evidence/copy-column/copied.png` showing `CSV Viewer`, `email 5 values`, `Copied 5`, and the tinted column.
- **Shortcut.** Run `click --role gridcell --name "Ada Lovelace"` (close any earlier toast first), then `press --key "Control+c"`. Wait for `Copied 5`.
- **Editing keeps its own copy.** Close any earlier toast with `click --role button --name "Close toast"`, or wait for it to disappear. Run `click --role gridcell --name "Grace Hopper" --double`, then `press --key "Control+c"`. `text` contains no `Copied`. Run `press --key Escape`.
- **Scoped copy.** Run `fill --role searchbox --name "Global search" --value "active"`. Wait for `4 visible of 5 rows`. Run `click --role gridcell --name "Ada Lovelace"` then `click --role button --name "Copy column"`. Wait for `name 4 values` and `Copied 4`.
- **Source.** `fixtures/phase-2-sample.csv` is unchanged.

## Web differences

None. The clipboard write is the browser Clipboard API on both targets.

## Gotchas

- The clipboard is not readable through the helper. Prove the copy by `Copied N` matching the visible row count; the joined text itself is covered by the workspace contract tests.
- Toasts close after three seconds; hovering or focusing them pauses the timer. Capture evidence promptly. Repeated copies create separate toasts, including when the column stays the same.
- Ctrl+C is Copy column only when nothing is selected and no cell editor is open. Text selected across cells goes to the browser's own copy.
- Clicking a cell also selects its row, so the row highlight and the column tint overlap on that cell. That is expected.
- The count follows the query, so after a search the bar reads the filtered count, not the CSV's row count.
