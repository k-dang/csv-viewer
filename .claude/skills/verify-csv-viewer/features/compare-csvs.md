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

Open both fixtures on either runtime with `drop --files '["fixtures/phase-2-sample.csv","fixtures/phase-2-sample-edited.csv"]'`, then select the baseline with `click --role tab --name "phase-2-sample.csv"`. Web also supports two `upload` calls. Verify the picker through the UI.

- **Open picker.** Run `click --role button --name "Compare…"`. Wait for `Choose a Candidate` and `Baseline · phase-2-sample.csv`. Candidate `phase-2-sample-edited.csv` shows `Comparison-Compatible`.
- **Cancel once.** Run `click --role button --name "Cancel"`. The dialog is gone. CSV tabs remain.
- **Choose candidate.** Open the picker again, then click the candidate by its subtitle: `click --role button --name "This browser session"` on web, or the source path on desktop. The bare file name also matches the tab and its close button. Wait for heading `Choose a Comparison Key`. Tab label contains `phase-2-sample.csv ⇄ phase-2-sample-edited.csv`.
- **Apply id.** Run `click --role checkbox --name "id"`, then `click --role button --name "Apply key"`. Wait for `Applied key: id` and the badges `Changed `, `Baseline-only `, `Candidate-only `, and `Unchanged `. For these fixtures expect `Changed 1`, `Baseline-only 0`, `Candidate-only 0`, `Unchanged 4`: the only difference is row `id` 4, whose `total_spend` is `1.5` in the baseline and `1.0` in the candidate.
- **Swap.** Run `click --role button --name "Swap sides"`. Baseline and Candidate trade places and the tab title flips to `phase-2-sample-edited.csv ⇄ phase-2-sample.csv`. Badges refresh in place with no re-apply. Swap does not show `Outdated Comparison`; that banner appears only after a source Working CSV changes.
- **Proof.** Snapshot and screenshot `evidence/compare-csvs/applied.aria.txt` and `applied.png` after Apply key, showing `CSV Viewer`, both file names, `Applied key: id`, and the four count badges.

## Web differences

Both runtimes support this recipe through file drops. Web also supports `upload`.

- Open both fixtures with two `upload` calls, then `Compare…` is enabled.
- Pick the candidate by its subtitle, `This browser session`, not by its file name: the bare name also matches the tab and its close button, and `--nth 0` lands on the tab.
- Everything after that is shared UI and matches the recipe above.

## Gotchas

- `Compare…` is rendered only while a CSV tab is active. It is absent on the empty window, disabled with a single CSV tab, and absent again once the Comparison Tab is active. Click back to a CSV tab before reopening the picker.
- Do not pass `--exact` to the key checkbox. Its accessible name includes the input `value`, so it reads `id on` and an exact match finds nothing.
- After `Swap sides` the tab title changes too. A wait on the pre-swap title hangs.
- The fixtures differ in exactly one cell. Do not expect Ada's row to differ; it is byte-identical in both files.
- An empty key draft leaves `Apply key` disabled, so `compare-invalid` needs a key column with blank or duplicated values, not an empty selection.
- Source search and filters do not limit comparison. Clear them only if they confuse the screenshot, not because comparison requires it.
- `status` is a poor first key if duplicates exist. `id` is unique in both fixtures.
- Closing a CSV that a comparison depends on asks for confirmation and closes the Comparison Tab. Finish the comparison proof before closing sources.
- Do not treat the comparison unit tests (`packages/workspace/src/comparison/csv-comparison-service.test.ts`, `packages/workspace/src/comparison/comparison-projection.test.ts`) as a substitute for this UI path.
