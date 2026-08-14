# Compare two CSVs

Compare opens a Comparison Tab against a second open Working CSV, asks for a Comparison Key, and then shows aligned Changed, Baseline-only, Candidate-only, and Unchanged counts. Comparison uses complete Working CSVs, including unsaved edits.

## Sub-features

- `compare-open` opens the candidate picker from Compare… when two CSV tabs exist.
- `compare-choose` creates a Comparison Tab titled with both file names.
- `compare-apply` computes results for a valid key such as `id`.
- `compare-invalid` surfaces key diagnostics for a non-unique or blank key.
- `compare-swap` swaps Baseline and Candidate labels without requiring a new picker.
- `compare-cancel` closes the picker with Cancel, Escape, or Close Candidate picker.

## How to get to it (user POV)

- With a CSV tab active and at least one other CSV open, choose `Compare…`.
- In `Choose a Candidate`, choose a Comparison-Compatible file.
- Check one or more Comparison Key columns, then `Apply key`.
- Choose `Swap sides` or `Refresh comparison` on an applied comparison.
- Close the picker with `Cancel`, the `Close Candidate picker` button, or Escape.

## Driving it with control-csv-viewer

Preconditions:

- `doctor` is `ok`.
- Both fixtures are open as CSV tabs. Active tab is `phase-2-sample.csv`.
- `Compare…` is enabled. The ellipsis is `…` (U+2026), not `...`.

- **Open picker.** Run `click --role button --name "Compare…"`. Wait for `Choose a Candidate` and `Baseline · phase-2-sample.csv`. Candidate `phase-2-sample-edited.csv` shows `Comparison-Compatible`.
- **Cancel once.** Run `click --role button --name "Cancel"`. The dialog is gone. CSV tabs remain.
- **Choose candidate.** Open the picker again, then `click --role button --name "phase-2-sample-edited.csv"`. Wait for region `CSV comparison` and heading `Choose a Comparison Key`. Tab label contains `phase-2-sample.csv ⇄ phase-2-sample-edited.csv`.
- **Apply id.** Check the `id` checkbox, then `click --role button --name "Apply key"`. Wait until badges `Changed `, `Baseline-only `, `Candidate-only `, and `Unchanged ` appear, plus `Applied key: id`. For these fixtures Ada's name differs, so `Changed` is at least 1.
- **Swap.** Run `click --role button --name "Swap sides"`. Baseline and Candidate file names trade places. Wait for `Outdated Comparison` or refreshed badges. If outdated, `click --role button --name "Refresh comparison"` and wait for the badges again.
- **Proof.** Snapshot and screenshot `evidence/compare-csvs/applied.aria.txt` and `applied.png` after Apply key, showing `CSV Viewer`, both file names, `Applied key: id`, the four count badges, and `Main process connected`.

## Gotchas

- `Compare…` stays disabled with a single CSV tab. Open the second fixture first.
- Source search and filters do not limit comparison. Clear them only if they confuse the screenshot, not because comparison requires it.
- `status` is a poor first key if duplicates exist. `id` is unique in both fixtures.
- Closing a CSV that a comparison depends on asks for confirmation and closes the Comparison Tab. Finish the comparison proof before closing sources.
- Do not treat automated unit tests in `csv-workspace.comparison-verification.test.ts` as a substitute for this UI path.
