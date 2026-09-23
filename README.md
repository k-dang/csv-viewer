# CSV Viewer

A local desktop and web app for opening, inspecting, filtering, and cleaning CSV files without uploading them anywhere.

**[Try it in your browser](https://csv-viewer.vercel.app)** - no install, no upload.

<p align="center">
  <img src="images/app.png" alt="CSV Viewer showing a CSV file with filtering and an editable data grid" width="900">
</p>

## Features

- Browse large CSV files, sort and filter rows, and search across columns.
- Adjust delimiter and header settings when a file does not open as expected.
- Edit cells, rename columns, add or delete rows, and undo or redo changes.
- Keep several files open in tabs, each with its own edits and filters.
- Compare two files by a key and inspect changed cells and rows found only on one side.
- View the most frequent values in a column, based on the current search and filters.
- Export your changes to a separate file. Original files are never overwritten.

All CSV processing stays on your device.

## Open and edit files

Drop CSV, TSV, or TXT files into the app, or choose **Open CSV**. You can drop several files at once; existing tabs and edits stay intact.

Double-click a cell to edit it. Values are treated as text, so identifiers such as leading-zero codes are preserved. You can insert, append, or delete rows and undo or redo those changes.

Choose **Export CSV** to save a separate file using the current delimiter and header settings.

## Compare files

Open two files with the same column names, choose **Compare**, and select a key. A key can contain one or more columns; its combined value must be present and unique in every row of both files.

The comparison shows changed cells, unchanged rows, and rows found only on one side. You can show all rows or only differences, swap the two sides, and cancel a running comparison. Editing either file marks the result as outdated until you refresh it.

## Desktop and web

Both versions support editing, comparison, and export. The desktop app remembers recently opened files. The web app keeps files only for the current page session, so you must select them again after a reload. Selecting the same file again in the web app opens another tab.

## Run locally

Requires Node.js 24 or newer and pnpm 10.34.2.

```powershell
pnpm install
pnpm run dev:desktop
```

To run the web app instead:

```powershell
pnpm run dev:web
```

## Limitations

- Cell values are edited as text, without numeric, date, or boolean validation.
- Row insertion is disabled while sorting, filtering, or searching.
- Adding, deleting, and reordering columns is not supported.
- Spreadsheet features such as formulas, pivot tables, charts, joins, and SQL editing are not supported.

## Contributing

Before submitting changes, run `pnpm test`, `pnpm test:browser`, and `pnpm build`.

Install the browser test dependency once with `pnpm exec playwright install chromium`. On Linux, add `--with-deps`.
