# 05 — Compose web CSV Source buffer access as Effects

**What to build:** Web CSV Source registration and release compose directly with scoped host acquisition, without converting Effects into Promises and immediately back, while browser startup, opening, release retries, and fatal-stop handling retain their behavior.

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [ ] Browser buffer registration and release expose Effects directly. The web host yields those Effects while acquiring and releasing an engine-readable CSV Source reference.
- [ ] Delete the replaced Promise wrappers and nested Effect runners. Keep raw driver Promises private to the runtime adapter and classify their failures once at that edge.
- [ ] Adapt every caller and affected fixture to the final Effect surface. Keep source identity, capacity reservations, unreadable-source messages, and scoped source-release behavior unchanged.
- [ ] Preserve failed-buffer-drop retention and retry behavior, startup cleanup, late startup cleanup reporting, fatal-stop settlement, and interruption guarantees. Do not add a new source lifetime or retry policy.
- [ ] Existing web host, database, composition, startup/fatal-stop, buffer-release, and DuckDB-Wasm CsvViewer contracts pass with preserved assertions. Extend a focused runtime-edge test only if direct composition exposes a previously unproven release or interruption guarantee.
- [ ] Typechecking, lint, both-engine shared contracts, the web build, and existing browser and built-bundle lifecycle tests pass. Inspect lifecycle screenshots. Update affected comments and ownership documentation without asserting runner counts or testing deleted wrappers.
- [ ] As the recommended final implementation ticket, run the PRD's integrated checks against the combined changes: full tests, typechecking, lint, both builds, browser tests, and built-bundle lifecycle tests. Record the results and any manual verification still outstanding; add no separate verification-only smoke suite.

## Comments

- Approved breakdown; implementation has not started. Recommended fifth. This change can start independently and does not require a new error taxonomy, service layout, or function-style conversion.
- Reference APIs come from installed Effect 4.0.0-rc.115. This ticket does not upgrade Effect or make a browser compatibility claim.
- Kevin approved the ticket granularity on 2026-10-02. Scope and blocking edges remain as proposed.
