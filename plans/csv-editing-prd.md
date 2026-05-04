## Problem Statement

The CSV Viewer currently lets users open, inspect, sort, filter, and search CSV-style files, but it remains read-only. Users who find an issue while inspecting a file must leave the app, open another editor, make the change there, and then reopen the file to confirm the result. That breaks the inspection workflow and makes simple cleanup tasks slower than they need to be.

The user wants the viewer to support practical CSV editing without turning into a full spreadsheet. The feature should let users correct cell values, add missing rows, remove bad rows, undo mistakes, and save the result as a new CSV file while keeping the original file untouched.

## Solution

Add a focused edit mode to the existing desktop CSV Viewer. The app will treat CSV cell values as text, attach hidden internal row identifiers to source rows, track pending edits in memory, and expose explicit editing actions through the grid and toolbar. Users will be able to edit cells inline, insert empty rows above or below a single selected row, append an empty row when no row is selected, delete one or more selected rows, undo and redo editing operations, and save the edited dataset through Save As.

The original CSV file will never be overwritten by this version. Save As will write a new CSV that preserves the user's data intent and active CSV dialect, but it does not need to preserve byte-for-byte quote choices or whitespace from every edited row. The internal row identifier is strictly an implementation detail and must never be written as a visible CSV column.

The editing model must continue to work with sorting, filtering, and global search for cell edits and deletes. Row insertion will be disabled while a sort, filter, or search query is active, because inserting relative to a derived visible order is ambiguous.

## User Stories

1. As a CSV Viewer user, I want to edit a cell inline, so that I can correct a value without leaving the app.
2. As a CSV Viewer user, I want all edited values to be treated as text, so that the app does not reject valid CSV content based on inferred types.
3. As a CSV Viewer user, I want leading zeroes and text-like values to be preserved as user-entered text, so that identifiers are not accidentally normalized as numbers.
4. As a CSV Viewer user, I want to insert an empty row above the selected row, so that I can add missing data at the right source position.
5. As a CSV Viewer user, I want to insert an empty row below the selected row, so that I can add a follow-up row in the right source position.
6. As a CSV Viewer user, I want to append an empty row when no row is selected, so that I can add new data to the end of the file.
7. As a CSV Viewer user, I want inserted rows to start with empty strings for every column, so that I can fill in only the values I need.
8. As a CSV Viewer user, I want row insertion disabled while sort, filter, or search is active, so that I do not accidentally insert a row into an ambiguous derived position.
9. As a CSV Viewer user, I want row insertion disabled when multiple rows are selected, so that the app avoids unclear insertion behavior.
10. As a CSV Viewer user, I want to delete one selected row, so that I can remove bad or duplicate data.
11. As a CSV Viewer user, I want to delete multiple selected rows, so that I can remove a batch of bad data efficiently.
12. As a CSV Viewer user, I want deleted rows to disappear immediately from the grid, so that the visible dataset reflects my pending changes.
13. As a CSV Viewer user, I want deleted rows to remain recoverable through undo, so that accidental deletion is not destructive.
14. As a CSV Viewer user, I want delete to apply to the selected source rows only, so that filtering or searching does not accidentally delete more rows than I selected.
15. As a CSV Viewer user, I want to edit cells while sorted, filtered, or searched, so that I can correct values in the view where I found them.
16. As a CSV Viewer user, I want edits made in a filtered or searched view to apply to the underlying source row, so that changes are not tied to a temporary visual index.
17. As a CSV Viewer user, I want a row to move or disappear from a sorted, filtered, or searched view if my edit changes whether it belongs there, so that the grid remains consistent with the active query.
18. As a CSV Viewer user, I want undo to reverse the most recent cell edit, row insert, or row delete, so that I can recover from mistakes quickly.
19. As a CSV Viewer user, I want redo to reapply an undone cell edit, row insert, or row delete, so that I can move back through my edit history.
20. As a CSV Viewer user, I want the app to show that the current file has unsaved changes, so that I know Save As is needed before closing or opening another file.
21. As a CSV Viewer user, I want Save As to write my edited dataset to a new CSV file, so that I can preserve the original file.
22. As a CSV Viewer user, I want Save As to use the active delimiter and header settings, so that the new file matches the way I opened and edited the data.
23. As a CSV Viewer user, I want Save As to omit the internal row identifier, so that implementation details do not leak into my data.
24. As a CSV Viewer user, I want Save As to include inserted rows in the intended source order, so that the saved file reflects the grid operations I performed.
25. As a CSV Viewer user, I want Save As to exclude deleted rows, so that removed data does not reappear in the exported file.
26. As a CSV Viewer user, I want Save As to include edited cell values, so that the output contains my corrections.
27. As a CSV Viewer user, I want the original file to remain untouched, so that editing in the viewer is low-risk.
28. As a CSV Viewer user, I want the app to warn me before opening another file when I have unsaved changes, so that I do not lose pending edits.
29. As a CSV Viewer user, I want the app to warn me before reopening the current file when I have unsaved changes, so that I do not accidentally discard edits.
30. As a CSV Viewer user, I want the app to warn me before closing the app with unsaved changes, so that I can choose whether to save or discard.
31. As a CSV Viewer user, I want save and edit failures to be surfaced clearly, so that I understand whether my changes were applied or written.
32. As a CSV Viewer user, I want selection state to drive insert and delete actions predictably, so that toolbar controls match what can happen in the grid.
33. As a CSV Viewer user, I want editing controls to be disabled when they cannot safely run, so that the app prevents ambiguous operations.
34. As a CSV Viewer user, I want large files to remain inspectable while editing, so that adding edit support does not require loading the full dataset into React state.
35. As a CSV Viewer user, I want search, sort, and filter behavior to remain available after editing is added, so that the viewer remains useful for inspection.
36. As a maintainer, I want a stable internal row identity, so that edits target source rows rather than visible row indexes.
37. As a maintainer, I want edit operations represented as structured commands, so that undo, redo, dirty state, and saving are consistent.
38. As a maintainer, I want pending edits to be owned by the data layer rather than scattered through renderer state, so that query and save behavior share one source of truth.
39. As a maintainer, I want the IPC contract to expose explicit edit operations, so that the renderer remains a narrow client of the data service.
40. As a maintainer, I want Save As behavior to be testable without the UI, so that CSV output correctness can be validated with fixtures.
41. As a maintainer, I want query behavior with edits to be testable without AG Grid internals, so that the data model remains reliable as the UI evolves.
42. As a maintainer, I want insertion rules to be enforced below the UI as well as in the toolbar, so that invalid operations cannot slip through IPC.
43. As a maintainer, I want deleted rows to be excluded from row windows and counts, so that the grid reflects pending state consistently.
44. As a maintainer, I want inserted rows to participate in row windows when there is no active query, so that users can see the rows they add.
45. As a maintainer, I want type inference changes to be deliberate, so that edit support does not silently corrupt CSV text values.

