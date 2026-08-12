# 01 - Desktop Export CSV corrections

**What to build:** The three confirmed desktop corrections from the web-support PRD, landed against the current desktop architecture before any extraction begins. The user sees the operation named Export CSV everywhere, cannot overwrite the opened CSV Source from the export dialog, and gets close warnings driven by Unexported Changes rather than undo-stack length.

**Blocked by:** None - can start immediately.

**Status:** ready-for-agent

**Unexported Changes is revision identity, not stack depth.** Every mutation produces a new monotonically increasing revision id; each undo/redo entry carries the revision id it restores; the Working CSV records the revision id last exported, initialized to the revision id of the freshly opened CSV Source. Unexported Changes is `currentRevisionId !== lastExportedRevisionId`. One field satisfies all four behaviors below. Do not implement it as a separate state machine, and do not use stack depth - `undoStack.length !== exportedDepth` falsely reports clean when an edit after an undo restores the original depth with different content.

- [ ] The operation is named Export CSV across shared types, renderer labels, application menus, prompts, and tests; no user-visible or code-level "Save As" remains.
- [ ] Export CSV is available for every open Working CSV, including one with no Unexported Changes; its availability is not derived from undo/redo state.
- [ ] Choosing the opened CSV Source as the export destination is rejected before writing, using canonical source identity (not string path equality), and the user is re-prompted.
- [ ] A successful export keeps the Active Tab bound to its original CSV Source: no tab rename, no Working CSV rebind, no new Recent CSV Source.
- [ ] A successful export clears Unexported Changes without clearing undo/redo history. The two `state.undoStack = []; state.redoStack = []` lines in `working-csv-store.ts:593-594` are the bug being removed.
- [ ] Undoing away from the last exported state creates Unexported Changes; redoing back to it clears them; before any export, the CSV Source state is the reference.
- [ ] A test covers the case that distinguishes revision identity from stack depth: export, undo, then make a different edit restoring the original stack depth, and assert Unexported Changes is set.
- [ ] Close warnings and close-impact reporting derive from Unexported Changes, independently of undo/redo availability.
- [ ] User-visible copy and shared/domain names such as `CsvEditState.dirty`, `isDirty`, and `dirtyWorkingCsvs` are replaced with Unexported Changes terminology; no dirty/unsaved vocabulary is carried into the new runtime seam.
- [ ] Export remains a non-data mutation for Aligned Comparison freshness, and the existing comparison verification coverage is updated from Save As terminology without weakening that assertion.
- [ ] Each of the three corrections lands as its own commit so a desktop regression bisects cleanly.
