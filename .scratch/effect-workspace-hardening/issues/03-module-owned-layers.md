# 03 — Give workspace capabilities their own interfaces and Layers

**What to build:** Each workspace capability owns its contract and construction, the composition root composes those Layers, and the same CsvViewer request paths work on both runtimes with unchanged resource lifetimes.

**Blocked by:** 02 — Make declared workspace failure categories enforceable. Define the final service interfaces against those precise failure contracts.

**Status:** ready-for-agent

- [ ] The Working CSV, Comparison, host, and database capability modules own their service tags and explicit interfaces. Service interfaces do not require concrete implementation instances or expose private fields.
- [ ] Each owning module defines its construction Layer with typed dependency requirements. The composition root supplies runtime-specific implementations and composes those Layers without knowing private implementation constructors.
- [ ] Retain private classes and synchronous mutable bookkeeping where useful. Do not introduce a generic service graph, accessor proxy, speculative interfaces, or a wholesale closure-based rewrite.
- [ ] Preserve a single shared acquisition of the database and each workspace capability, background Comparison scope ownership, disposal ordering, and explicit reporting of finalizer release failures. Preserve startup interruption, fatal-stop handling, and admitted-work draining.
- [ ] Keep the manual workspace scope and entry runners. Do not substitute ManagedRuntime, which would change disposal behavior for tracked request fibers.
- [ ] Adapt existing tests and overrides to the owning module's Layer or construction Effect and narrow capability implementations. Remove superseded exports and constructor compatibility surfaces; avoid unsafe casts to satisfy new interfaces.
- [ ] Existing shared CsvViewer contracts on native DuckDB and DuckDB-Wasm, composition, startup, fatal-stop, and lifecycle tests pass with preserved assertions. Typechecking, lint, both builds, and existing browser and built-bundle lifecycle tests pass. Inspect lifecycle screenshots and update affected ownership documentation.

## Comments

- Approved breakdown; implementation has not started. Recommended third. Ticket 01 is execution priority, not a blocking edge for this structural change.
- Keep one composition root. The intended improvement is local construction knowledge and replaceable contracts, not a larger architecture.
- Kevin approved the ticket granularity on 2026-10-02. Scope and blocking edges remain as proposed.