## Implementation Decisions

- Editing will be introduced as a focused CSV editing feature, not as a full spreadsheet implementation.
- The application will continue to support one active CSV session at a time.
- CSV cell values will be treated as text for editing purposes.
- Numeric, date, and boolean validation will not block edits.
- Existing numeric and date-specific filter affordances may be simplified to text-first filtering as part of the editing architecture.
- Each source row will receive a hidden internal row identifier.
- The internal row identifier will be stable for the active session and regenerated when a file is reopened.
- The internal row identifier will never be displayed as a normal CSV column.
- The internal row identifier will never be written by Save As.
- Cell edits will target a session identifier, row identifier, column name, and new text value.
- Row deletes will target explicit row identifiers selected by the user.
- Row inserts will create empty text values for every visible CSV column.
- Row inserts will be supported above or below a single selected row.
- Appending an empty row will be supported when no row is selected.
- Row insertion will be disabled while sort, filter, or global search is active.
- Row insertion will be disabled when multiple rows are selected.
- Delete will support one or more selected rows.
- Deleted rows will disappear from the current grid immediately.
- Deleted rows and inserted rows will remain pending until Save As.
- Edit state will be tracked as an in-memory change journal for the active session.
- The change journal will support cell edit, row insert, and row delete operations.
- Undo and redo will operate over the same structured edit operations.
- Undo and redo will cover cell edits, row inserts, and row deletes.
- Dirty state will derive from the change journal.
- Opening another file, reopening the active file, or closing the app with dirty state will require an unsaved-change decision.
- The unsaved-change decision should support saving through Save As, discarding changes, or canceling the destructive action.
- Save As will write a new CSV file chosen by the user.
- Save As will never overwrite the original file implicitly.
- Save As will serialize the edited dataset according to the active CSV dialect.
- Save As does not need to preserve byte-for-byte quote style, whitespace, or row formatting for changed rows.
- Save As should preserve the user's data and source row order, including pending inserts and excluding pending deletes.
- Query row windows must exclude deleted rows.
- Query row windows must include edited values for edited source rows.
- Query row windows must include inserted rows when no active query makes insertion/query positioning ambiguous.
- Edits made under sort, filter, or search apply to the underlying source row rather than the visible row index.
- The renderer will call explicit edit IPC operations rather than mutating grid data as the source of truth.
- AG Grid will provide the inline editing surface and selection state.
- The grid toolbar will expose insert above, insert below, append row, delete rows, undo, redo, and Save As actions.
- Toolbar actions will reflect selection, query, dirty, undo, and redo state.
- The data service will remain responsible for file access, CSV parsing, row identity, edit state, query behavior, and save output.
- The renderer will continue to avoid materializing the full CSV dataset in React state.
- The edit architecture should prefer deep, testable data modules for row identity, edit journal behavior, query projection, and CSV writing.

