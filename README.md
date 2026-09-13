# CSV Viewer

A local desktop and web app for opening, inspecting, filtering, and cleaning CSV files without uploading them anywhere.

**[Try it in your browser](https://csv-viewer.vercel.app)** - no install, no upload.

<p align="center">
  <img src="images/app.png" alt="CSV Viewer showing a large CSV file with metadata, delimiter controls, filtering, and an editable data grid" width="900">
</p>

CSV Viewer is built for practical CSV work: open files from disk, browse large datasets smoothly, adjust parsing options, search and filter rows, make focused cleanup edits, compare two CSVs row by row, then deliver the Working CSV separately with Export CSV.

Drop CSV, TSV, or TXT files anywhere in the desktop or web app, or use Open CSV. Multiple dropped files open in sequence. Existing tabs and edits stay intact, and any rejected or failed files appear in a summary.

## Highlights

- **Local Processing.** Desktop and web keep CSV Sources and Working CSV data on your device. CSV Sources are never uploaded or overwritten.
- **Large-file friendly browsing.** DuckDB handles CSV querying while the renderer requests bounded row windows instead of loading the full dataset into React state.
- **Rich table interaction.** AG Grid provides sorting, filtering, column resizing, horizontal scrolling, and focused row inspection for wide or messy files.
- **CSV-aware controls.** Delimiter and header handling can be adjusted when a file needs explicit parsing settings instead of the sniffed defaults.
- **Safe cleanup edits.** Edit cells, insert or append rows, delete rows, undo/redo changes, and deliver the result with Export CSV.
- **Tabs for parallel work.** Several Working CSVs stay open at once, each with its own edit and query state.
- **Aligned Comparison.** Compare two Working CSVs on a Comparison Key and see changed cells, Baseline-only rows, and Candidate-only rows on matching lines.
- **Column Value Counts.** A Stats Panel reports the most frequent values in one column, scoped to the rows your active filters and search leave visible.

## Stack

Electron, React, TypeScript, AG Grid Community, native DuckDB, DuckDB-Wasm, Vite, Vitest, and pnpm.

## How It Works

Desktop opens CSV Sources through the Electron main process and queries them with native DuckDB. Web reads one browser-selected CSV Source at a time into an in-memory DuckDB-Wasm Worker. Both runtimes display bounded row windows, so the full dataset is not held in React state.

The runtime applications live in `apps/desktop/` and `apps/web/`. Both compose the React product from `packages/ui/` with the runtime-neutral CSV module from `packages/workspace/`. `CsvWorkspaceHost` handles file selection, source description, export delivery, and Recent CSV Sources. `WorkspaceDatabase` handles parameterized DuckDB queries, connections, and cancellation. Desktop supplies Electron and native DuckDB adapters. Web supplies browser and DuckDB-Wasm adapters.

Shared source is grouped by responsibility:

- `packages/ui/src/app/` owns application composition and renderer workspace lifecycle.
- `packages/ui/src/csv/` contains CSV Tab state, the grid, dialect controls, and Stats Panel.
- `packages/ui/src/comparison/` contains Comparison views and grid data access.
- `packages/ui/src/components/ui/` contains shared visual primitives.
- `packages/workspace/src/working-csv/` owns Working CSV storage, edit history, and export serialization.
- `packages/workspace/src/comparison/` owns Comparison lifecycle, execution, key rules, and result projection.
- `packages/workspace/src/query/` contains CSV query generation and result normalization.

Workspace composition, the public product contract, and runtime adapter interfaces stay at `packages/workspace/src/`. Tests stay beside their feature code; package exports provide stable import paths for consumers.

### Workspace boundaries

- Runtime adapters stay in their application. Shared packages do not import Electron, browser adapters, Node filesystem modules, or concrete DuckDB drivers.
- `packages/ui` depends on the `CsvViewer` interface, not a runtime implementation. `packages/workspace` exposes explicit subpaths instead of a barrel export.
- The persistent renderer workspace owns Tab lifecycle and viewer events for both applications. App displays its snapshot; each CSV Tab owns its query, edits, export, and Stats Panel state.
- Focused unit tests stay beside the source they cover. Runtime-neutral contract definitions live in `packages/workspace/test/contract/`, and each application runs them from its own `integration/` directory with its runtime adapters.
- Vite consumes the `packages/workspace` TypeScript source in the Electron main, renderer, and web bundles.
- Tailwind source discovery lives in `packages/ui/src/styles.css` and explicitly scans the shared UI plus both application roots. Keep those paths current when moving files.

## Requirements

- Node.js 24 or newer
- pnpm 10.34.2

## Scripts

```powershell
pnpm install
pnpm run dev:desktop
pnpm run dev:web
pnpm run build:desktop
pnpm run build:web
pnpm run typecheck
pnpm run test
pnpm run test:browser
pnpm run build
pnpm run package
```

- `dev:desktop` starts Vite and launches Electron against the local dev server. `dev` is an alias.
- `dev:web` starts the browser composition root at `http://127.0.0.1:5173`.
- `build:desktop` creates the renderer plus standalone `main.cjs` and `preload.cjs` Electron bundles.
- `build:web` creates `apps/web/dist-web/`, including the self-hosted Worker and Wasm module.
- `typecheck` checks both applications and both shared packages.
- `test` runs the Vitest suite covering the workspace seam, editing, Comparison, runtime adapters, and CSV Tab behavior.
- `test:browser` starts the web app and runs Chromium tests for open/edit/export, delayed Reopen delivery after close, and multi-Tab Comparison closure. Install Chromium once with `pnpm exec playwright install chromium`, or add `--with-deps` on Linux. Use `pnpm test:browser --headed` to watch the tests. CI runs the same suite and retains failure screenshots.
- `build` runs typecheck and lint, then builds both applications.
- `package` builds the app and creates platform installers under `release/`.

## CSV Editing

The grid supports focused CSV cleanup workflows:

- Inline cell edits. Values are treated as text, preserving identifiers such as leading-zero codes.
- Insert row above or below one selected source row when no sort, filter, or search is active.
- Append an empty row when no rows are selected and no sort, filter, or search is active.
- Delete one or more selected rows.
- Undo and redo cell edits, row inserts, and row deletes.
- Export CSV delivers a separate CSV using the active delimiter and header settings. It preserves undo and redo history and establishes the current revision as exported.

Editing controls are intentionally disabled when the requested operation would be ambiguous. Row insertion is blocked under active sort, filter, or search because the visible order is derived from a query, but cell edits and deletes still target stable source row identifiers in those views.

## Aligned Comparison

Two open Working CSVs with exactly the same set of column names can be compared in their own Comparison Tab:

- Choose a Comparison Key: one or more shared columns whose combined values identify corresponding rows. A key is rejected when any combined value is blank or duplicated within either side, and the diagnostics point at the offending rows.
- Corresponding Baseline and Candidate rows are placed on the same line, distinguishing Unchanged, Changed, Baseline-only, and Candidate-only rows.
- View all rows or differences only, and order columns by changed-first or CSV order.
- Swap Baseline and Candidate without recomputing.
- Editing either side marks the Comparison Outdated; its applied key and existing results stay available until you refresh.
- Long comparisons run on a dedicated worker and can be cancelled.

## Stats Panel

The Stats Panel reports Column Value Counts for one selected column beside the grid: the top 50 values by frequency with their share of the Count Scope. The scope is the rows left visible by active filters and global search, so the counts follow what you are looking at, and they refresh after edits, inserts, deletes, undo, and redo.

## Development

Before shipping changes, run `pnpm run test` and `pnpm run build`. The build includes the full TypeScript typecheck, and CI runs the same test and build gates for every pull request and push to `main`.

Feature validation belongs in deterministic tests at the data-service, workspace, IPC-facing, and CSV Tab boundaries. Release readiness does not depend on a separate manual validation checklist.

## Web deployment

The web runtime is deployed at [csv-viewer.vercel.app](https://csv-viewer.vercel.app).
Vercel builds every push to `main` from the repository root.

[vercel.json](vercel.json) sets the install and web build commands, publishes
`apps/web/dist-web`, and applies the security and cache headers using
[Vercel's project configuration](https://vercel.com/docs/project-configuration/vercel-json).
The install command filters to `@csv-viewer/web...`, so only the web application and
its workspace dependencies are installed. [.vercelignore](.vercelignore) keeps
desktop-only and development trees out of the upload.

The deployment serves static files only. There are no serverless functions, no
backend, and no analytics: Vercel Web Analytics and Speed Insights stay disabled.
CSV data never leaves the user's device.

For a local build, run `pnpm install --frozen-lockfile` and `pnpm run build:web`.

## Packaging Notes

`apps/desktop/package.json` owns the Electron Builder configuration. `pnpm run package` produces platform-specific release artifacts in `release/`. On Windows this creates an NSIS installer and a portable executable; the GitHub Actions release workflow also builds a macOS DMG and Linux AppImage on their native runners.

Recent CSV Sources are stored in Electron's per-user `userData` directory as `recent-files.json`. That filename predates the Recent CSV Source vocabulary and is kept so existing installs keep their list. CSV Sources are never modified.

The web runtime keeps each selected CSV Source only for the current page lifetime. It cannot establish durable identity, so selecting the same physical file again opens another CSV Tab. Recent CSV Sources are unavailable and users must select their CSV Sources again after reload.

## Known Limitations

- Export CSV is the only output-delivery path. A Working CSV's CSV Source is never overwritten.
- Cell values are edited as text. Numeric, date, and boolean validation is not enforced.
- Column insertion, deletion, renaming, and reordering are not supported.
- Row insertion is disabled while sort, filter, or search is active.
- A CSV Source whose identity can be established opens in at most one CSV Tab; opening it again focuses the existing Tab rather than creating a second one.
- Aligned Comparison requires both Working CSVs to have exactly the same set of column names, and a Comparison Key whose combined value is present and unique in every row of both sides.
- Desktop Recent CSV Sources store local filesystem locations and do not track moved or deleted CSV Sources until reopening fails.
- Advanced spreadsheet features such as formulas, pivot tables, charts, joins, and SQL editing are out of scope.
- Long-running general CSV queries can be superseded at the renderer request level but are not forcibly killed. Comparison generations use dedicated workers that are interrupted when cancelled.
