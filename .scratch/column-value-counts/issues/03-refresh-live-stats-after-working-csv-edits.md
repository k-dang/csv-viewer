Status: ready-for-agent

## What to build

Make Column Value Counts fully reflect the Working CSV. When the user edits cells, inserts rows, deletes rows, undoes, or redoes, the Stats Panel should refresh and show counts calculated from the current in-memory data rather than the original file on disk.

This slice completes Live Stats behavior for changes to the Working CSV while preserving Count Scope behavior from filters and global search.

## Acceptance criteria

- [ ] Cell edits update Column Value Counts when the edited column is the Stats Column.
- [ ] Cell edits update Column Value Counts when the edited value changes whether a row belongs to the current Count Scope.
- [ ] Inserted rows are included in Column Value Counts.
- [ ] Deleted rows are excluded from Column Value Counts.
- [ ] Undo updates Column Value Counts to match the reverted Working CSV.
- [ ] Redo updates Column Value Counts to match the reapplied Working CSV.
- [ ] The Stats Panel refreshes after edit, insert, delete, undo, and redo operations.
- [ ] Refresh behavior still respects active filters and global search.
- [ ] Data service tests cover counts after edits, inserts, deletes, undo, and redo.
- [ ] Renderer tests cover Live Stats refresh triggers after Working CSV changes.

## Blocked by

- .scratch/column-value-counts/issues/01-render-unscoped-column-value-counts.md
- .scratch/column-value-counts/issues/02-apply-count-scope-from-grid-query.md

## Comments
