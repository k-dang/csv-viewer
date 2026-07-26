Parent: [Find the Way to an Implementation-Ready Aligned CSV Comparison Specification](../map.md)
Type: grilling
Status: resolved
Blocked by: 01, 02, 03

# Define the Comparison Verification Contract

## Question

What observable correctness, responsiveness, cancellation, memory, lifecycle, accessibility, and manual-validation criteria must the implementation-ready specification require?

Define the fixture and scenario matrix through the chosen module interface and visible UI states. Include composite and invalid keys, exact cell equality, all four result classifications, source edits and outdated refresh, swapped sides, source close dependencies, bounded large-file windows, failure recovery, and the explicitly out-of-scope behaviors.

## Comments

### Confirmed decision 1: hardware-independent performance and boundedness

Do not impose an absolute total Apply key or Refresh duration. Completion time depends on hardware, row width, string size, and dataset shape; record it during manual validation only to notice gross regressions on the same reference machine.

Enforce these observable budgets instead:

- every Comparison result-window request and IPC response is capped at 1,000 rows;
- the Comparison AG Grid uses 100-row cache blocks, at most six cached blocks, and at most two concurrent result-window requests;
- after the user requests Cancel, the operation reaches a terminal cancelled outcome and removes its staging artifacts within two seconds on the reference stress fixture;
- while comparison work runs, Tab switching remains immediate and an already-open source CSV can obtain and render a normal row window within one second on the reference stress fixture;
- five consecutive successful Refresh operations do not show monotonically increasing renderer or DuckDB memory after cleanup and settling; measurement uses a documented tolerance rather than exact byte equality;
- repeated invalid Apply, failed Refresh, Cancel, result replacement, Comparison close, source cascade close, and workspace disposal leave no unowned DuckDB tables, worker/read connections, listeners, or pending operations; and
- a manual stress fixture compares two one-million-row Working CSVs with a two-column composite key, 20 non-key columns, Changed, Baseline-only, Candidate-only, and Unchanged rows.

Automated tests assert structural bounds and artifact ownership deterministically. Manual stress validation records total generation time, peak/settled main-process memory, renderer heap, cancellation latency, and concurrent window latency for comparison between runs, but total generation time is not a pass/fail threshold.

### Confirmed decision 2: workspace interface is the correctness test surface

Authoritative comparison behavior is tested through the same `CsvWorkspace` interface used by Electron main-process adapters. These integration tests use real in-memory DuckDB and temporary CSV fixtures. They assert only observable states, typed outcomes, versioned events, summaries, result windows, close results, and post-close behavior—not SQL strings, table layouts, query-builder calls, or other implementation details.

Verification layers have distinct responsibilities:

- main-process workspace tests prove compatibility, key validation, exact equality, classification, revisions, immutable replacement, cancellation, swapping, bounded windows, dependencies, and cleanup;
- IPC adapter tests prove serializable requests/outcomes and forwarding of versioned Comparison events without re-testing comparison semantics;
- renderer tests use a fake preload interface to prove React reconciliation, draft/applied separation, toggle projection, stale version/result-token rejection, interaction states, and accessibility;
- a small end-to-end or manual smoke path proves that two opened CSVs can enter a Comparison Tab and produce visible results; and
- manual validation owns visual alignment, keyboard flow, wide-column usability, dependent-close dialog wording, and the reference stress run.

Private SQL/staging helpers do not receive a duplicate behavioral suite. Isolated pure helpers may have focused tests when useful, but internal refactoring must not require rewriting the authoritative interface scenarios.

### Confirmed decision 3: minimum correctness scenario matrix

The automated workspace suite must cover this matrix with explicit expected summaries, outcomes, events, and exact result rows. Expected data is fixture-authored; tests must not calculate their oracle using a second comparison implementation.

| Area | Required scenarios |
|---|---|
| Compatibility | Same names in different orders; missing/extra names; identical source selected twice; SQL-significant and unusual names |
| Keys | Valid single and composite keys; key-only CSV; null/empty parts; duplicate single/composite values; invalidity on either side |
| Exact cells | Null/null; null/empty; case; whitespace; leading zeros; literal `NULL`; delimiters, quotes, and embedded newlines |
| Classifications | Changed, Unchanged, Baseline-only, and Candidate-only in one fixture, plus no-difference and every-row-different fixtures |
| Ordering | Composite key binary order; changed-column counts; changed-first ties by current Baseline order; final partial window |
| Mutations | Edit, insert, delete, undo, redo, and replacement cause Outdated; query/view/Stats/Save As/activation changes do not |
| Replacement | Apply/Refresh atomic success; invalid key, cancel, failure, and sources-changed preserve the previous key/result |
| Concurrency | Busy rejection; token-scoped late Cancel; stale entity-version and result-token rejection |
| Swap | Orientation, one-sided classifications, summary labels, paired cells, source mappings, ordering, and token reorientation without recomputation |
| Lifecycle | Comparison close; exact-impact source close; changed impact; close during work/read; idempotent workspace disposal |
| Boundaries | Zero rows; one row; key-only columns; no differences; every row different; zero and maximum window sizes |
| Out of scope | No inference, row-position matching, coercion, edit, export, arbitrary result filtering, or three-way comparison |