## Testing Decisions

- Tests should focus on external behavior: given CSV input and edit operations, the data layer returns expected row windows, counts, dirty state, undo/redo behavior, and Save As output.
- Tests should not assert incidental SQL formatting or AG Grid implementation details.
- Data service tests should cover opening editable CSV sessions with text values and hidden row identifiers.
- Data service tests should cover cell edits by row identifier and column name.
- Data service tests should cover row insertion above a selected row, below a selected row, and append with no selection.
- Data service tests should cover rejected insertion when query state makes insertion invalid.
- Data service tests should cover single-row and multi-row deletion.
- Data service tests should cover deleted rows disappearing from row windows and counts.
- Data service tests should cover undo and redo for cell edits, row inserts, and row deletes.
- Data service tests should cover dirty state before and after edits, undo, redo, and Save As.
- Data service tests should cover edits under sorted, filtered, and searched row windows applying to the correct source row.
- Data service tests should cover Save As excluding deleted rows.
- Data service tests should cover Save As including inserted rows in the expected order.
- Data service tests should cover Save As including edited cell values.
- Data service tests should cover Save As omitting the internal row identifier.
- Data service tests should cover delimiter and header behavior in Save As.
- Renderer-facing data source tests should cover translating grid edit and selection actions into explicit API calls where practical.
- Renderer tests should focus on visible enabled and disabled toolbar states rather than AG Grid internals.
- Unsaved-change guard behavior should be tested at the app boundary with mocked user decisions where practical.
- Existing CSV data service tests and grid data source tests provide prior art for behavior-oriented coverage.
- Manual validation should include a normal CSV, a file with quoted delimiters, a file with leading zero identifiers, a filtered edit flow, a sorted edit flow, insertion with no query, deletion of multiple selected rows, undo/redo, and Save As.

## Out of Scope

- Saving over the original CSV file.
- Byte-for-byte preservation of original quote style and whitespace for edited rows.
- Column insertion, deletion, renaming, or reordering in saved output.
- Formula support.
- Typed validation for numeric, date, or boolean columns.
- Bulk delete of all filtered or searched results.
- Row insertion while sort, filter, or search is active.
- Multi-row relative insertion.
- Multi-file editing.
- Collaborative editing.
- Pivot tables, charts, or spreadsheet-style analysis features.
- Stable row identifiers that persist across Save As and reopen.
- Writing the internal row identifier to the saved CSV.

## Further Notes

The main architectural shift is from read-only inferred data to editable text data with stable row identity. That shift should be handled deliberately because it affects query behavior, filtering affordances, save output, and tests.

The highest-risk implementation area is maintaining correct row identity through sorting, filtering, search, insertion, deletion, and undo/redo. The second highest-risk area is Save As output correctness, especially around active dialect settings and ensuring internal metadata never leaks into the file.

This feature should preserve the existing performance principle: the renderer should not become the owner of the full CSV dataset. Editing state can be much smaller than the source file and should be represented as operations over source rows rather than as a full cloned dataset.
