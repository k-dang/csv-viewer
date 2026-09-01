# 07 - Web composition root tracer bullet

**What to build:** CSV Viewer opens in a browser as a static site. A startup capability check gates file selection, the user picks one local CSV Source through a portable file input, and the full shared workspace works: grid, sorting, filtering, search, Stats Panel, editing, undo/redo, and Aligned Comparison - all in-memory, nothing uploaded.

**Blocked by:** 04 - CsvViewer seam, 06 - DuckDB-Wasm adapter.

**Status:** done

- [x] A separate web composition root wires the shared renderer to an in-page CsvWorkspace over the Wasm adapter; desktop packaging and the web build remain separate outputs over the same shared modules.
- [x] A startup check verifies the actual Worker and Wasm features the pinned build needs before enabling file selection; an unsupported browser gets a clear state listing supported browsers and the desktop fallback.
- [x] File selection opens exactly one CSV Source per picker action, reusing the existing CSV, TSV, and text acceptance rules; delimiter and header overrides work.
- [x] A browser selection receives runtime-scoped opaque identity: sameness is never inferred from name, size, timestamp, or content, and the same physical file may open in more than one Tab.
- [x] Recent CSV Sources are absent from the rendered web experience via the explicit capability, and the user is told files must be selected again after reload.
- [x] Opening a CSV Source creates and focuses a CSV Tab; row windows stay bounded; Column Value Counts and Live Stats use the same Count Scope as desktop.
- [x] Two open Working CSVs can run a full Aligned Comparison - key validation, classification, summaries, windows, swap, refresh, Outdated behavior - identically to desktop.
- [x] All engine assets load self-hosted from the static artifact; no runtime CDN requests.
