# CSV Viewer

This context describes the language used for exploring, querying, editing, and summarizing tabular CSV data in the desktop viewer.

## Language

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
A side panel that presents quick statistics for the currently opened CSV without replacing the row grid. The first version of the Stats Panel presents read-only Column Value Counts for one selected column.
_Avoid_: Analytics dashboard, report view

**Stats Column**:
The CSV column selected for statistics in the Stats Panel. When the Stats Panel opens, the Stats Column defaults to the focused grid column when one is available, otherwise to the first CSV column.
_Avoid_: Active column, target column

**Working CSV**:
The CSV data currently shown in the viewer, including unsaved cell edits, inserted rows, and deleted rows. Column Value Counts are calculated from the Working CSV, not from the original file on disk.
_Avoid_: Original CSV, source file

**Live Stats**:
Statistics in the Stats Panel that refresh when the Count Scope or Working CSV changes. Live Stats update after filter, search, edit, insert, delete, undo, and redo operations.
_Avoid_: Manual stats, cached report
