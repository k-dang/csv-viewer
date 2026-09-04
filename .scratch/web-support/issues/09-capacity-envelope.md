# 09 - Capacity envelope and web responsiveness benchmarks

**What to build:** One conservative capacity envelope shared by all supported browsers, enforced before expensive work begins. Machinery comes first with injected test limits, followed by reviewed benchmark-derived numbers.

**The envelope counts admitted source bytes, not memory.** Browser engine memory is not observable from the page: `performance.measureUserAgentSpecificMemory()` is Chromium-only and requires cross-origin isolation, which this release forbids. The limit is a conservative proxy for engine memory, set well below the observed failure point so that derived tables, edit history, comparison artifacts, and export buffers are covered by the margin rather than accounted for individually. Nothing in the implementation or the user-facing copy may claim to measure memory.

**Blocked by:** 08 - Web Export CSV + lifecycle.

**Status:** ready-for-agent

- [ ] The envelope is defined purely in input-byte terms: one per-source byte limit checked against the selected file's size before ingestion, and one whole-workspace budget over the summed byte size of admitted CSV Sources.
- [ ] Export and comparison operations are admitted or rejected against that same source-byte budget with a documented margin, not against an estimate of their own allocation. The margin's derivation from benchmark evidence is recorded.
- [ ] An open, export, or comparison operation that would exceed the envelope is rejected before allocating its expensive work; all existing Tabs and state are preserved.
- [ ] A capacity rejection is a domain outcome naming the applicable limit and directing the user to the desktop application.
- [ ] The capacity outcome is added to the shared result unions in `packages/workspace/src/contracts/csv-viewer.ts`. `OpenCsvResult`'s existing `failed` arm carries only a message and cannot name a limit, so this is a contract change that desktop also carries over IPC; both runtimes must handle the new arm.
- [ ] User-facing rejection copy states the limit in source-file terms - "CSV Viewer Web supports up to N MB of open CSV files" - and never claims to be measuring memory or predicting a crash.
- [ ] Limits are injected constants, not adaptive heuristics: no per-browser, per-device, or available-memory variation, and no best-effort attempts above the envelope. One envelope derived from the weakest supported browser applies everywhere; the tradeoff that stronger browsers are held to it is accepted and stated.
- [ ] Benchmark fixtures cover large, wide, long-cell, edited, multi-Tab, export, and Aligned Comparison workloads on representative low-end supported hardware and the weakest supported browser, recording completion time and the observed failure point. Engine memory is recorded only where out-of-band native profiling tooling can observe it; no in-page memory measurement is added.
- [ ] Measure foreground responsiveness on the Wasm engine during each relevant overlap: browse and search an existing Tab during a large Aligned Comparison; use an existing Tab while another CSV Source opens; browse during a large Export CSV; and switch Tabs while Column Value Counts are calculating. Each run proves the foreground result is correct and the background operation completes or cancels without publishing partial state.
- [ ] The published per-source limit and workspace budget are set only from reviewed benchmark evidence, with regression fixtures immediately below each limit and rejection tests immediately above.
