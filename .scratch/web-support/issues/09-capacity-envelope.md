# 09 - Web capacity envelope: enforcement, benchmarks, published limits

**What to build:** One conservative capacity envelope shared by all supported browsers, enforced before expensive work begins. Machinery first with injected test limits, then benchmark-derived numbers reviewed and published.

**Blocked by:** 08 - Web Export CSV + lifecycle.

**Status:** ready-for-agent

- [ ] The envelope is defined in input-byte terms: one per-source byte limit checked against the selected file's size before ingestion, and one whole-workspace budget covering open Working CSVs, export work, and Aligned Comparison artifacts.
- [ ] An open, export, or comparison operation that would exceed the envelope is rejected before allocating its expensive work; all existing Tabs and state are preserved.
- [ ] A capacity rejection is a domain outcome naming the applicable limit and directing the user to the desktop application.
- [ ] Export does not begin unless the budget accommodates output generation and handoff.
- [ ] Limits are injected constants, not adaptive heuristics: no per-browser, per-device, or available-memory variation, and no best-effort attempts above the envelope.
- [ ] Benchmark fixtures cover large, wide, long-cell, edited, multi-Tab, export, and Aligned Comparison workloads on representative low-end supported hardware and the weakest supported browser, recording peak memory, completion time, and failure behavior.
- [ ] The published per-source limit and workspace budget are set only from reviewed benchmark evidence, with regression fixtures immediately below each limit and rejection tests immediately above.