Invalid-key fixtures assert complete blank-row and duplicate-group counts plus bounded examples in deterministic source/key order. Large/stress fixtures supplement this matrix but never replace small fixtures whose expected rows are easy to audit.

### Confirmed decision 4: private scripted executor for deterministic lifecycle tests

The workspace implementation may depend internally on a `ComparisonExecutor` seam with two adapters:

- the production DuckDB adapter performs real validation, staging, summarization, interruption, and cleanup; and
- a scripted test adapter can pause at a reported phase, observe cancellation, return a selected normalized failure, and release or complete on command.

Lifecycle tests still drive and assert behavior exclusively through the public `CsvWorkspace` interface. The scripted adapter makes Cancel during every phase, source mutation immediately before publication, close during generation, staged failure, cleanup failure, and obsolete late completion deterministic instead of depending on dataset size or scheduler timing.

This internal seam is not a public database port and does not expose SQL/table mechanics. The primary correctness matrix uses the real DuckDB adapter. Separate real integration cases prove that `interrupt()` stops an actual worker query, the owner/read path remains usable, and real staging/retired artifacts are eventually removed.

### Confirmed decision 5: WCAG 2.2 AA interaction verification

The Comparison workflow targets WCAG 2.2 AA. Automated renderer checks plus a Windows keyboard and NVDA smoke pass verify:

- Compare, Candidate selection, key selection, Apply, Refresh, Cancel, Swap, row/column toggles, cell-copy actions, and close confirmation are keyboard operable;
- Candidate and close dialogs have names/descriptions, trap focus, support safe Escape cancellation, and restore focus to the invoker;
- initial setup focuses the key selector, while invalid Apply focuses its diagnostic summary without hiding reachable examples;
- progress phase changes use a polite live region, failures use an alert, and updates do not flood announcements;
- changed cells, row classifications, null, empty string, and absent sides remain distinguishable without color and have distinct spoken text;
- paired headers expose both column name and Baseline/Candidate side;
- text meets 4.5:1 contrast and controls, focus indicators, and meaningful non-text visuals meet 3:1 in both themes;
- focus remains visible and stable across result replacement, Outdated transitions, cancellation, failure, Tab switching, and close;
- at 200% zoom configuration controls wrap and remain reachable, with horizontal scrolling confined to the aligned grid; and
- reduced-motion preference removes nonessential animation while phase/status text remains available.

Manual NVDA coverage includes initial setup, invalid key, results and changed cells, Baseline/Candidate-only rows, Outdated results, progress/cancellation, source navigation, and the combined dependent-close dialog.

### Confirmed decision 6: bounded, non-overlapping key diagnostics

Per source, invalid-key diagnostics return complete `blankRowCount` and `duplicateGroupCount` values plus bounded evidence:

- at most five blank-row examples, ordered by Working CSV source order;
- at most five duplicate-group examples, ordered by composite key in exact binary text order; and
- at most five row IDs per duplicate example, ordered by source order, with the group's complete row count retained.

A blank row has at least one null or empty-string key part. Duplicate grouping considers only rows whose key parts are all present, so one row is not reported in both categories. Diagnostics remain separate for Baseline and Candidate and preserve each key part as exact `string | null`. The renderer states when examples are truncated while always displaying the complete counts.

### Confirmed decision 7: three-pass manual release gate

Manual release validation has three focused passes rather than replaying every automated edge case:

1. **Functional golden journey** — Candidate compatibility and pair reuse; initial setup; invalid then valid composite key; all classifications and exact null/empty display; result-cell emphasis and cell copy; summaries/toggles; unapplied draft; Outdated preservation and Refresh; Cancel/retry; Swap; direct Comparison close; and combined dirty/dependent source close.
2. **Visual and accessibility** — light/dark, narrow/wide CSVs, horizontal grid scrolling, 200% zoom, reduced motion, keyboard-only completion, focused NVDA coverage, and non-color-only differences.
3. **Stress and lifecycle** — million-row fixture, distant bounded windows, concurrent source use, cancellation latency, five Refresh cycles and settled memory, close during work, and final quit with no live operations/connections/artifacts.

Failure-state presentation uses the scripted executor in a test harness; packaged release builds contain no fault-injection control. Total generation time and memory observations are recorded for comparison with prior runs, while only the structural/latency budgets in decision 1 are pass/fail requirements.

### Resolved verification contract

An implementation is acceptable only when the authoritative workspace suite, IPC adapter checks, renderer interaction/accessibility checks, build/typecheck, three manual passes, and structural stress criteria all pass. A skipped required matrix row is a verification gap, not an implicit pass. Expected out-of-scope behavior is verified by the absence or rejection of those controls and intentions.
