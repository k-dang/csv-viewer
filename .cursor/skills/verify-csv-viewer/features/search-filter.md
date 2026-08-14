# Search and clear query

Global search filters the visible grid across all columns. Clear query removes search (and grid sort/filter) and restores the full row count. Search does not change the CSV on disk.

## Sub-features

- `search-match` narrows visible rows to matches.
- `search-empty` shows no matching rows for a query that hits nothing.
- `search-clear` restores the unfiltered row count.
- `search-compose` keeps file identity and Ready state while the query is active.

## How to get to it (user POV)

- Type into `Global search` (`Search all columns`) after a CSV tab is open.
- Choose `Clear query` to drop search and grid query state.
- Column header filters in the grid are a second entry point. They debounce for 1500ms and are AG Grid widgets. Prefer Global search unless the proof is specifically about a column filter.

## Driving it with control-csv-viewer

Preconditions:

- `doctor` is `ok`.
- `phase-2-sample.csv` is the active tab with `5 visible of 5 rows`, `Ready`, and grid text `Ada Lovelace` and `Grace Hopper`.

- **Before.** Snapshot `evidence/search-filter/before.aria.txt` and screenshot `before.png`. They show `5 visible of 5 rows` and both names.
- **Match.** Run `fill --role searchbox --name "Global search" --value "Ada"`. Wait `wait --text "1 visible of 5 rows"`. Grid shows `Ada Lovelace` and does not show `Grace Hopper`. Badge returns to `Ready`.
- **Empty match.** Run `fill --role searchbox --name "Global search" --value "volcano"`. Wait for `0 visible of 5 rows` or `No rows match the current query.` `Ready` still appears after the query finishes.
- **Clear.** Run `click --role button --name "Clear query"`. Wait for `5 visible of 5 rows`. Searchbox is empty. `Ada Lovelace` and `Grace Hopper` are both visible again.
- **Proof.** Snapshot and screenshot `evidence/search-filter/match.aria.txt` and `match.png` during the Ada match, before clearing. They show `CSV Viewer`, `phase-2-sample.csv`, `1 visible of 5 rows`, `Ada`, and `Main process connected`.
- **Source.** `fixtures/phase-2-sample.csv` bytes are unchanged.

## Gotchas

- Insert row buttons disable while search is active. That is expected. Do not treat disabled insert as a failed search proof.
- Do not wait a fixed 1500ms for global search. That debounce belongs to column filters. Wait for the visible-row line.
- `Clear query` is disabled when nothing is queried. Enable it by searching first.
- A screenshot of the searchbox value alone is not proof. The visible-row line and missing non-matching names are the proof.
