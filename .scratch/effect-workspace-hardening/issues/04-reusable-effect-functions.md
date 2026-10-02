# 04 — Use reusable Effect functions consistently in Working CSV

**What to build:** Working CSV and table operations use the same reusable Effect function conventions as Comparison, while the complete request path preserves failure types, scoped requirements, interruption behavior, and diagnostic stages.

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [ ] Use fnUntraced for reusable multi-step generator functions in Working CSV and table operations where existing stages already provide tracing. Use named fn only at a useful tracing seam without duplicating existing stages.
- [ ] Keep Effect.gen for inline workflows and callbacks. Leave simple forwarding functions and combinator-only helpers simple, and keep pure query construction, result normalization, edit-history calculations, and serialization ordinary functions.
- [ ] Preserve receivers, generic parameters, exact failure types, scoped requirements, queue position, leases, admission, and interruption behavior. Attach function-level transforms using the installed Effect API.
- [ ] Keep all diagnostic stage names, outcomes, attributes, timings, cleanup classification, and privacy rules. Do not add tracing of SQL, source references, names, paths, columns, cell values, or raw driver errors.
- [ ] Remove the replaced reusable generator wrappers without leaving parallel implementations or conversion helpers. Update comments where their description changes.
- [ ] Existing shared CsvViewer contracts on both engines, Working CSV editing/history, diagnostics, and interruption tests pass. Typechecking and lint pass. Add behavioral tests only for an uncovered behavior encountered during the change, not for fn usage or wrapper deletion.

## Comments

- Approved breakdown; implementation has not started. Recommended after ticket 03 to avoid rewriting functions twice if service construction moves them; this is a scheduling preference rather than a correctness dependency.
- Existing Comparison fnUntraced functions provide local prior art. This ticket can land green against the current class-based implementation.
- Kevin approved the ticket granularity on 2026-10-02. Scope and blocking edges remain as proposed.
