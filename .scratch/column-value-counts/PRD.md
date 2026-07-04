Status: ready-for-agent

## Problem Statement

Users can open, inspect, search, filter, sort, and edit CSV-style files, but they cannot quickly answer basic distribution questions such as "how many rows have each status?" or "which customer type appears most often?" Today the closest workflow is to filter manually or scan visible rows, which is slow and unreliable for large CSVs.

Users need lightweight Column Value Counts inside the existing viewer so they can understand the Working CSV without exporting data or leaving the grid.

## Solution

Add a right-side Stats Panel to the CSV grid experience. The first version presents read-only Column Value Counts for one selected Stats Column.

The Stats Panel shows the Top Counted Values for the Stats Column within the current Count Scope. Count Scope is defined by active grid filters and global search, ignores sort order, and is calculated from the current Working CSV, including unsaved edits, inserted rows, deleted rows, undo, and redo state.

Each Top Counted Value row shows the exact Counted Value, its count, and its Scope Percentage. The first version shows at most 50 Top Counted Values, ordered by count descending and then by Counted Value ascending for ties.

## User Stories

1. As a CSV viewer user, I want to open a Stats Panel beside the grid, so that I can inspect quick statistics without leaving the row view.
2. As a CSV viewer user, I want Column Value Counts for one selected Stats Column, so that I can understand the distribution of values in that column.
3. As a CSV viewer user, I want the Stats Panel to default to my focused grid column when possible, so that opening the panel feels contextual.
4. As a CSV viewer user, I want the Stats Panel to default to the first CSV column when no grid column is focused, so that the panel always opens with useful content.
5. As a CSV viewer user, I want to change the Stats Column from inside the Stats Panel, so that I can inspect another column without closing the panel.
6. As a CSV viewer user, I want Column Value Counts to respect active grid filters, so that counts describe the same rows I am currently narrowing down.
7. As a CSV viewer user, I want Column Value Counts to respect global search, so that counts describe the rows matching my text search.
8. As a CSV viewer user, I want row sort order to have no effect on Column Value Counts, so that presentation order does not change the underlying statistic.
9. As a CSV viewer user, I want Counted Values to be exact and case-sensitive, so that inconsistent casing remains visible as a data quality issue.
10. As a CSV viewer user, I want empty strings and null cells to appear as separate Counted Values, so that missing and blank data are not silently merged.
11. As a CSV viewer user, I want counts to come from the Working CSV, so that unsaved changes are reflected in the stats I see.
12. As a CSV viewer user, I want edited cell values to update Live Stats, so that the panel stays aligned with the grid.
13. As a CSV viewer user, I want inserted rows to update Live Stats, so that new Working CSV rows are included in the selected Stats Column distribution.
14. As a CSV viewer user, I want deleted rows to update Live Stats, so that removed Working CSV rows are excluded from the selected Stats Column distribution.
15. As a CSV viewer user, I want undo and redo operations to update Live Stats, so that statistics follow the current edit state.
16. As a CSV viewer user, I want the panel to show each Counted Value's row count, so that I can answer direct "how many?" questions.
17. As a CSV viewer user, I want the panel to show Scope Percentage, so that I can understand each Counted Value's share of the Count Scope.
18. As a CSV viewer user, I want the Top Counted Values first, so that high-frequency values are immediately visible.
19. As a CSV viewer user, I want tied Counted Values to be ordered consistently, so that the list does not jump between refreshes.
20. As a CSV viewer user, I want the first version capped at 50 Top Counted Values, so that the panel remains fast and scannable on high-cardinality columns.
21. As a CSV viewer user, I want to see the Count Scope row total, so that I understand what denominator the Scope Percentage uses.
22. As a CSV viewer user, I want a loading state while counts refresh, so that I know the panel is working when large CSV queries take time.
23. As a CSV viewer user, I want an error state if count calculation fails, so that failures are visible instead of silently stale.
24. As a CSV viewer user, I want an empty state when the Count Scope has no rows, so that zero-result filters are clear.
25. As a CSV viewer user, I want the Stats Panel to be read-only in the first version, so that inspecting counts does not unexpectedly change grid filters.
26. As a CSV viewer user, I want the Stats Panel to stay open while I search and filter, so that I can watch Count Scope changes affect the distribution.
27. As a CSV viewer user, I want the Stats Panel to preserve my selected Stats Column while filters and search change, so that I can repeatedly inspect one column.
28. As a CSV viewer user, I want the Stats Panel to reset appropriately when I open a different CSV session, so that stale stats from a previous file are not shown.
29. As a CSV viewer user, I want wide CSVs to remain usable with the Stats Panel open, so that stats do not make the grid unusably cramped.
30. As a CSV viewer user, I want the Stats Panel to follow the app's light and dark themes, so that the feature feels native to the viewer.

