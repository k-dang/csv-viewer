# Plan: CSV Editing

> Source PRD: `plans/csv-editing-prd.md`

## Architectural Decisions

Durable decisions that apply across all phases:

- **Application model**: One active editable CSV session at a time.
- **Data ownership**: The main-process data service owns file access, row identity, pending edits, query behavior, undo/redo state, dirty state, and Save As output.
- **Renderer boundary**: The renderer talks to editing behavior through typed IPC operations exposed by the preload bridge.
- **Grid surface**: AG Grid remains the primary row and cell interaction surface.
- **CSV values**: Cells are treated as text for editing. Numeric, date, and boolean validation does not block edits.
- **Row identity**: Source rows receive a hidden internal row identifier for the active session. It is regenerated on reopen and never written to CSV output.
- **Edit model**: Pending changes are represented as structured operations over row identifiers and column names.
- **Persistence model**: The original file is never overwritten in this feature. Save As writes a separate CSV chosen by the user.
- **Query model**: Sort, filter, search, offset, and limit remain structured requests. Edits and deletes apply to source rows, not visible row indexes.
- **Insertion rule**: Row insertion is disabled while sort, filter, or search is active, and disabled when multiple rows are selected.
- **Undo/redo model**: Cell edits, row inserts, and row deletes all participate in one undo/redo history.
- **Performance principle**: The renderer must not materialize the full CSV dataset in React state.

---

## Phase 1: Editable Text Sessions

**User stories**: 2, 3, 36, 38, 41, 45

### What to Build

Create the foundation for editable CSV sessions by loading row values as text and attaching hidden row identifiers to every source row. The app should still open files, report metadata, and serve bounded row windows, but rows now include stable internal identity for edit operations.

### Acceptance Criteria

- [ ] Opening a CSV creates an editable session with stable hidden row identifiers.
- [ ] Row identifiers are available to edit operations but are not displayed as normal CSV columns.
- [ ] Row identifiers remain stable across sorting, filtering, search, and pagination within the active session.
- [ ] Cell values are exposed as text values for editing purposes.
- [ ] Leading zeroes and text-like identifiers are preserved in row windows.
- [ ] Existing row-window loading remains bounded by offset and limit.
- [ ] Existing sort, filter, and search behavior is adjusted or simplified consistently with text-first values.
- [ ] Tests cover text-first loading, row identity stability, row-window retrieval, and hidden identifier behavior.

---

## Phase 2: Single Cell Edit Path

**User stories**: 1, 15, 16, 17, 31, 37, 39, 43

### What to Build

Add the first complete edit path: a user edits one cell inline, the renderer sends a structured edit operation, the data service records the pending change, and subsequent row windows show the edited value. Edits must target the underlying source row even when the current view is sorted, filtered, or searched.

### Acceptance Criteria

- [ ] A user can edit a cell inline in the grid.
- [ ] The edit operation targets session identifier, row identifier, column name, and new text value.
- [ ] Subsequent row windows return the edited value for that row and column.
- [ ] Editing a cell marks the session dirty.
- [ ] Editing a cell while sorted applies to the source row rather than the visible row index.
- [ ] Editing a cell while filtered or searched applies to the source row rather than the visible row index.
- [ ] If an edit changes whether a row matches the active query, refreshing the grid reflects the new query result.
- [ ] Edit failures are surfaced to the user.
- [ ] Tests cover basic cell editing, dirty state after edit, and editing under sorted, filtered, and searched views.

---

## Phase 3: Undo/Redo and Dirty State

**User stories**: 18, 19, 20, 37, 38

### What to Build

Make cell edits reversible through a structured edit journal. The UI should expose dirty, undo, and redo state, and the data service should provide a reliable source of truth for whether there are pending changes.

### Acceptance Criteria

- [ ] Undo reverses the most recent cell edit.
- [ ] Redo reapplies an undone cell edit.
- [ ] New edits clear the redo stack.
- [ ] Dirty state is exposed through the editing API.
- [ ] Dirty state updates after edit, undo, and redo.
- [ ] The UI shows that the session has unsaved changes.
- [ ] Undo and redo controls are enabled only when the operation is available.
- [ ] Tests cover undo, redo, redo clearing, and dirty state transitions.

---

## Phase 4: Delete Selected Rows

**User stories**: 10, 11, 12, 13, 14, 31, 32, 33, 43

### What to Build

Add row deletion for one or more selected rows. Deletion should target explicit row identifiers, hide deleted rows immediately from row windows, update counts, and participate in undo/redo.

### Acceptance Criteria

