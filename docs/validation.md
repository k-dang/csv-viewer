# Validation

Manual validation notes for CSV Viewer releases and editing changes.

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
