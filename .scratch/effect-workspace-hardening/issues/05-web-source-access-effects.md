# 05 — Compose web CSV Source buffer access as Effects

**What to build:** Web CSV Source registration and release compose directly with scoped host acquisition, without converting Effects into Promises and immediately back, while browser startup, opening, release retries, and fatal-stop handling retain their behavior.

**Blocked by:** None — can start immediately.

**Status:** done

- [x] Browser buffer registration and release expose Effects directly. The web host yields those Effects while acquiring and releasing an engine-readable CSV Source reference.
- [x] Delete the replaced Promise wrappers and nested Effect runners. Keep raw driver Promises private to the runtime adapter and classify their failures once at that edge.
- [x] Adapt every caller and affected fixture to the final Effect surface. Keep source identity, capacity reservations, unreadable-source messages, and scoped source-release behavior unchanged.
- [x] Preserve failed-buffer-drop retention and retry behavior, startup cleanup, late startup cleanup reporting, fatal-stop settlement, and interruption guarantees. Do not add a new source lifetime or retry policy.
- [x] Existing web host, database, composition, startup/fatal-stop, buffer-release, and DuckDB-Wasm CsvViewer contracts pass with preserved assertions. Extend a focused runtime-edge test only if direct composition exposes a previously unproven release or interruption guarantee.
- [x] Typechecking, lint, both-engine shared contracts, the web build, and existing browser and built-bundle lifecycle tests pass. Inspect lifecycle screenshots. Update affected comments and ownership documentation without asserting runner counts or testing deleted wrappers.
- [x] As the recommended final implementation ticket, run the PRD's integrated checks against the combined changes: full tests, typechecking, lint, both builds, browser tests, and built-bundle lifecycle tests. Record the results and any manual verification still outstanding; add no separate verification-only smoke suite.

## Comments

- Approved breakdown; implementation has not started. Recommended fifth. This change can start independently and does not require a new error taxonomy, service layout, or function-style conversion.
- Reference APIs come from installed Effect 4.0.0-rc.115. This ticket does not upgrade Effect or make a browser compatibility claim.
- Kevin approved the ticket granularity on 2026-10-02. Scope and blocking edges remain as proposed.
- Implemented on 2026-10-02 against starting commit `fde277b77f92b8988f9adbacd1632fb07adb9627`. Buffer methods return typed Effects; production and contract hosts compose them directly. Direct adapter callers and the source-release failure fixture use the final surface. Resource ownership documentation describes driver classification and retained-buffer retries.
- Added one host/real-driver interruption scenario: hold a successfully registered buffer's driver response, interrupt scoped acquisition, then settle registration and prove the buffer was released while the database remains usable. This preservation test passed before and after the refactor; this ticket is a structural change, so no failing behavioral test was manufactured.

## Validation

- `pnpm exec vitest run apps/web/src/web-composition.test.ts`: 12 tests passed before the refactor.
- `pnpm exec vitest run apps/web/src/web-composition.test.ts apps/web/src/web-workspace-host.test.ts apps/web/src/duckdb-wasm-database.test.ts apps/web/integration/fixtures/wasm-workspace.test.ts`: 33 tests passed after the refactor.
- `pnpm test`: all 529 tests in 39 files passed, including shared CsvViewer contracts on native DuckDB and DuckDB-Wasm, diagnostics, source-drop retries, startup/late cleanup, and fatal-stop settlement.
- `pnpm run typecheck` and `pnpm run lint`: passed.
- `pnpm run build:desktop` and `pnpm run build:web`: passed. Vite still reports large bundle chunks and dependency-owned DuckDB-Wasm `eval` warnings.
- `pnpm run test:browser --workers=1`: all 9 tests passed, including opening/editing/export, drops, tab lifecycles, startup, fatal recovery, and navigation.
- `pnpm run test:browser:built --workers=1`: both emitted-bundle lifecycle tests passed.
- Inspected dev and built checking, unsupported, fatal, and recovered screenshots, plus dev navigation screenshots under `test-results/`. No visible defects found.
- These integrated results cover the current tree. Issue 4 remains a separate pending ticket; this does not mark the entire PRD complete.
- Manual follow-ups from the PRD remain: native Export CSV dialogs and quit/menu behavior with human interaction, and a comparable-hardware Working CSV latency refresh after the final migration. No unsupported-browser compatibility claim is made.

## Standards

No documented-standard violations or actionable baseline smells found. The adapter retains raw driver Promises and typed failure classification; the host composes Effects directly. Replaced wrappers are deleted without new abstractions or retry policies. The interruption test observes real buffer release and continued engine usability, and restores its driver spy and closes the database in `finally`.

## Spec

No missing requirements, incorrect behavior, or scope creep found. Every buffer caller and fixture uses the final Effect surface. Source identity, capacity reservations, unreadable-source messages, retained-drop retries, startup cleanup, and fatal-stop settlement remain unchanged. The new test deterministically requests interruption before settling registration, then verifies scoped release.

Review against the starting commit, including uncommitted changes: Standards 0 findings; Spec 0 findings. Neither axis has an outstanding issue.
