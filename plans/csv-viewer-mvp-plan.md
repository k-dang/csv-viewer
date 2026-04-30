# Plan: CSV Viewer MVP

> Source PRD: `plans/csv-viewer-mvp-prd.md`

## Architectural Decisions

Durable decisions that apply across all phases:

- **Application shell**: Electron desktop app with Vite, React, and TypeScript.
- **Package manager**: pnpm.
- **Renderer UI**: React app with AG Grid Community as the main tabular data surface.
- **Data engine**: DuckDB handles CSV reading, schema inference, row counting, sorting, filtering, search, and paginated row retrieval.
- **Process boundary**: DuckDB and local file access live outside the renderer, initially through the Electron main process unless a dedicated worker process becomes necessary.
- **IPC contract**: Renderer talks to the data layer through typed, structured IPC calls.
- **Active document model**: MVP supports one active CSV session at a time.
- **CSV session model**: Opening a file creates a session with file metadata, inferred schema, row count, dialect options, and queryable row windows.
- **Query model**: The renderer sends structured sort, filter, search, offset, and limit options. It never sends raw SQL.
- **Security model**: The renderer receives a narrow preload API. Node integration stays unavailable in the renderer.
- **Performance principle**: The renderer must not hold the full CSV dataset in React state.
- **Read-only scope**: MVP is strictly a viewer. It does not edit or save CSV files.

---

## Phase 1: Desktop App Skeleton

**User stories**: 30, 34, 35, 39, 40

### What to Build

Create the Electron, Vite, React, and TypeScript foundation with a secure preload bridge and a basic desktop window. The app should launch reliably, show an empty state, and prove that renderer-to-main IPC works through a typed API.

### Acceptance Criteria

- [ ] The app launches as an Electron desktop window from a pnpm script.
- [ ] The renderer is a Vite React TypeScript app.
- [ ] The renderer has no direct Node file-system access.
- [ ] A preload bridge exposes a narrow typed API to the renderer.
- [ ] A basic health-check IPC call succeeds from the renderer.
- [ ] The UI shows a polished empty state when no CSV is open.
- [ ] Typecheck runs successfully.

---

## Phase 2: Open a CSV and Return Metadata

**User stories**: 1, 3, 4, 18, 25, 26, 28, 29, 33, 35, 37, 38

### What to Build

Implement the first complete file-open path. A user can choose a local CSV, the main process opens it through DuckDB, creates a CSV session, infers schema, counts rows, and returns file metadata to the renderer. Errors are surfaced clearly without crashing the app.

### Acceptance Criteria

- [ ] The user can trigger a native file picker for CSV files.
- [ ] Selecting a CSV creates one active read-only CSV session.
- [ ] Opening a second CSV replaces the previous active session and releases previous resources.
- [ ] The app displays current file name, file size, inferred columns, and total row count.
- [ ] Common CSV files open with automatic delimiter and header inference.
- [ ] Quoted fields and escaped delimiters are handled correctly by DuckDB.
- [ ] Malformed or unreadable files show a user-visible error state.
- [ ] The source CSV is never modified.
- [ ] Data service tests cover open, metadata, row count, session replacement, and error cases.

---

## Phase 3: Render the First Row Window

**User stories**: 2, 5, 6, 7, 8, 20, 21, 22, 23, 24, 34, 38, 39

### What to Build

Connect AG Grid to the CSV session using row-window requests. The renderer asks for only the rows needed for the visible grid area, displays them in a virtualized table, and supports basic table ergonomics such as resizing, reordering, sticky headers, selection, and copy.

### Acceptance Criteria

- [ ] The grid displays rows from an opened CSV.
- [ ] Row data is loaded through offset and limit requests.
- [ ] The renderer does not store the full CSV dataset.
- [ ] Vertical scrolling remains responsive on a large generated fixture.
- [ ] Wide CSVs can be inspected with horizontal scrolling.
- [ ] Column headers remain visible while scrolling.
- [ ] Columns can be resized.
- [ ] Columns can be reordered.
- [ ] Basic cell selection and copy behavior works.
- [ ] Empty, null-like, and missing values have distinguishable display behavior.
- [ ] Tests cover row-window retrieval and renderer request behavior.

---

## Phase 4: Sort and Filter Through DuckDB

**User stories**: 9, 10, 11, 12, 13, 14, 15, 19, 35, 36, 38

### What to Build

