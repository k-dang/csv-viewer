Status: ready-for-agent

## What to build

Make Stats Panel opening contextual by defaulting the Stats Column from the currently focused grid column when one is available. When no grid column is focused, keep the first-column fallback. Reset stale stats state when a different CSV session opens, and keep the grid usable for wide CSVs while the panel is open.

This slice improves the first-open behavior and session lifecycle without changing the read-only Column Value Counts contract.

## Acceptance criteria

- [ ] The grid tracks the currently focused column when a user focuses or interacts with cells.
- [ ] When the Stats Panel opens with a focused grid column, that column becomes the initial Stats Column.
- [ ] When the Stats Panel opens with no focused grid column, the first CSV column remains the fallback Stats Column.
- [ ] The user can still change the Stats Column after the panel opens.
- [ ] Opening a different CSV session resets stale Stats Panel data from the previous session.
- [ ] The Stats Panel does not make wide CSVs unusable; the grid and panel have stable responsive layout constraints.
- [ ] Renderer tests cover focused-column defaulting, first-column fallback, manual Stats Column changes, and session reset behavior.

## Blocked by

- .scratch/column-value-counts/issues/01-render-unscoped-column-value-counts.md

## Comments
