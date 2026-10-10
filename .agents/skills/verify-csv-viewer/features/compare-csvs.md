# Compare two CSVs

Compare opens a Comparison Tab against a second open Working CSV, asks for a Comparison Key, and then opens Inspector with a virtual row list and full Baseline/Candidate values. Grid scans many rows with inline changes. Both views share search, classification filters, row order, changed-field visibility, and selection. Comparison uses complete Working CSVs, including Unexported Changes.

## Sub-features

- `compare-open` opens the candidate picker from Compare… when two CSV tabs exist.
- `compare-choose` creates a Comparison Tab titled with both file names.
- `compare-apply` computes results for a valid key such as `id`.
- `compare-invalid` surfaces key diagnostics for a key column whose values are blank or non-unique.
- `compare-review` switches Grid/Inspector, selects rows, and uses Previous/Next across page boundaries.
- `compare-filter` searches the complete snapshot and filters by classification.
- `compare-edit-key` opens Edit key on an applied result.
- `compare-swap` swaps Baseline and Candidate labels without requiring a new picker.
- `compare-cancel` closes the picker with Cancel, Escape, Close Candidate picker, or the dimmed overlay.

## How to get to it (user POV)

- With a CSV tab active and at least one other CSV open, choose `Compare…`.
- In `Choose a Candidate`, choose a Comparison-Compatible file.
- Check one or more Comparison Key columns, then `Apply key`.
- Switch `Grid`/`Inspector`; click a grid row or press Enter to inspect it. Use `Previous row` and `Next row` in Inspector.
- Choose a result filter, search for a key or either side’s value, toggle `Changed fields only`, or choose `Row order`.
- Choose `Edit key`, `Swap sides`, or `Refresh comparison` on an applied comparison.
- Close the picker with `Cancel`, the `Close Candidate picker` button, Escape, or the overlay.

## Driving it with control-csv-viewer

Preconditions:

- `doctor` is `ok`.
- Both fixtures are open as CSV tabs. Active tab is `phase-2-sample.csv`.
- `Compare…` is enabled. The ellipsis is `…` (U+2026), not `...`.

Open both fixtures on either runtime with `drop --files '["fixtures/phase-2-sample.csv","fixtures/phase-2-sample-edited.csv"]'`, then select the baseline with `click --role tab --name "phase-2-sample.csv"`. Drops open in order and the last success takes focus, so wait for a value only the candidate has (`1.0`) before selecting the baseline, then wait for `1.5`. Web also supports two `upload` calls. Verify the picker through the UI.