## Implementation Decisions

- Add a read-only Stats Panel to the renderer grid experience. It should appear as a right-side panel rather than in column menus.
- Add a Stats Panel open/close control to the existing grid toolbar area. The panel should not replace the row grid.
- Track the focused grid column when available. When the Stats Panel opens, choose that column as the initial Stats Column; otherwise choose the first CSV column.
- Include a Stats Column selector inside the Stats Panel.
- Add a main-process data service operation for Column Value Counts. It should accept the active session, the Stats Column, filters, and global search. It should not accept or depend on sort descriptors.
- Add a shared request/response contract for Column Value Counts. Each result bucket should include the Counted Value, count, and Scope Percentage. The response should also include the Count Scope row total.
- Use the existing query descriptor vocabulary for filters and global search so Count Scope matches the grid's row-window behavior.
- Calculate counts from the same in-memory table used for grid rows, so Working CSV edits, inserts, deletes, undo, and redo are reflected.
- Treat Counted Values as exact parsed cell values. Preserve case sensitivity. Keep empty strings and null cells distinct.
- Limit the first version to the Top 50 Counted Values.
- Order Top Counted Values by count descending, then by Counted Value ascending for ties.
- Refresh Live Stats automatically when the Count Scope changes, the Stats Column changes, or the Working CSV changes through edit operations.
- Keep the first version read-only. Clicking a Counted Value does not apply a grid filter.
- Do not add a filter-within-values search box in the first version.
- Reuse existing renderer query-state patterns where practical for loading, ready, and failed states.
- Avoid creating an ADR for this feature. The decisions are product behavior and request shape choices that are easy to revise and do not currently represent hard-to-reverse architectural tradeoffs.

## Testing Decisions

- Good tests should assert external behavior: what counts are returned, what Count Scope means, what the user sees in the Stats Panel, and when refresh requests happen. Tests should avoid coupling to private SQL construction or AG Grid internals.
- The primary test seam is the main-process data service. Add behavior tests for Column Value Counts covering filter scope, search scope, sort independence, case-sensitive Counted Values, blank/null separation, Top 50 limiting, deterministic ordering, Scope Percentage, and Working CSV edits/inserts/deletes/undo/redo.
- The renderer test seam is the Stats Panel or its highest practical container. Cover opening the panel, defaulting the Stats Column, changing the Stats Column, loading/ready/error/empty states, count and percentage display, and refresh triggers.
- Add IPC/API contract coverage only as needed to ensure the renderer can call the new stats operation through the exposed API.
- Use existing data service tests as prior art for CSV parsing, filters, search, edits, inserts, deletes, and large-file behavior.
- Use existing grid data-source tests as prior art for mapping grid query state into shared request descriptors, but do not test AG Grid behavior directly.

## Out of Scope

- Clicking a Counted Value to filter the grid.
- A client-side "filter values" search box inside the Stats Panel.
- Full distribution export or showing every distinct Counted Value beyond the top 50.
- Multi-column statistics, cross-tabulation, histograms, charts, pivots, or aggregate math beyond counts and Scope Percentage.
- Persisting Stats Panel open state or selected Stats Column across app restarts.
- Changing CSV parsing, type inference, dialect controls, save behavior, or recent-file behavior.
- Adding new edit workflows from the Stats Panel.

## Further Notes

The domain language for this feature is captured in the root glossary. The PRD intentionally uses that vocabulary: Column Value Counts, Count Scope, Counted Value, Top Counted Values, Scope Percentage, Stats Panel, Stats Column, Working CSV, and Live Stats.

The current codebase already has a strong server-side query path for filters, search, row windows, and edit-aware data access. The feature should extend that path rather than deriving counts from only the currently rendered grid rows.
