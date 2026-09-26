# Workspace resource ownership

The workspace runs CSV open, CSV reopen, Comparison work, and disposal in one Effect runtime. `CsvViewer` remains the promise and event boundary for desktop IPC and the web renderer.

An open operation reserves a Working CSV table as a staging artifact before loading the CSV Source. Its scoped finalizer drops that table unless publication marks it current. If a drop fails, the artifact stays registered so workspace disposal can retry it. The full request holds an admission lease through the Recent CSV Source write, so disposal waits for accepted opens.

Reopen uses the same per-Working CSV mutation queue as edits. It prepares a new table, columns, row count, and fresh edit history before publication. The synchronous publication point changes artifact roles and replaces the complete Working CSV state. It advances the data revision once and then notifies dependent Comparisons. A publication error restores the old state and roles before the staging finalizer runs. The previous table stays retired until its admitted readers release their leases. A failed physical deletion leaves it registered for close or disposal to retry; the committed reopen still returns `opened`.

Effect spans named `csv.open` and `csv.reopen` contain source description, table preparation, source access and load, metadata, and release stages. Log records carry opaque workspace, request, and Working CSV identifiers, stage timings, product outcomes, and cleanup results. Source names, locations, cell values, SQL, and driver errors are excluded. See [Read diagnostics](../../.agents/skills/verify-csv-viewer/SKILL.md#read-diagnostics) for desktop and web capture commands.
