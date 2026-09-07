# Compare two CSVs

Compare opens a Comparison Tab against a second open Working CSV, asks for a Comparison Key, and then shows aligned Changed, Baseline-only, Candidate-only, and Unchanged counts. Comparison uses complete Working CSVs, including Unexported Changes.

## Sub-features

- `compare-open` opens the candidate picker from Compare… when two CSV tabs exist.
- `compare-choose` creates a Comparison Tab titled with both file names.
- `compare-apply` computes results for a valid key such as `id`.
- `compare-invalid` surfaces key diagnostics for a key column whose values are blank or non-unique.
- `compare-swap` swaps Baseline and Candidate labels without requiring a new picker.
- `compare-cancel` closes the picker with Cancel, Escape, Close Candidate picker, or the dimmed overlay.

## How to get to it (user POV)

- With a CSV tab active and at least one other CSV open, choose `Compare…`.
- In `Choose a Candidate`, choose a Comparison-Compatible file.
- Check one or more Comparison Key columns, then `Apply key`.
- Choose `Swap sides` or `Refresh comparison` on an applied comparison.
- Close the picker with `Cancel`, the `Close Candidate picker` button, Escape, or the overlay.

## Driving it with control-csv-viewer

Preconditions:

- `doctor` is `ok`.
- Both fixtures are open as CSV tabs. Active tab is `phase-2-sample.csv`.
- `Compare…` is enabled. The ellipsis is `…` (U+2026), not `...`.

Unattended runs do not reach those preconditions. Recent CSV Sources exist only on the empty window and unmount as soon as one tab is open. The File menu has no Open Recent, there is no drag-and-drop or command-line file handling, and re-picking the same fixture replaces its tab instead of adding one. The second file therefore requires `Open CSV` (native OS dialog). Report the whole feature as unreachable without a human finishing that dialog. Do not mark it verified from unit tests or from a disabled `Compare…` button.

Record the attempted route: with one tab open, `click --role button --name "Compare…"` returns `"disabled": true` and the picker does not open, and `text` shows no `RECENT CSV SOURCES`.

If two CSV tabs are already open (human finished the dialog):

- **Open picker.** Run `click --role button --name "Compare…"`. Wait for `Choose a Candidate` and `Baseline · phase-2-sample.csv`. Candidate `phase-2-sample-edited.csv` shows `Comparison-Compatible`.
- **Cancel once.** Run `click --role button --name "Cancel"`. The dialog is gone. CSV tabs remain.
- **Choose candidate.** Open the picker again, then `click --role button --name "phase-2-sample-edited.csv"`. Wait for heading `Choose a Comparison Key`. Tab label contains `phase-2-sample.csv ⇄ phase-2-sample-edited.csv`.
- **Apply id.** Run `click --role checkbox --name "id" --exact`, then `click --role button --name "Apply key"`. Wait for `Applied key: id` and the badges `Changed `, `Baseline-only `, `Candidate-only `, and `Unchanged `. For these fixtures expect `Changed 1`, `Baseline-only 0`, `Candidate-only 0`, `Unchanged 4`: the only difference is row `id` 4, whose `total_spend` is `1.5` in the baseline and `1.0` in the candidate.
- **Swap.** Run `click --role button --name "Swap sides"`. Baseline and Candidate trade places and the tab title flips to `phase-2-sample-edited.csv ⇄ phase-2-sample.csv`. Badges refresh in place with no re-apply. Swap does not show `Outdated Comparison`; that banner appears only after a source Working CSV changes.
- **Proof.** Snapshot and screenshot `evidence/compare-csvs/applied.aria.txt` and `applied.png` after Apply key, showing `CSV Viewer`, both file names, `Applied key: id`, and the four count badges.

## Gotchas

- `Compare…` is rendered only while a CSV tab is active. It is absent on the empty window, disabled with a single CSV tab, and absent again once the Comparison Tab is active. Click back to a CSV tab before reopening the picker.
- After `Swap sides` the tab title changes too. A wait on the pre-swap title hangs.
- The fixtures differ in exactly one cell. Do not expect Ada's row to differ; it is byte-identical in both files.
- An empty key draft leaves `Apply key` disabled, so `compare-invalid` needs a key column with blank or duplicated values, not an empty selection.
- Source search and filters do not limit comparison. Clear them only if they confuse the screenshot, not because comparison requires it.
- `status` is a poor first key if duplicates exist. `id` is unique in both fixtures.
- Closing a CSV that a comparison depends on asks for confirmation and closes the Comparison Tab. Finish the comparison proof before closing sources.
- Do not treat the comparison unit tests (`packages/workspace/src/csv-comparison-service.test.ts`, `packages/workspace/src/comparison-projection.test.ts`) as a substitute for this UI path.
