# CSV Viewer

This context describes the language used for exploring, querying, editing, and summarizing tabular CSV data in the desktop viewer.

## Language

**Aligned Comparison**:
A comparison of two CSVs that places corresponding Baseline and Candidate rows on the same visual line and distinguishes changed cells, added rows, and removed rows.
_Avoid_: Side-by-side comparison, split view, independent grids

**Baseline**:
The Working CSV used as the reference side of an Aligned Comparison.
_Avoid_: Left CSV, old file, original CSV

**Candidate**:
The Working CSV evaluated against the Baseline in an Aligned Comparison.
_Avoid_: Right CSV, new file, comparison file

**Comparison Key**:
One or more shared CSV columns selected by the user whose combined values identify corresponding Baseline and Candidate rows in an Aligned Comparison.
_Avoid_: Primary key, row number, inferred key

**Valid Comparison Key**:
A Comparison Key whose combined value is present and unique for every row within each Working CSV. Blank key parts and duplicate combined values make a Comparison Key invalid and block comparison.
_Avoid_: Best-effort key, ambiguous key, mostly unique key

**Comparison-Compatible CSVs**:
Two Working CSVs with exactly the same set of column names. Column order and inferred column types do not affect compatibility.
_Avoid_: Same schema, matching files, identical columns

**Comparison Tab**:
A persistent Tab that presents one Aligned Comparison and retains its Baseline, Candidate, applied Comparison Key, and result-view state while the user switches Tabs.
_Avoid_: Compare mode, split tab, temporary comparison

**Outdated Comparison**:
An Aligned Comparison whose results no longer reflect its current Baseline or Candidate because either Working CSV changed after the results were computed. Its applied Comparison Key and existing results remain available until the user refreshes it.
_Avoid_: Live comparison, invalid comparison, stale file

**Unchanged Row**:
A pair of rows with the same Comparison Key and exact matching values in every non-key column.
_Avoid_: Equal record, identical line

**Changed Row**:
A pair of rows with the same Comparison Key and at least one exact cell-value difference in a non-key column.
_Avoid_: Modified record, edited row

**Baseline-only Row**:
A Baseline row whose Comparison Key has no corresponding Candidate row.
_Avoid_: Deleted row, removed record

**Candidate-only Row**:
A Candidate row whose Comparison Key has no corresponding Baseline row.
_Avoid_: Added row, inserted record

**Column Value Counts**:
A quick statistic that groups rows by the values in one selected CSV column and reports the row count for each distinct value. It is scoped to the currently visible rows after active search and filters.
_Avoid_: Quick stats, value stats, column counts

**Count Scope**:
The set of CSV rows included when calculating Column Value Counts. Count Scope is defined by active filters and global search, and is not affected by row sort order.
_Avoid_: Active query, sorted rows

**Counted Value**:
The exact parsed cell value used as a bucket in Column Value Counts. Counted Values are case-sensitive, and empty strings and null cells are separate Counted Values.
_Avoid_: Displayed value, normalized value

**Top Counted Values**:
The highest-frequency Counted Values for a selected column within the Count Scope. The first version shows at most 50 Top Counted Values, ordered by count descending and then by Counted Value ascending for ties.
_Avoid_: Full distribution, histogram

**Scope Percentage**:
The percentage of Count Scope rows represented by one Counted Value. Scope Percentage is shown with each Top Counted Value.
_Avoid_: Overall percentage, file percentage

**Stats Panel**:
A side panel that presents quick statistics for its Tab's Working CSV without replacing the row grid. Stats Panel visibility and the Stats Column are per-Tab state. The first version of the Stats Panel presents read-only Column Value Counts for one selected column.
_Avoid_: Analytics dashboard, report view

**Stats Column**:
The CSV column selected for statistics in the Stats Panel. When the Stats Panel opens, the Stats Column defaults to the focused grid column when one is available, otherwise to the first CSV column.
_Avoid_: Active column, target column

**Tab**:
One persistent workspace in the viewer: either a Working CSV or an Aligned Comparison. Opening a file always creates and focuses a CSV Tab; a file (identified by its path) can be open in at most one CSV Tab, and opening an already-open file focuses its existing CSV Tab instead of duplicating it.
_Avoid_: Document, window, temporary view

**Working CSV**:
The CSV data of one CSV Tab, including unsaved cell edits, inserted rows, and deleted rows. Each CSV Tab has its own Working CSV, independent of other Tabs. Column Value Counts are calculated from the Working CSV, not from the original file on disk.
_Avoid_: Original CSV, source file

**Active Tab**:
The Tab currently displayed. Switching the Active Tab never changes any Tab's state: CSV query and edit state belong to CSV Tabs, while Comparison Key and result-view state belong to Comparison Tabs.
_Avoid_: Current file, focused document

**Live Stats**:
Statistics in the Stats Panel that refresh when the Count Scope or Working CSV changes. Live Stats update after filter, search, edit, insert, delete, undo, and redo operations.
_Avoid_: Manual stats, cached report
