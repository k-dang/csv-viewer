Parent: [Find the Way to an Implementation-Ready Aligned CSV Comparison Specification](../map.md)
Type: prototype
Status: resolved
Blocked by: None

# Choose the Comparison Tab Interaction Contract

## Question

What exact layout, controls, and transitions should the Comparison Tab expose for initial key setup, key validation, applying a new key, comparing, results, outdated results, refresh, cancellation, failure, swapping sides, source-row navigation, and dependent-close warnings?

Use a throwaway UI prototype against the existing populated application surface. Preserve the selected Aligned Comparison direction and the agreed presentation toggles, but stress-test narrow and wide CSVs plus the interaction between current results and pending key changes.

## Comments

### Resolution

The throwaway prototype is [comparison-tab-prototype.html](../prototypes/comparison-tab-prototype.html). It models initial setup, validation, comparison, results, outdated results, invalid-key recovery, refresh failure, and cancellation against the current header, tab strip, cards, and horizontally scrolling grid. Browser automation was unavailable in this workspace, so the contract below is based on the interactive prototype source and existing rendered application structure rather than automated screenshot assertions.

#### Entry and Tab identity

- The explicit **Compare…** action is available when a CSV Tab is active. That Working CSV is the proposed Baseline.
- Compare first opens a Candidate picker; it does not create a Comparison Tab until the user selects another open CSV Tab.
- The picker lists Comparison-Compatible CSVs first. Incompatible CSVs remain visible but disabled with the mismatched column names explained. The action is unavailable when no other CSV Tab is open.
- A CSV Tab pair has at most one Comparison Tab, regardless of direction. Selecting a pair that already has one focuses it and preserves its existing Baseline/Candidate direction, applied key, draft key, and view state.
- A Comparison Tab uses a distinct comparison glyph and a compact `Baseline ⇄ Candidate` label. CSV dirty markers remain on their CSV Tabs; outdated state gets an amber marker on the Comparison Tab.

#### Persistent layout

The Comparison Tab is one aligned workspace, not two independent grids:

1. A fixed configuration header shows Baseline and Candidate file cards, **Swap sides**, **Refresh comparison**, the draft Comparison Key selector, and **Apply key**.
2. A status region directly below the header owns outdated, progress, validation, cancellation, and failure messages. State changes are announced through a polite live region; failures use an assertive alert.
3. When results exist, a summary/toggle bar and a single virtualized result grid fill the remaining height.
4. Before the first successful Apply key, an instructional empty state fills the result area while key controls remain in the fixed header.

Controls wrap below the file cards at the application's minimum width. The result grid always scrolls horizontally instead of collapsing an aligned row into cards. Narrow CSVs stretch naturally; wide CSVs keep the result classification and key columns pinned while paired value columns scroll.

#### Key draft, Apply key, and Refresh

- `draft key` is renderer input only. Changing it never mutates the applied key or current results.
- **Apply key** requires at least one selected column. It validates the draft key against both complete Working CSVs and, when valid, computes a replacement result in the same cancellable operation.
- The applied key and active result snapshot change together only after the replacement is complete. Invalid keys, cancellation, failure, or a source change during the operation leave both untouched.
- Key diagnostics identify Baseline versus Candidate and report blank-row and duplicate-group counts, with bounded example keys/row references. They appear under the selector and remain until the draft changes or Apply key is retried.
- **Refresh comparison** always uses the applied key, never an unapplied draft. It is disabled until a result has been applied.
- If no prior result exists, progress replaces the empty state. If a prior result exists, it stays readable while a progress banner says that a replacement is being prepared.
- **Cancel** is shown only during validation/comparison. Cancellation returns to setup when there is no prior result; otherwise it preserves the prior result and shows a dismissible confirmation.
- Initial failure presents a retryable empty error state. Replacement failure presents an inline error while preserving the prior result.

#### Results and presentation toggles

- The summary reports Changed, Baseline-only, Candidate-only, Unchanged, and total row counts plus per-column changed-row counts.
- The rows toggle is **Differences** (default: Changed + Baseline-only + Candidate-only) or **All rows**.
- The columns toggle is **Changed first** (default) or **All in CSV order**. It changes ordering, not membership: key columns appear once and all non-key columns remain available. Changed first orders columns with changes by changed-row count descending, then preserves Baseline column order for ties; columns with zero changes follow in Baseline order.
- Grid order is deterministic Comparison Key ascending using exact binary text order. A result row contains classification, the key columns once, and a Baseline/Candidate subcolumn pair for every non-key column.
- Changed paired cells receive complementary, non-color-only old/new treatment. Equal paired cells remain neutral. The missing side of a Baseline-only or Candidate-only row is explicitly labelled, never rendered as an empty value. Null and empty string retain distinct renderings.
- Row and cell copy actions copy displayed exact values. Editing and export actions are absent.

#### Outdated results and source navigation

- Any successful Working CSV edit, insert, delete, undo, redo, or session replacement marks dependent results Outdated immediately. Current results, applied key, draft key, and toggles remain usable.
- The outdated banner names which source changed. **Refresh comparison** is always explicit; switching tabs or changing source query state never refreshes.
- **Swap sides** is disabled during background work. Otherwise it immediately reorients the active snapshot and summary without recomputation: Baseline-only/Candidate-only labels flip, paired columns flip, and source actions remap. It does not clear Outdated state or alter key/toggle state.
- Each result row exposes **Open Baseline row** and/or **Open Candidate row** in a row action menu. It focuses the source CSV Tab and row without changing that Tab's query state. If the row is hidden by its current query, the CSV Tab shows a banner offering the explicit action **Clear query and reveal row**. If an outdated row no longer exists, the app reports that fact and leaves source state unchanged.

#### Dependent close

- Closing a Comparison Tab needs no confirmation and cleans up its background work and snapshots.
- Closing a source CSV Tab with dependent Comparison Tabs shows one confirmation naming all dependents. The destructive action is **Close CSV and comparisons**; **Cancel** is the safe default. Unsaved-edit loss is included in the same confirmation rather than followed by a second dialog.
- Confirmed dependent close cancels work, closes the dependent Comparison Tabs, then closes the CSV session. A failure before the source closes leaves all still-live Tabs represented in the renderer.
