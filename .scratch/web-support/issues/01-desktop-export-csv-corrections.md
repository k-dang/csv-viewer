# 01 - Desktop Export CSV corrections

**What to build:** The three confirmed desktop corrections from the web-support PRD, landed against the current desktop architecture before any extraction begins. The user sees the operation named Export CSV everywhere, cannot overwrite the opened CSV Source from the export dialog, and gets close warnings driven by Unexported Changes rather than undo-stack length.

**Blocked by:** None - can start immediately.

**Status:** ready-for-agent

- [ ] The operation is named Export CSV across shared types, renderer labels, application menus, prompts, and tests; no user-visible or code-level "Save As" remains.
- [ ] Choosing the opened CSV Source as the export destination is rejected before writing, using canonical source identity (not string path equality), and the user is re-prompted.
- [ ] A successful export keeps the Active Tab bound to its original CSV Source: no tab rename, no Working CSV rebind, no new Recent CSV Source.
- [ ] A successful export clears Unexported Changes without clearing undo/redo history.
- [ ] Undoing away from the last exported state creates Unexported Changes; redoing back to it clears them; before any export, the CSV Source state is the reference.
- [ ] Close warnings and close-impact reporting derive from Unexported Changes, independently of undo/redo availability.
- [ ] Each of the three corrections lands as its own commit so a desktop regression bisects cleanly.
