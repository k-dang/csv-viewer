Status: ready-for-agent

## What to build

Extend Column Value Counts so the Stats Panel uses the same Count Scope as the grid's active filters and global search. Live Stats should refresh when the user changes search text or grid filters, and sort order must not affect counts.

This slice turns the unscoped stats path into a query-aware path while keeping the panel read-only and preserving the selected Stats Column across Count Scope changes.

## Acceptance criteria

- [ ] The stats request accepts active grid filters and global search.
- [ ] Column Value Counts respect active grid filters.
- [ ] Column Value Counts respect global search.
- [ ] Column Value Counts ignore row sort order.
- [ ] The Stats Panel refreshes when grid filters change.
- [ ] The Stats Panel refreshes when global search changes.
- [ ] The selected Stats Column is preserved while filters and search change.
- [ ] The panel shows a clear empty state when Count Scope has zero rows.
- [ ] The panel shows a loading state while scoped counts refresh.
- [ ] Data service tests cover filter scope, search scope, combined filter/search scope, zero-row Count Scope, and sort independence.
- [ ] Renderer tests cover refresh triggers for filters/search and visible empty/loading states.

## Blocked by

- .scratch/column-value-counts/issues/01-render-unscoped-column-value-counts.md

## Comments