- [ ] A user can delete one selected row.
- [ ] A user can delete multiple selected rows.
- [ ] Delete targets selected source row identifiers.
- [ ] Deleted rows disappear immediately from the grid.
- [ ] Deleted rows are excluded from row windows.
- [ ] Deleted rows are excluded from visible row counts.
- [ ] Delete marks the session dirty.
- [ ] Undo restores deleted rows.
- [ ] Redo deletes restored rows again.
- [ ] Delete controls are disabled when no rows are selected.
- [ ] Delete failures are surfaced to the user.
- [ ] Tests cover single delete, multi-delete, count updates, query behavior after delete, undo, and redo.

---

## Phase 5: Insert and Append Rows

**User stories**: 4, 5, 6, 7, 8, 9, 24, 32, 33, 42, 44

### What to Build

Add row insertion and append behavior. Users can insert an empty row above or below one selected source row, or append an empty row when no row is selected. Insertion must be blocked while sort, filter, or search is active, and blocked when multiple rows are selected.

### Acceptance Criteria

- [ ] A user can insert an empty row above a single selected row.
- [ ] A user can insert an empty row below a single selected row.
- [ ] A user can append an empty row when no row is selected.
- [ ] Inserted rows contain empty strings for every CSV column.
- [ ] Inserted rows receive internal row identifiers.
- [ ] Inserted rows appear in row windows in the intended source order when no query is active.
- [ ] Insert marks the session dirty.
- [ ] Undo removes an inserted row.
- [ ] Redo restores an inserted row.
- [ ] Insert above and insert below are disabled when no row or multiple rows are selected.
- [ ] Append is disabled while sort, filter, or search is active.
- [ ] All insert actions are disabled while sort, filter, or search is active.
- [ ] Invalid insert requests are rejected below the UI boundary.
- [ ] Tests cover insert above, insert below, append, disabled/rejected query insertion, multi-select insertion rejection, undo, redo, and row ordering.

---

## Phase 6: Save As and Unsaved-Change Guards

**User stories**: 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 40

### What to Build

Add Save As and connect it to unsaved-change decisions. A user can write the edited dataset to a new CSV file without overwriting the original, and attempts to open, reopen, or close with unsaved changes prompt the user to save, discard, or cancel.

### Acceptance Criteria

- [ ] A user can choose Save As from the UI.
- [ ] Save As writes a new CSV file chosen by the user.
- [ ] Save As never overwrites the original file implicitly.
- [ ] Save As includes edited cell values.
- [ ] Save As includes inserted rows in source order.
- [ ] Save As excludes deleted rows.
- [ ] Save As omits internal row identifiers.
- [ ] Save As uses the active delimiter and header settings.
- [ ] Save As reports write failures clearly.
- [ ] Successful Save As clears dirty state for the active session.
- [ ] Opening another file with unsaved changes prompts for Save As, Discard, or Cancel.
- [ ] Reopening the active file with unsaved changes prompts for Save As, Discard, or Cancel.
- [ ] Closing the app with unsaved changes prompts for Save As, Discard, or Cancel.
- [ ] Cancel leaves the current session and edit state untouched.
- [ ] Discard allows the requested open, reopen, or close operation to continue without saving.
- [ ] Save As allows the requested open, reopen, or close operation to continue only after a successful write.
- [ ] Tests cover Save As output for edits, inserts, deletes, delimiter/header settings, omitted row identifiers, dirty-state clearing, and guarded open/reopen flows.
- [ ] Manual validation covers close-window behavior with unsaved changes.

---

## Phase 7: Editing UX and Validation Pass

**User stories**: 34, 35

### What to Build

Finish the editing experience by tightening toolbar states, query refresh behavior, error messages, performance validation, and manual test coverage. The final feature should feel integrated with the existing viewer instead of bolted onto the grid.

### Acceptance Criteria

- [ ] Toolbar controls reflect selection, active query, dirty state, undo availability, and redo availability.
- [ ] The edited grid remains usable while sorting, filtering, and searching.
- [ ] Active queries refresh predictably after edits and deletes.
- [ ] The renderer still does not store the full CSV dataset in React state.
- [ ] Large-file validation confirms bounded row-window behavior after editing is added.
- [ ] Manual validation covers a normal CSV, quoted delimiters, leading zero identifiers, filtered edits, sorted edits, insertion with no active query, multi-row delete, undo/redo, Save As, and unsaved-change guards.
- [ ] User-facing copy for edit, save, and guard failures is clear and specific.
- [ ] Documentation or known limitations mention Save As only, no typed validation, no structural column edits, and no insertion under active query.
