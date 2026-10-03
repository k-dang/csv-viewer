# CSV Viewer

A local desktop and web app for opening, inspecting, filtering, and cleaning CSV files without uploading them anywhere.

**[Try it in your browser](https://csv-viewer.vercel.app)** - no install, no upload.

<p align="center">
  <img src="images/app.png" alt="CSV Viewer with multiple file tabs, a focused status column, and live column value counts" width="900">
</p>

## Features

- Browse large CSV files, sort and filter rows, and search across columns.
- Adjust delimiter and header settings when a file does not open as expected.
- Edit cells, rename, insert, or delete columns, add or delete rows, and undo or redo changes.
- Keep several files open in tabs, each with its own edits and filters.
- Compare two files by a key and inspect changed cells and rows found only on one side.
- View the most frequent values in a column, based on the current search and filters.
- Copy a cell or an entire column, respecting the current sort, filters, and search.
- Export your changes to a separate file. Original files are never overwritten.
- Choose light or dark mode, four color palettes, and a collapsible workspace sidebar.

All CSV processing stays on your device.

## Open and edit files

Drop CSV, TSV, or TXT files into the app, or choose **Open CSV**. You can drop several files at once; existing tabs and edits stay intact.

Use **Parse options** beside **Open CSV** to override the delimiter or choose automatic headers, the first row as headers, or no headers. These settings apply to the next open or **Reopen**. Reopening reloads the source into the same tab and resets its query, selection, stats, and edit history; unexported changes require confirmation before they are discarded.

Double-click a cell to edit it. Values are treated as text, so identifiers such as leading-zero codes are preserved. Edits affect the working copy, and the tab shows **Unexported Changes** until those changes are exported.

- Select one row to insert an empty row above or below it, even while sorting, filtering, or searching. The inserted row may be hidden by the current query.
- With no rows selected and no active query, append an empty row. Select one or more rows to delete them.
- Right-click a column header to rename it, insert an empty column on either side, or delete it. Names must be nonblank, unique, and not reserved; the final column cannot be deleted.
- Use **Undo edit** and **Redo edit** for cell, row, and column changes. Undoing a deleted column restores its values and position.

Choose **Export CSV** to save the complete working copy, including all row and column edits, using its delimiter and header settings. Search, filters, and sort order do not restrict the export. Desktop prompts for a separate destination and prevents overwriting that CSV's source file; web starts a browser download. Closing a tab with unexported changes asks for confirmation.

## Search, copy, and stats

Search across all columns with **Global search**, or use column headers to sort and filter. **Clear query** resets search, filters, and sorting. Each CSV tab keeps its own query, column focus, and edits.

Copy the focused cell with `Ctrl+C`, or right-click a column header and choose **Copy column** to copy all values matching the current query in the current sort order. Column values are copied one per line, without a header; nulls become empty lines. A notification confirms the copied count and column.

Open the stats panel to see **Column Value Counts** for the focused column, or choose another **Stats Column**. Counts and percentages follow the active search and filters and refresh after edits. Blank and null values are shown separately.

## Compare files

Open two files with the same set of column names, choose **Compare**, and select a key. Column order can differ. A key can contain one or more columns; its combined value must be present and unique in every row of both files. Invalid keys show blank-value and duplicate diagnostics.

Comparison uses the complete working copies, including unexported changes, regardless of either tab's search or filters. It shows changed cells, unchanged rows, and rows found only on the baseline or candidate side. You can show all rows or only differences, swap the two sides, and cancel a running comparison. Editing or reopening either file marks the result as outdated until you refresh it. Closing a source tab also closes its dependent comparisons, with confirmation when needed.

<p align="center">
  <img src="images/comparison.png" alt="CSV comparison keyed by id, highlighting changed values and rows found only in the baseline or candidate" width="900">
</p>

## Workspace and shortcuts

The sidebar keeps CSV and comparison tabs together and can collapse to an icon rail. **Colors** offers Studio, Ledger, Terminal, and Aurora palettes independently of light or dark mode. Theme and sidebar preferences are saved locally when storage is available.

Choose **Keyboard shortcuts** in the sidebar or press `Ctrl+/` to open the shortcut panel. Use `Cmd` instead of `Ctrl` on macOS.

| Shortcut | Action |
| --- | --- |
| `F2` on a column header | Rename the focused column. |
| `F2` on a cell | Edit the focused cell. |
| `Ctrl+C` on a cell | Copy the focused cell. |
| `Ctrl+Shift+A` | Copy the focused column, when focus is outside a text field. |
| `Ctrl+/` | Show or hide the shortcut panel. |

The desktop **File** menu also provides `Ctrl+O` to open, `Ctrl+R` to reopen, `Ctrl+Shift+E` to export, and `Ctrl+W` to close the active tab.

## Desktop and web

Both versions support editing, comparison, and export, with all CSV processing on your device.

| Behavior | Desktop | Web |
| --- | --- | --- |
| File access | Native file dialogs and file drops. | Browser file picker and file drops. |
| Recent files | Remembers recent sources across restarts; removes missing files when the list reloads. | Files remain available only in the current page session. |
| Opening the same file again | Focuses its existing tab and preserves edits. | Opens another independent tab. |
| Export | Saves to a separate destination through a native dialog. | Downloads the working copy. |
| Source size limits | Suitable for files beyond the web limits, subject to available resources. | Up to 100 MB per file and 200 MB of open source files in total, measured in original file bytes. |

The web app checks browser support before opening the workspace. Unsupported browsers receive a message pointing to desktop. Reloading or navigating away loses the page's files and edits; the browser asks for confirmation when there are unexported changes. If the data engine stops, **The workspace stopped** replaces the app and **Reload CSV Viewer** starts a new empty session.

## Run locally

Requires Node.js 24 or newer and pnpm 10.34.2. The repository's `mise.toml` pins Node 24 and pnpm 10.34.2 for mise users.

```powershell
pnpm install
pnpm run dev:desktop
```

To run the web app instead:

```powershell
pnpm run dev:web
```

Build both apps with `pnpm build`, or create desktop packages with `pnpm package`. Packages are written to `release/`: a Windows installer and portable executable, macOS DMG, or Linux AppImage, depending on the build platform.

## Limitations

- Cell values are edited as text, without numeric, date, or boolean validation.
- Appending a row is disabled while sorting, filtering, or searching. Inserting above or below requires exactly one selected row.
- Reordering columns is not supported.
- Spreadsheet features such as formulas, pivot tables, charts, joins, and SQL editing are not supported.

## Contributing

Before submitting code changes, run `pnpm test`, `pnpm test:browser`, `pnpm test:browser:built`, and `pnpm build`. Run `pnpm test:desktop` when changing desktop behavior. `pnpm build` includes type checking and Oxlint with warnings treated as errors; `pnpm typecheck` and `pnpm lint` run those checks separately.

Install the browser test dependency once with `pnpm exec playwright install chromium`. On Linux, add `--with-deps`.

### End-to-end tests

| Command | Coverage |
| --- | --- |
| `pnpm test:browser` | Chromium runs the full web suite: editing, queries/stats, comparison, parsing, export, drag-and-drop, and lifecycle workflows. |
| `pnpm test:browser:built` | User workflows and engine failure/recovery against the production web assets. Source-instrumented race/cancellation cases run in the dev suite. |
| `pnpm test:desktop` | Builds and launches isolated Electron profiles; checks preload/IPC, native DuckDB, export source protection, Recent CSV Sources across restart, dropped-file identity, and reopen confirmation. |

CI runs the web suites on Linux and desktop tests on Windows. Browser failures retain screenshots and traces; desktop failures attach the Electron window and its trace.

Desktop tests substitute only the OS file chooser and message-box responses. Native dialog appearance and keyboard interaction still require manual verification. Each test uses temporary files and a disposable profile; it never touches the user's recent files or app session.

The maintained [verification map](.agents/skills/verify-csv-viewer/features/README.md) documents user workflows and runtime differences. The [verification skill](.agents/skills/verify-csv-viewer/SKILL.md) provides an isolated desktop/web launcher, interaction commands, and evidence capture.

### Architecture and diagnostics

| Directory | Responsibility |
| --- | --- |
| `apps/desktop` | Electron main process, preload/IPC, native DuckDB, file dialogs, recent sources, and export delivery. |
| `apps/web` | DuckDB-Wasm and its Worker, browser file access, downloads, and startup/recovery screens. |
| `packages/ui` | Shared React UI, AG Grid, CSV and comparison tabs, themes, and clipboard actions. |
| `packages/workspace` | Shared CSV queries, editing/history, export serialization, comparison, and resource ownership. |

Both runtimes use the same `CsvViewer` request and event contract. The workspace now uses Effect 4 for database operations, host access, comparisons, and resource lifetimes, with module-owned Layers and tagged failures. Per-file mutations run in order while reads can run concurrently; scoped leases keep tables alive for admitted work. Cancellable queries wait for driver settlement when interrupted, and shutdown settles work before releasing tables, connections, and source buffers, including retries for failed cleanup. See [workspace resource ownership](packages/workspace/README.md) for the detailed contracts.

Local diagnostics record operation stages, timings, outcomes, and cleanup failures. They exclude source names and paths, column names, cell values, query text, SQL, and driver errors. The verification skill's [diagnostics guide](.agents/skills/verify-csv-viewer/SKILL.md#read-diagnostics) explains how to capture them on desktop and web.

Use `pnpm perf:latency` to measure cold and warm user workflows across both runtimes, or select one with `pnpm perf:latency --runtime web` or `--runtime desktop`. The harness uses isolated sessions and records machine and fixture details. See [Working CSV latency](docs/perf/working-csv-latency.md) for measurement definitions and a recorded baseline; benchmarks run separately from tests and builds.
