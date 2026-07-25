Label: wayfinder:map

# Find the Way to an Implementation-Ready Aligned CSV Comparison Specification

## Destination

An implementation-ready specification for persistent, read-only Comparison Tabs that align two Comparison-Compatible Working CSVs using an explicit, validated Comparison Key and present exact row and cell differences without materializing full files in the renderer.

**Reached:** [Aligned CSV Comparison — Implementation-Ready Specification](spec.md)

## Notes

- Domain language: [CSV Viewer context](../../CONTEXT.md).
- Consult `/prototype`, `/codebase-design`, `/domain-modeling`, and `/grilling` while resolving tickets.
- Preserve the existing Electron main-process ownership of DuckDB-backed Working CSVs and bounded renderer row windows.
- Standing product constraints: explicit Compare action; Candidate selection before entering a Comparison Tab; key selection and reconfiguration inside the Comparison Tab; Apply key and explicit Refresh comparison actions; complete Working CSV scope independent of source queries; exact text equality; differences-first and changed-columns-first presentation; one Comparison Tab per CSV Tab pair; cancellable background work; dependent-close confirmation.

## Decisions so far

- [Comparison Tab interaction contract](issues/01-choose-comparison-tab-interaction-contract.md): Candidate-first entry, persistent aligned grid, draft versus applied key, atomic result replacement, explicit refresh, preserved Outdated results, source navigation, and dependent-close behavior.
- [Comparison execution model](issues/02-choose-comparison-execution-model.md): staged materialized result snapshots on dedicated cancellable DuckDB connections, guarded by Working CSV revisions and exposed only through summaries and bounded windows.
- [Comparison data module interface](issues/03-design-comparison-data-module-interface.md): one workspace-owned comparison facet with explicit ID-based intentions, token-scoped operations, versioned Comparison projections, indexed result windows, exact confirmed-impact close, and typed outcomes.
- [Comparison verification contract](issues/04-define-comparison-verification-contract.md): workspace-interface correctness matrix, deterministic lifecycle fault control, bounded performance criteria without a total-time gate, WCAG 2.2 AA, bounded diagnostics, and a three-pass manual release gate.

## Not yet specified

- Nothing required for implementation. Sequencing and migration impact are specified in [the implementation plan](spec.md#10-migration-and-implementation-sequence).

## Out of scope

- Editing either Working CSV from a Comparison Tab.
- Exporting comparison results.
- General search or filtering of comparison results beyond the Differences/All rows and Changed/All columns presentation toggles.
- Comparing CSVs with different column-name sets or coercing schemas to match.
- Automatically inferring a Comparison Key or falling back to row position.
- Comparing more than two Working CSVs in one Comparison Tab.
