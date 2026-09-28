# Column value counts

The Stats Panel counts distinct values in one column, limited to the current Count Scope (active filters and global search, not sort order). It does not edit the CSV.

## Sub-features

- `stats-open` opens Column Value Counts for the focused column, else the last column the panel used, else the first column.
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

- **Open.** Run `click --role button --name "Open stats panel"`. Wait for `Column Value Counts`.
- **Counts.** Switch to `status`. Run `click --role combobox --name "Stats Column"`, then `click --role option --name "status"`. If that option click finds nothing, `press --key ArrowDown` and click the option. Wait for `5 scoped rows`. Visible counts are `active` 3, `inactive` 1, `pending` 1 (phase-2-sample.csv statuses: active, inactive, active, pending, active).
- **Proof.** Snapshot and screenshot `evidence/column-counts/status.aria.txt` and `status.png` with the panel open on `status` before search, showing `CSV Viewer`, `Column Value Counts`, `5 scoped rows`, and `active`.
- **Scoped recount.** Keep the panel open. Run `fill --role searchbox --name "Global search" --value "active"`. Wait for `4 visible of 5 rows` (`inactive` contains `active`) and then for `4 scoped rows`. Status counts now reflect those four rows (`active` 3, `inactive` 1).
- **Close.** Clear the query first, then run `click --role button --name "Close stats panel" --nth 0`. The panel is gone and the toolbar button returns to `Open stats panel`.
- **Source.** `fixtures/phase-2-sample.csv` is unchanged.

## Web differences

None. The Stats Panel and its Count Scope behave the same on both targets. A trigger click can open the Stats Column list on either target. If the option click finds nothing, press ArrowDown and click the option.

## Gotchas

- A click on the `Stats Column` trigger can open the list. If `click --role option` finds nothing, `press --key ArrowDown` and click the option. A second click on the trigger closes the list.
- Never click the trigger twice to "make sure" it opened. The second click closes it again, and the next click lands on whatever is underneath.
- Close the open option list before clicking anything else in the window. A click aimed at another control while the list is open lands on the list and silently changes the Stats Column.
- Counts follow search and filters, not sort order. Sorting still refetches and briefly re-shows `Calculating counts`; the numbers come back identical.
- `wait` only polls for the presence of a substring, so the disappearance of `Calculating counts` cannot be waited on. Wait for `N scoped rows` instead.
- Opening the panel uses the focused grid column when the tab has one, ahead of the column the panel last showed. Closing the panel does not clear that focus, so a later open returns to the cell's column. The remembered column applies only when no cell in the tab has been focused. If counts look like `id` uniqueness (five values of 1), you are not on `status`.
- The panel is `<aside aria-label="Stats Panel">` with no `role`, so `--role region` never matches it. Wait for the text `Column Value Counts`.
- The toolbar button label toggles between `Open stats panel` and `Close stats panel`. While the panel is open, the in-panel X uses the same Close name, so `click` reports ambiguous without `--nth 0`. Do not reach for `--exact` here: both names are doubled to `Close stats panel Close stats panel`, so an exact match finds nothing.
- Search `active` is a substring match. Do not wait for `3 visible of 5 rows`.
