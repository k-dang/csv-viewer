# CSV Viewer

A local desktop CSV viewer built with Electron, React, TypeScript, AG Grid Community, and DuckDB.

CSV files are opened from disk by the Electron main process, queried through DuckDB, and displayed in the renderer through paged row-window requests so the full dataset is not held in React state. The active CSV can be edited in memory and written with Save As; the original file is not overwritten.

## Requirements

- Node.js 22 or newer
- pnpm 10.19.0 or newer

## Scripts

```powershell
pnpm install
pnpm run dev
pnpm run typecheck
pnpm run test
pnpm run build
pnpm run package
```

- `dev` starts Vite and launches Electron against the local dev server.
- `typecheck` checks renderer, shared, main, and preload TypeScript.
- `test` runs the Vitest suite for data access and grid request behavior.
- `build` creates `dist-renderer/` and `dist-electron/`.
- `package` builds the app and creates a local desktop package under `release/`.

## MVP Validation

Generate the CSV validation fixtures before manual checks:

```powershell
pnpm run fixtures:validation
```

Then run the app with `pnpm run dev` or package it with `pnpm run package`.

Manual MVP scenarios:

- Open `fixtures/validation/large-rows.csv` and scroll vertically.
- Open `fixtures/validation/wide-columns.csv` and inspect columns horizontally.
- Open `fixtures/validation/quoted-fields.csv` and verify quoted delimiters remain intact.
- Open `fixtures/validation/unusual-columns.csv` and verify sorting, filtering, and search still work with unusual column names.
- Open `fixtures/validation/malformed.csv` and verify the app surfaces a clear error instead of crashing.
- Reopen a CSV from the recent files list after closing and relaunching the app.

## CSV Editing

The grid supports focused CSV cleanup workflows:

- Inline cell edits. Values are treated as text, preserving identifiers such as leading-zero codes.
- Insert row above or below one selected source row when no sort, filter, or search is active.
- Append an empty row when no rows are selected and no sort, filter, or search is active.
- Delete one or more selected rows.
- Undo and redo cell edits, row inserts, and row deletes.
- Save As writes a separate CSV using the active delimiter and header settings.

Editing controls are intentionally disabled when the requested operation would be ambiguous. Row insertion is blocked under active sort, filter, or search because the visible order is derived from a query, but cell edits and deletes still target stable source row identifiers in those views.

## Editing Validation

Before shipping editing changes, run:

```powershell
pnpm run test
pnpm run typecheck
pnpm run build
```

Manual validation should cover:

- Normal CSV open, edit, undo, redo, delete, insert, append, and Save As.
- `fixtures/validation/quoted-fields.csv`, confirming quoted delimiters remain data after editing and Save As.
- A CSV with leading-zero identifiers, confirming edited and untouched identifiers stay as text.
- Filtered and searched edits, confirming rows refresh when an edited value enters or leaves the active query.
- Sorted edits and multi-row delete, confirming operations target selected source rows rather than visible indexes.
- Opening another file, reopening the active file, and closing the app with unsaved changes, confirming Save As, Discard, and Cancel decisions.
- `fixtures/validation/large-rows.csv`, confirming scrolling still requests bounded row windows after edits.

## Packaging Notes

`pnpm run package` uses `@electron/packager` to produce a local Electron build in `release/`. The packaged app loads the built renderer from disk instead of the Vite dev server. ASAR packaging is intentionally disabled for the MVP so DuckDB's native binding loads from a normal filesystem path.

Recent files are stored in Electron's per-user `userData` directory as `recent-files.json`. The source CSV files are never modified.

## Known Limitations

- Save As is the only persistence path. The original CSV is never overwritten implicitly.
- Cell values are edited as text. Numeric, date, and boolean validation is not enforced.
- Column insertion, deletion, renaming, and reordering are not supported.
- Row insertion is disabled while sort, filter, or search is active.
- Only one active CSV session is supported.
- Recent files store local file paths only and do not track moved or deleted files until reopening fails.
- Advanced spreadsheet features such as formulas, pivot tables, charts, joins, and SQL editing are out of scope.
- Long-running DuckDB work can be superseded at the renderer request level, but active database queries are not forcibly killed.
