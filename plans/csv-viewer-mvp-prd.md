## Problem Statement

CSV files are often too large, wide, or irregular to inspect comfortably in spreadsheet applications or text editors. Opening a large CSV can freeze the UI, consume excessive memory, or force users to import the file into a database before they can answer simple questions.

The user wants a performant desktop CSV viewer that can open local CSV files, display them quickly, and support common inspection workflows such as scrolling, sorting, filtering, searching, and reviewing column shape without loading the entire dataset into the renderer.

## Solution

Build an Electron desktop application using React, TypeScript, AG Grid Community, and DuckDB. The application will open local CSV files, register them with DuckDB from the Electron main process, and expose a small IPC API that lets the renderer request only the row windows and metadata needed for the current grid view.

The MVP should prove the core architecture:

- The app can open a local CSV from disk.
- The main process handles file access, DuckDB registration, schema inference, counting, sorting, filtering, and paginated row retrieval.
- The renderer stays responsive by rendering virtualized rows and columns through AG Grid.
- The app avoids storing the full CSV as JavaScript objects in React state.
- The UI feels like a practical data inspection tool rather than a spreadsheet clone.

## User Stories

1. As a data analyst, I want to open a local CSV file, so that I can inspect data without importing it into another system.
2. As a developer, I want the app to remain responsive while opening large CSV files, so that I can inspect logs and exports without waiting for a full in-memory load.
3. As a user, I want to see file loading progress or status, so that I know whether the app is working on a large file.
4. As a user, I want to see the inferred columns, so that I can quickly understand the shape of the file.
5. As a user, I want to see rows in a grid, so that I can scan CSV data in a familiar tabular format.
6. As a user, I want smooth vertical scrolling, so that I can navigate large files without UI freezes.
7. As a user, I want horizontal scrolling and column virtualization, so that I can inspect wide CSVs.
8. As a user, I want the grid to request only visible row ranges, so that memory usage stays controlled.
9. As a user, I want to sort by a column, so that I can identify high, low, recent, or unusual values.
10. As a user, I want to clear sorting, so that I can return to the original file order.
11. As a user, I want to filter a column by text, so that I can isolate matching records.
12. As a user, I want to filter numeric columns by comparisons, so that I can inspect ranges of values.
13. As a user, I want to filter date-like columns when possible, so that I can narrow data by time periods.
14. As a user, I want to combine multiple filters, so that I can answer more specific inspection questions.
15. As a user, I want to clear all filters, so that I can return to the full dataset.
16. As a user, I want a global text search, so that I can find rows containing a value without choosing a column first.
17. As a user, I want search results to be displayed in the same grid, so that I can inspect matching rows without switching tools.
18. As a user, I want to know the total row count, so that I understand the size of the dataset.
19. As a user, I want to know the visible filtered row count, so that I understand how much data matches my filters.
20. As a user, I want columns to be resizable, so that long values are readable.
21. As a user, I want columns to be reorderable, so that I can place relevant fields next to each other.
22. As a user, I want sticky column headers, so that I can keep context while scrolling.
23. As a user, I want basic cell selection and copy support, so that I can move a value or row subset into another tool.
24. As a user, I want null, empty, and missing values to be visually distinguishable enough to inspect data quality.
25. As a user, I want parse errors to be surfaced clearly, so that I can understand malformed CSV input.
26. As a user, I want delimiter and header inference to work for common CSV files, so that opening normal files requires no configuration.
27. As a user, I want an option to override delimiter or header assumptions, so that I can open non-standard CSV-like files.
28. As a user, I want the app to handle quoted fields and escaped delimiters correctly, so that valid CSV data is not corrupted.
29. As a user, I want the app to preserve the original file, so that viewing data cannot accidentally modify source files.
30. As a user, I want clear empty and error states, so that I know what to do when no file is open or a file cannot be parsed.
31. As a user, I want recent files to be available, so that I can reopen common datasets quickly.
32. As a user, I want long-running operations to be cancelable where practical, so that I can recover from expensive queries.
33. As a user, I want the app to show useful metadata such as file name and size, so that I know what is currently open.
34. As a user, I want the app to avoid blocking the renderer thread, so that menus, scrolling, and controls remain responsive.
35. As a maintainer, I want a small IPC contract between renderer and main process, so that data access behavior is testable and replaceable.
36. As a maintainer, I want query construction to be centralized, so that sorting, filtering, search, and pagination are implemented consistently.
37. As a maintainer, I want CSV session lifecycle management, so that opening a new file releases resources from the previous file.
38. As a maintainer, I want behavior-oriented tests around data access, so that future UI changes do not break core file viewing behavior.
39. As a maintainer, I want grid behavior separated from DuckDB details, so that the UI can evolve without duplicating query logic.
40. As a maintainer, I want a clear path to future features, so that editing, exporting, profiling, and saved views can be added later without replacing the MVP architecture.