- **Open picker.** Run `click --role button --name "Compare…"`. Wait for `Choose a Candidate` and `BASELINE · PHASE-2-SAMPLE.CSV` (the header is CSS-uppercased, so `wait` must match the uppercase form). Candidate `phase-2-sample-edited.csv` shows `Comparison-Compatible`.
- **Cancel.** Run `click --role button --name "Cancel"`. The dialog is gone. CSV tabs remain. Open the picker again and close it with `press --key Escape`, then once more with `click --role button --name "Close Candidate picker"`. The dimmed overlay has no role or name, so the helper cannot click it.
- **Choose candidate.** Open the picker again, then click the candidate by its subtitle: `click --role button --name "This browser session"` on web, or the source path on desktop. With one candidate, `--name "Comparison-Compatible"` matches it on either runtime without typing a path. The bare file name also matches the tab and its close button. Wait for heading `Choose a Comparison Key`. Tab label contains `phase-2-sample.csv ⇄ phase-2-sample-edited.csv`.
- **Invalid key.** Run `click --role checkbox --name "status"`, then `click --role button --name "Apply key"`. Wait for `This draft is not a Valid Comparison Key.` `text` shows `phase-2-sample.csv: 0 blank-key rows, 1 duplicate-key groups` and the same line for the candidate. Uncheck `status` with the same click.
- **Apply id.** Run `click --role checkbox --name "id"`, then `click --role button --name "Apply key"`. Wait for `Match rows by`, `id 4`, and the result filters `Changed `, `Baseline-only `, `Candidate-only `, and `Unchanged `. For these fixtures expect `Changed 1`, `Baseline-only 0`, `Candidate-only 0`, `Unchanged 4`: the only difference is row `id` 4, whose `total_spend` is `1.5` in the baseline and `1.0` in the candidate.
- **Swap.** Run `click --role button --name "Swap sides"`. Baseline and Candidate trade places and the tab title flips to `phase-2-sample-edited.csv ⇄ phase-2-sample.csv`. Badges refresh in place with no re-apply. Swap does not show `Outdated Comparison`; that banner appears only after a source Working CSV changes.
- **Refresh.** Run `click --role button --name "Refresh comparison"`. The existing row list, inspected values, and counts stay visible until their replacements arrive. Refresh is disabled until a result has been applied and while refreshing. Operations lasting more than 250 ms show `Refreshing…` in the same button and progress in the key row. On these fixtures, wait for `1 of 5 rows` and inspect the unchanged counts and `id 4` values; counts alone do not prove refresh finished.
- **Inspect and scan.** Inspector initially selects `id 4` and shows only `total_spend`. Toggle `Changed fields only` to reveal all fields. Click `Grid`, then `All rows 5`; five rows appear, with `id 4` first. Click its Row cell to return to Inspector. Search with `fill --role searchbox --name "Find a comparison row or value" --value "dorothy"`; the full snapshot is searched even when `name` is hidden. Clear the search before continuing.
- **Edit key.** Click `Edit key` to open `Edit Comparison Key`. `Apply key` is inside that dialog; a valid replacement closes it, while invalid-key diagnostics remain there.
- **Proof.** Snapshot and screenshot `evidence/compare-csvs/inspector.aria.txt` and `inspector.png` after Apply key, then `grid.aria.txt` and `grid.png` in Grid. Show `CSV Viewer`, both file names, the applied key, result counts, and the corresponding values.

## Web differences

Both runtimes support this recipe through file drops. Web also supports `upload`.

- Open both fixtures with two `upload` calls, then `Compare…` is enabled.
- Pick the candidate by its subtitle, `This browser session`, not by its file name: the bare name also matches the tab and its close button, and `--nth 0` lands on the tab.
- Everything after that is shared UI and matches the recipe above.

## Gotchas

- `Compare…` is rendered only while a CSV tab is active. It is absent on the empty window, disabled with a single CSV tab, and absent again once the Comparison Tab is active. Click back to a CSV tab before reopening the picker.
- Do not pass `--exact` to the key checkbox. Its accessible name includes the input `value`, so it reads `id on` and an exact match finds nothing.
- After `Swap sides` the tab title changes too. A wait on the pre-swap title hangs.
- The fixtures differ in exactly one cell. Do not expect Ada's row to differ. It is byte-identical in both files. An unexported edit after Apply key does not recompute the badges. The tab shows `Outdated Comparison` and keeps `Changed 1` and `Unchanged 4` until `Refresh comparison` or `Apply key`. Refresh after editing Ada's cell yields `Changed 2` and `Unchanged 3`.
- The first comparison has a progress banner with `Cancel`. Once a result exists, progress and `Cancel` use the key row after 250 ms, without inserting a banner. A cancel with no applied result shows `Comparison cancelled. No result was applied.` After a result exists, a floating notice shows `Comparison cancelled. The previous applied result was preserved.` Both include `Dismiss`. These fixtures usually finish before refresh progress appears. The comparison-cancellation E2E test holds a real operation to verify Cancel, failure preservation, and retry.
- An empty key draft leaves `Apply key` disabled, so `compare-invalid` needs a key column with blank or duplicated values, not an empty selection.
- Source search and filters do not limit comparison. Clear them only if they confuse the screenshot, not because comparison requires it.
- `status` is a poor first key if duplicates exist. `id` is unique in both fixtures.
- Closing a CSV that a comparison depends on asks for confirmation and closes the Comparison Tab. Finish the comparison proof before closing sources.
- Do not treat the comparison unit tests (`packages/workspace/src/comparison/csv-comparison-service.test.ts`, `packages/workspace/src/comparison/comparison-projection.test.ts`) as a substitute for this UI path.
