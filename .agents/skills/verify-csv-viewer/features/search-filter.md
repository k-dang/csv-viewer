# Search and clear query

Global search filters the visible grid across all columns. Clear query removes search (and grid sort/filter) and restores the full row count. Search does not change the CSV on disk.

## Sub-features

- `search-match` narrows visible rows to matches.
- `search-empty` shows no matching rows for a query that hits nothing.
- `search-clear` restores the unfiltered row count.
- `search-compose` keeps file identity and Ready state while the query is active.
- `search-value-filter` keeps or excludes column values from the Cell Menu or the header Value Filter.

## How to get to it (user POV)

- Type into `Global search` (placeholder `Search all columns`) after a CSV tab is open.
- Choose `Clear query` to drop search and grid query state.
- Column header filters in the grid are a second entry point. Every column loads as text, so every header filter is the Value Filter: a `Search values` searchbox (300ms debounce) that filters rows and narrows the list, above a `Values` list of the column's top values, each a checkbox with its row count, plus `Select all` and `Clear filter`. Right-clicking any cell opens `Copy value`, `Filter to this value`, and `Exclude this value`. Prefer Global search unless the proof is specifically about a column filter.

## Driving it with control-csv-viewer

Preconditions:

- `doctor` is `ok`.
- `phase-2-sample.csv` is the active tab with `5 visible of 5 rows`, `Ready`, and grid text `Ada Lovelace` and `Grace Hopper`.

- **Before.** Snapshot `evidence/search-filter/before.aria.txt` and screenshot `before.png`. They show `5 visible of 5 rows` and both names.
- **Match.** Run `fill --role searchbox --name "Global search" --value "Ada"`. Wait `wait --text "1 visible of 5 rows"`. Grid shows `Ada Lovelace` and does not show `Grace Hopper`. The status bar returns to `Ready`.
- **Empty match.** Run `fill --role searchbox --name "Global search" --value "volcano"`. Wait for `0 visible of 5 rows` or `No rows match the current query.` `Ready` still appears after the query finishes.
- **Clear.** Run `click --role button --name "Clear query"`. Wait for `5 visible of 5 rows`, then confirm with `text` that `Ada Lovelace` and `Grace Hopper` are both back. Searchbox is empty.
- **Cell Menu filter.** Run `click --right --role gridcell --name "inactive" --exact`, then `click --role menuitem --name "Exclude this value"`, and wait for `4 visible of 5 rows`. Run `click --right --role gridcell --name "active" --exact --nth 0`, then `click --role menuitem --name "Filter to this value"`, and wait for `3 visible of 5 rows`. `Clear query` restores `5 visible of 5 rows`.
- **Value Filter.** Click `--role gridcell --name "active" --exact --nth 0` (first row), `press --key ArrowUp` to focus the `status` header, then `press --key "Control+Enter"`. Run `fill --role searchbox --name "Search values" --value "pend"` and wait for `1 visible of 5 rows`. `click --role button --name "Clear filter"`, then `click --role checkbox --name "inactive"` and wait for `4 visible of 5 rows`. `press --key Escape` closes the popup; `Clear query` clears the filter.
- **Proof.** Snapshot and screenshot `evidence/search-filter/match.aria.txt` and `match.png` during the Ada match, before clearing. They show `CSV Viewer`, `phase-2-sample.csv`, `1 visible of 5 rows`, and `Ada`.
- **Source.** `fixtures/phase-2-sample.csv` bytes are unchanged.

## Web differences

None. Global search, the empty-match overlay, and Clear query all live in the shared grid and behave identically on both targets.

## Gotchas

- The count line keeps the filtered value (`1 visible of 5 rows`) until the refetch after Clear query lands, so `5 visible of 5 rows` is itself proof the refetch happened. Still pair it with both grid names via `text`.
- Only `Append row` disables while search, sort, or filter is active. `Insert row above` and `Insert row below` need exactly one selected row and ignore the query: with `Ada` searched, click `Ada Lovelace` and `Insert row above` reports `"disabled": false` and inserts. The new empty row does not match the search, so the visible count stays 1 and the total includes the new row: `1 visible of 6 rows`. Clear query then reads `6 visible of 6 rows`.
- Read the disabled claim from `click`'s `"disabled"` JSON field. The `snapshot` AX dump does not carry disabled state.
- `No rows match the current query.` is the global-search overlay only. A column header filter that matches nothing shows AG Grid's own `No Matching Rows` instead.
- Do not wait a fixed debounce for global search. The only debounce is the Value Filter's `Search values` (300ms). Global search has no debounce; `fill` replaces the whole value in one input event. Wait for the visible-row line.
- `Clear query` is disabled when no search, sort, or filter is active and the visible count equals the row count stored at open or Reopen. Insert or delete enables the button even when the search is empty. Undo or Reopen that restores the stored count disables it again. Do not use its enabled state to infer an active query.
- Search is a case-insensitive substring across every column. `active` also matches `inactive`, so that query is `4 visible of 5 rows`, not 3.
- A screenshot of the searchbox value alone is not proof. The visible-row line and missing non-matching names are the proof.
- The header filter icon has no role, so `click` cannot reach it. Use ArrowUp from a first-row cell, then `Control+Enter`.
- A `Values` checkbox name joins the value, its count, and `on`, such as `inactive1 on`. `--name "active"` also matches `inactive1 on`, so name a unique value or pass `--nth`.