## Implementation Decisions

- The application will be built with Electron, Vite, React, and TypeScript.
- Package management will use pnpm, matching the existing repository metadata.
- AG Grid Community will provide the primary data grid experience.
- DuckDB will provide CSV reading, schema inference, row counting, sorting, filtering, search, and paginated data retrieval.
- DuckDB should run outside the renderer process, preferably in the Electron main process or a dedicated worker process managed by the main process.
- The renderer will communicate with the data layer through a typed IPC API.
- The renderer will not load the full CSV into React state.
- The main process will own local file access and CSV session lifecycle.
- Opening a CSV creates a session with a stable session identifier.
- Only one active CSV session is required for the MVP.
- The data access API will expose operations for opening a file, closing a session, reading schema, reading row count, reading row windows, applying sort and filter state, and searching.
- Row windows will be requested with offset and limit parameters.
- Sort state will support one or more column sort descriptors, though the UI may initially expose single-column sorting if that keeps the first implementation simpler.
- Filter state will be represented as structured filter descriptors instead of raw SQL fragments.
- Query construction will happen in one module that translates typed sort, filter, search, and pagination inputs into DuckDB queries.
- The query layer must escape identifiers and parameterize values to avoid malformed queries and injection-style bugs from unusual column names or filter values.
- CSV dialect options will include at minimum header presence and delimiter override.
- The initial open flow will use automatic inference by default.
- The UI will include a file open action, current file metadata, loading and error states, the grid, row count display, and controls for search and clearing filters.
- Recent files are desirable for the MVP if they do not distract from the core data path; otherwise they can be deferred.
- The application will be read-only in the MVP.
- The app will prioritize correctness and responsiveness over spreadsheet-like editing features.

## Testing Decisions

- Tests should focus on external behavior: given CSV input and query options, the data access layer returns the expected schema, counts, and row windows.
- Tests should not assert internal SQL string formatting except where escaping and parameter binding behavior is the behavior under test.
- The CSV session/data service should have focused tests for opening files, closing sessions, schema inference, row counting, pagination, sorting, filtering, and search.
- The query builder should have focused tests for safe identifier handling, filter translation, sort translation, and pagination parameters.
- IPC handlers should be tested at the boundary by verifying request validation and delegation to the data service.
- Renderer tests should focus on user-visible behavior such as empty state, loading state, error state, and grid request behavior, rather than AG Grid internals.
- Large-file performance should be validated with generated fixture CSVs that are large enough to catch full-load regressions.
- Performance acceptance should include checks that opening and scrolling a large file does not require materializing the full dataset in renderer state.
- Manual validation should include at least one large row-count CSV, one wide CSV, one quoted-field CSV, one malformed CSV, and one CSV with unusual column names.

## Out of Scope

- Editing CSV cell values.
- Saving changes back to the original CSV.
- Exporting filtered results.
- Multi-file joins or comparisons.
- Charting and visualization.
- Full SQL editor.
- Authentication, cloud storage, or remote database connections.
- Multi-window collaboration.
- Plugin architecture.
- Advanced type management beyond what DuckDB can infer for the MVP.
- Spreadsheet formula support.
- Pivot tables.

## Further Notes

The MVP should validate the fundamental bet: a desktop CSV viewer can feel fast by treating the CSV as a queryable local dataset and rendering only the data needed by the visible grid. DuckDB and AG Grid are intentionally chosen because they let the implementation focus on product behavior instead of rebuilding a database engine or grid engine.

The most important engineering risk is accidentally bypassing this architecture and moving too much data into the renderer. Implementation should preserve a hard boundary between the grid view and the data service.

The second major risk is query correctness around CSV files with unusual column names, null-like values, quoted fields, and mixed data types. The first implementation should include test fixtures that exercise those cases early.
