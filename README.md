# CSV Viewer

A local desktop CSV viewer built with Electron, React, TypeScript, AG Grid Community, and DuckDB.

The MVP is read-only. CSV files are opened from disk by the Electron main process, queried through DuckDB, and displayed in the renderer through paged row-window requests so the full dataset is not held in React state.

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

## Packaging Notes

`pnpm run package` uses `@electron/packager` to produce a local Electron build in `release/`. The packaged app loads the built renderer from disk instead of the Vite dev server. ASAR packaging is intentionally disabled for the MVP so DuckDB's native binding loads from a normal filesystem path.

Recent files are stored in Electron's per-user `userData` directory as `recent-files.json`. The source CSV files are never modified.

## Known Limitations

- The MVP is read-only and does not save, edit, or export CSV data.
- Only one active CSV session is supported.
- Recent files store local file paths only and do not track moved or deleted files until reopening fails.
- Advanced spreadsheet features such as formulas, pivot tables, charts, joins, and SQL editing are out of scope.
- Long-running DuckDB work can be superseded at the renderer request level, but active database queries are not forcibly killed.
