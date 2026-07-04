Status: ready-for-agent

## What to build

Build the first end-to-end Stats Panel slice for unscoped Column Value Counts. A user can open a right-side Stats Panel from the grid, choose a Stats Column, and see read-only Top Counted Values for the full Working CSV with count and Scope Percentage.

This slice establishes the shared stats request/response contract, the main-process Column Value Counts behavior, the renderer API call, and the visible panel. Count Scope integration can be added later; for this slice, counts may use the full Working CSV with no active grid filters or global search applied.

## Acceptance criteria

- [ ] The grid has a clear control for opening and closing the Stats Panel.
- [ ] The Stats Panel appears beside the row grid without replacing it.
- [ ] The Stats Panel includes a Stats Column selector populated from the opened CSV columns.
- [ ] The initial Stats Column defaults to the first CSV column for this slice.
- [ ] The panel requests Column Value Counts through the renderer API and displays the response.
- [ ] Each displayed Top Counted Value includes the Counted Value, count, and Scope Percentage.
- [ ] The response includes the Count Scope row total, and the panel displays that total.
- [ ] Results are limited to at most 50 Top Counted Values.
- [ ] Results are ordered by count descending, then Counted Value ascending for ties.
- [ ] Counted Values are exact and case-sensitive.
- [ ] Empty strings and null cells are separate Counted Values.
- [ ] The panel is read-only; clicking a Counted Value does not change grid filters.
- [ ] The panel has loading and failed states for the stats request.
- [ ] The panel follows the existing light and dark visual language.
- [ ] Data service tests cover unscoped counts, Scope Percentage, top-50 limiting, deterministic ordering, case sensitivity, and blank/null separation.
- [ ] Renderer tests cover opening the panel, selecting a Stats Column, and displaying loading, ready, and failed states.

## Blocked by

None - can start immediately

## Comments