Add structured sort and filter state to the grid. User interactions update a typed query state, the renderer requests a new row window, and DuckDB performs the actual sort/filter work. The app displays the filtered row count and allows the user to clear sorting and filters.

### Acceptance Criteria

- [ ] A user can sort by a column and see sorted rows.
- [ ] A user can clear sorting and return to the original file order.
- [ ] A user can apply text filters to columns.
- [ ] A user can apply numeric comparison filters to numeric columns.
- [ ] Date-like filtering is supported where DuckDB inference makes it practical.
- [ ] Multiple filters can be combined.
- [ ] All filters can be cleared with one action.
- [ ] The app displays total row count and filtered row count.
- [ ] Sort and filter requests use structured descriptors, not raw SQL from the renderer.
- [ ] Query construction safely handles unusual column names and user-provided filter values.
- [ ] Tests cover sort, clear sort, text filter, numeric filter, combined filters, row counts, and identifier escaping.

---

## Phase 5: Global Search

**User stories**: 16, 17, 19, 32, 35, 36, 38

### What to Build

Add a global text search that searches across visible/searchable columns through DuckDB and displays matching rows in the same grid. Search should integrate with the same row-window and count model as sorting and filtering.

### Acceptance Criteria

- [ ] A user can enter a global search query.
- [ ] Matching rows are displayed in the main grid.
- [ ] Search can be cleared to return to the previous unsearched dataset view.
- [ ] Search results expose a matching row count.
- [ ] Search composes predictably with active filters.
- [ ] Long-running search requests can be superseded by newer requests so stale results do not overwrite current results.
- [ ] Search values are parameterized rather than interpolated into raw SQL.
- [ ] Tests cover basic search, no-result search, search with filters, clearing search, and stale request handling.

---

## Phase 6: CSV Dialect Controls and Robust Errors

**User stories**: 25, 26, 27, 28, 30, 32, 33, 37, 38

### What to Build

Add practical controls for non-standard CSV files and improve failure handling. Users can override delimiter and header assumptions, reopen the file with those options, and understand parse or file-access failures.

### Acceptance Criteria

- [ ] The open flow defaults to automatic CSV inference.
- [ ] A user can override delimiter before or after opening a file.
- [ ] A user can override whether the first row is treated as headers.
- [ ] Reopening with dialect options refreshes schema, row count, and grid data.
- [ ] Invalid dialect choices show clear validation feedback.
- [ ] Parse, permissions, missing file, and unsupported file errors have distinct user-facing messages where possible.
- [ ] In-flight open or query operations can be safely replaced by newer operations.
- [ ] Tests cover delimiter override, header override, reopen behavior, and major error categories.

---

## Phase 7: Performance Validation and UX Polish

**User stories**: 2, 3, 6, 7, 8, 18, 20, 21, 22, 23, 24, 30, 34, 38, 39

### What to Build

Harden the MVP by validating large-file behavior, tightening loading states, and polishing the core inspection interface. This phase should make the viewer credible as a performance-focused desktop tool.

### Acceptance Criteria

- [ ] Generated large-row-count fixture validates that opening and scrolling do not materialize the full dataset in the renderer.
- [ ] Generated wide-column fixture validates horizontal inspection and column virtualization behavior.
- [ ] Loading, querying, empty, and error states are visually clear.
- [ ] The app remains responsive while a large file is open.
- [ ] The main interface fits desktop window sizes without overlapping controls.
- [ ] File metadata and row counts stay visible without crowding the grid.
- [ ] Manual validation covers large, wide, quoted-field, malformed, and unusual-column-name CSVs.
- [ ] Performance test or script documents the expected large-file validation path.

---

## Phase 8: MVP Packaging Readiness

**User stories**: 29, 30, 31, 33, 34, 40

### What to Build

Prepare the app for local desktop use beyond the development server. Add basic recent-file support if the core architecture is stable, document how to run and validate the app, and configure packaging enough to produce a local build artifact.

### Acceptance Criteria

- [ ] The project has clear scripts for development, typecheck, tests, and local packaging.
- [ ] The app can be packaged into a local desktop build.
- [ ] Runtime behavior is consistent between development and packaged builds.
- [ ] Recent files are available if they can be added without compromising the core data path.
- [ ] Documentation explains how to run the app and validate MVP scenarios.
- [ ] Known limitations are documented, including read-only scope and unsupported advanced features.

