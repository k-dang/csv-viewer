# Column value counts

The Stats Panel counts distinct values in one column, limited to the current Count Scope (active filters and global search, not sort). It does not edit the CSV.

## Sub-features

- `stats-open` opens Column Value Counts for the focused or first column.
- `stats-counts` shows per-value row counts for the selected Stats Column.
- `stats-scope` recounts after Global search changes the Count Scope.
- `stats-close` hides the panel.

## How to get to it (user POV)

- With a CSV open, choose `Open stats panel`.
- Change `Stats Column` in the panel.
- Click a grid cell first if you want that column to be the one opened.
- Choose `Close stats panel` in the toolbar or inside the panel.

## Driving it with control-csv-viewer

Preconditions:

- `doctor` is `ok`.
- `phase-2-sample.csv` is active with `5 visible of 5 rows` and no search.

- **Open.** Run `click --role button --name "Open stats panel"`. Wait for region `Stats Panel` and heading `Column Value Counts`. The first column `id` or the focused column is selected.
- **Counts.** Switch to `status` if needed by clicking combobox `Stats Column` then the `status` option. Wait until `Calculating counts` is gone. Visible counts include `active` with 3 rows and `inactive`, `pending` with 1 each (phase-2-sample.csv statuses: active, inactive, active, pending, active).
- **Scoped recount.** Keep the panel open. Run `fill --role searchbox --name "Global search" --value "active"`. Wait for `3 visible of 5 rows` and for the panel to finish `Calculating counts`. Status counts now reflect the searched rows only.
- **Close.** Run `click --role button --name "Close stats panel"`. The `Stats Panel` region is gone. Toolbar button returns to `Open stats panel`.
- **Proof.** Snapshot and screenshot `evidence/column-counts/status.aria.txt` and `status.png` with the panel open on `status` before search, showing `CSV Viewer`, `Column Value Counts`, `active`, and `Main process connected`.
- **Source.** `fixtures/phase-2-sample.csv` is unchanged.

## Gotchas

- Counts follow search and filters, not sort order.
- Opening the panel after focusing a cell uses that column. If counts look like `id` uniqueness (five values of 1), you are not on `status`.
- `Calculating counts` is transient. Wait until it disappears before asserting numbers.
- The toolbar button label toggles between `Open stats panel` and `Close stats panel`.
