# 03 - Shared runtime-neutral CsvWorkspace extraction

**What to build:** One shared, runtime-neutral CsvWorkspace implementation extracted from the desktop main process, owning Working CSV lifecycle, row windows, filtering, sorting, search, Column Value Counts, editing, history, Unexported Changes, export state, capacity-outcome types, and Aligned Comparison. Desktop still instantiates it in the main process and stays green.

**Blocked by:** 01 - Desktop Export CSV corrections, 02 - Internal database interface.

**Status:** ready-for-agent

- [ ] Node-independent query construction, storage schema, edit history, comparison orchestration, and result normalization live in shared modules that import neither Electron nor Node filesystem primitives (enforced by a lint or build rule, not convention).
- [ ] Database execution goes only through the internal database interface from ticket 02; file acquisition, export delivery, and Recent CSV Source storage sit behind internal host interfaces using CSV Viewer language and opaque source identity, not paths or handles.
- [ ] Every operation on the workspace surface is asynchronous and every request, result, and subscription event is structured-clone-safe - no live objects, callbacks inside results, or synchronous accessors (the surface must survive IPC on desktop).
- [ ] CSV Source identity is opaque at the shared surface; desktop maps canonical paths to it internally and retains one-Tab-per-known-source deduplication.
- [ ] The full existing desktop test suite passes with the workspace instantiated in the main process over the extracted modules.
