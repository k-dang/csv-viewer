# Export current view

Export current view extracts all matching rows in current sort order, with every working-copy column. The original Export CSV action still exports the complete working copy. View export preserves Unexported Changes and undo/redo history.

## Sub-features

- `view-export`: matching rows, current sort, working-copy columns, and `-view` filename.
- `view-count`: resolved matching count and explanation for empty or unresolved queries.
- `view-editor`: active editor commits before export; rejected commits keep the draft open.
- `view-cancel`: cancel preparation while the workspace remains usable.
- `view-history`: view export retains dirty state and edit history.

## How to get to it (user POV)

Open a CSV, optionally search/filter/sort, then open Export options beside Export and choose Export current view. Cancel appears while Preparing export… is visible.

## Driving it with control-csv-viewer

Preconditions: launch the desired runtime and open `fixtures/phase-2-sample.csv` using [Open a CSV](./open-csv.md). Desktop delivery requires a human destination choice; web downloads into the launcher's session download directory.

- **Draft.** Run `click --role gridcell --name "Ada Lovelace" --double`, then `fill --focused --value "Ada Lovelace Edited"`. Leave the editor open.
- **Search.** Run `fill --role searchbox --name "Global search" --value "Ada"`. Wait for `1 visible of 5 rows`. Opening Export options commits any remaining active editor.
- **Scope.** Run `click --role button --name "Export options"`. Wait for `Export current view · 1 rows`. The trigger also opens with Enter for keyboard access.
- **Deliver.** Run `click --role menuitem --name "Export current view · 1 rows"`. On web, wait for `Download started · 1 rows`, read the newest `phase-2-sample-view.csv`, and confirm one data row containing the edited name and every column. On desktop, choose a separate destination and wait for `Export complete · 1 rows`. Re-read the source fixture to prove it remains unchanged.
- **History.** Confirm Unexported Changes remains visible after delivery. Run `click --role button --name "Undo edit"`; the original name returns. Redo remains available.
- **Empty.** Search for `no-matching-value`, wait for `0 visible of 5 rows`, and open Export options. `click --role menuitem --name "Export current view · 0 rows"` reports `"disabled": true`. The caption under that item reads `No matching rows to export`. The caption is not the menu item's name.
- **Cancel.** With a sufficiently large matching fixture, start view export and wait for Preparing export…. Run `click --role button --name "Cancel export"`. Export CSV enables again and no destination/download begins. If preparation finishes before the click, report cancellation as unproven; the controlled cancellation E2E test supplies deterministic coverage.

## Web differences

Web confirms download initiation rather than disk completion. Read downloaded bytes for proof; copy evidence before launcher cleanup. Once download handoff starts, cancellation belongs to the browser. Desktop's prepared output uses its native save dialog.

## Gotchas

- Selection and the visible window do not change which rows are exported. A dragged header order does change column order in the file. Use a fixture larger than the grid cache to prove complete matching membership.
- View export never clears Unexported Changes, even without a query. Undo edits back to clean before closing a dirty web tab through the helper, or finish with complete Export CSV.
- An unresolved query disables the view menu item. Wait for the current count before choosing it.
- Closing or reopening cancels preparation; a desktop dialog already holding prepared output can finish using its captured contents.
