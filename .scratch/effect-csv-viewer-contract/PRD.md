Status: draft

# Validated CsvViewer requests and consistent failure messages

**Blocked by:** Ticket 04 in `.scratch/effect-workspace-adoption/issues/`. This spec decodes and translates failures in the shared entry adapter, and 04 is the ticket that sends every CsvViewer request through it.

## Problem Statement

On desktop, the Electron main process accepts CsvViewer requests from the renderer over IPC. `registerCsvViewerRequestHandler` checks only that the envelope has a string `operation`. It then casts the payload to `CsvViewerRequest`. Its `SAFETY` comment says the dispatcher validates each operation's fields, but many fields are never checked:

- `csv.edit-cell` binds `value` into SQL without checking its type.
- A non-string `csv.rename-column` `name` throws a `TypeError` at `.trim()`.
- A non-array `rowIds` throws at `.map`.
- Unknown `placement` values and sort `direction` values fall back silently.
- `hasActiveQuery`, `options.header`, `search`, and filter values are never checked.

The request types in `packages/workspace/src/csv-viewer.ts` exist only at compile time.

Failure messages also differ between runtimes. The store throws plain `Error` objects whose messages are meant for users, and the renderer displays `error.message` from rejected calls. On web, the user reads that message. On desktop, Electron's `ipcRenderer.invoke` always rejects with `Error invoking remote method '<channel>': <original error>`, and no code removes the prefix. For example, renaming a column to a blank name in the column menu shows "Error invoking remote method 'csv-viewer:request': Error: CSV column name cannot be blank." on desktop. The same applies to every rejected request on desktop, including stats, copy column, Export CSV, Comparison actions, and the dropped-file channel.

The entry adapter also passes through whatever an unexpected defect throws, for example a raw `TypeError` message. Nothing separates the failures a user should read from defects the user should not see.

## Solution

Define every CsvViewer request with Effect Schema and derive the request types from those schemas. The shared entry adapter decodes each request before dispatch on both runtimes. A malformed request is rejected with one sanitized message before it reaches the store.

Represent expected workspace failures with tagged errors and preserve the existing host and database error classes. Adapt expected failures into Effect's failure channel and keep unexpected errors as defects. The entry adapter rejects an expected failure with its existing user message and rejects a defect with one generic message. The desktop IPC channels return a sanitized failure as a value, and the preload rethrows it as `new Error(message)`. The renderer then receives the same message on both runtimes.

The public contract keeps its current shape. Requests, results, events, and the rule that expected failures reject stay the same.

## User Stories

1. As a maintainer, I want one definition of each CsvViewer request, so that its type and its runtime validation cannot drift apart.
2. As a maintainer, I want the workspace to reject malformed requests before dispatch, so that the store never runs on fields it did not validate.
3. As a maintainer, I want desktop and web to accept and reject exactly the same requests, so that validation does not depend on the runtime.
4. As a maintainer, I want expected failures represented in Effect's failure channel, so that the entry adapter and diagnostics can distinguish them from defects and interruption without reading message text.
5. As a user, I want the same failure message on desktop and web for the same failed action, so that the runtime does not change what I read.
6. As a user, I want defects to show a plain message and not internal error text, so that I am not shown engine or programming details.
7. As a user, I want every action that works today to keep its results and messages, so that this change does not affect me.

## Implementation Decisions

### Request schemas

- Define Effect Schema values for every request in `CsvViewerOperationMap`, including their nested types: dialect options, sort, filter, and Comparison request fields. Derive the request types from them and keep the existing field names and shapes.
- Name each schema constant the same as the type it defines, for example `const CsvRowWindowRequest = Schema.Struct(...)` with `type CsvRowWindowRequest = typeof CsvRowWindowRequest.Type`. Do not use the word "schema" in these names, because "schema" already means the CSV column structure in this codebase (`CsvSchemaEditState`, `csv-storage-schema.ts`).
- Put the request schemas in their own module in `packages/workspace`. `csv-viewer.ts` re-exports their types with `export type`. The desktop renderer imports runtime values from `csv-viewer.ts` and does not bundle Effect today. It must not start bundling Effect.
- Result, event, and capability types stay as hand-written TypeScript types. Results and events come from the owning process, which the renderer already trusts, and nothing decodes them.
- Identifiers stay plain strings. The schema does not check their format and does not brand them.
- Match what the renderer sends today:
  - Use `Schema.optional` for optional fields. The renderer sends explicit `undefined` keys, such as `valueTo: undefined` on number filters, and `Schema.optionalKey` rejects them.
  - Use `Schema.Number` for filter values, which accepts `NaN`, because the renderer can send `Number(model.filter)`.
  - Keep the default handling of excess keys, which ignores them.
- Accept the readonly types that Schema derives. Change consumers that take mutable arrays, such as `normalizeRowIds` and `validateKeySelection`, to accept readonly arrays. Do not use `Schema.mutable`.

### Where each rule lives

- The schema checks presence, value kinds, literal enumerations such as `placement`, sort `direction`, and filter operators, and non-negative integers for Working CSV row window `offset` and `limit`.
- A rule that has a declared fault or an asserted message today stays where it is. These rules stay in place:
  - `comparison.get-window` returns `invalid-window` after its `comparison-not-found` and `result-replaced` checks. Its schema checks `offset` and `limit` only as numbers.
  - `comparison.begin` returns `invalid-key-shape` for an empty or duplicate Comparison Key. Its schema accepts any string array.
  - The `csv.insert-row` rules about selected rows and active queries keep their messages in the store.
  - The `csv.get-rows` maximum limit keeps its `1000 or less` message in the store.
  - Domain rules that depend on Working CSV state stay in the store, such as blank, reserved, or duplicate column names, and deleting the last column.
- A new structural rejection is allowed only when no request the current renderer sends is rejected. Rejecting an unknown `placement` or sort `direction` meets this rule.

### Decoding and dispatch

- Add an owner-side entry, `CsvWorkspaceOwner.receive(payload: unknown): Promise<unknown>`, that decodes and then dispatches. `call` delegates to `receive`. The desktop IPC handler takes a `CsvWorkspaceOwner` and calls `receive` with the raw payload, with no cast.
- Web and the shared contract suites keep calling `call`, so the web runtime decodes every request the same way desktop does.
- Decode before any span is named. A decode failure records one fixed stage, `csv-viewer.request`, with a new allowlisted outcome, `malformed-request`, and no identifiers. The request's `operation` value never becomes a span name or log message unless it decoded.
- A malformed request, including an unknown operation, rejects with `Malformed CSV Viewer request.`. The rejection does not include the decode error text, because Schema issue messages include field paths.
- Compare a confirmed `CloseImpact` in `csv.close` with `Schema.toEquivalence` of its request schema. Decoding rebuilds objects, and the current `JSON.stringify` comparison depends on key order, so a decoded impact could fail to match and repeat close confirmation forever. `WorkspaceCloseImpact` is never decoded and keeps its current comparison.

### Expected failures and defects

- Mark expected workspace failures with `Data.TaggedError`. These errors never cross the transport, so `Schema.TaggedError` is not needed. Reuse a tag for validations with the same recovery and diagnostic handling; do not create a class for every message. Cover deliberate user-facing validation failures, including:
  - the store's lifecycle, lookup, and edit validation throws
  - `csv-query.ts` (unknown CSV column)
  - `csv-working-csv-table.ts` (CSV row no longer exists)
  - `csv-edit-history.ts` (no edit to undo or redo)
- `DataEngineError` and `CsvSourceUnavailableError` keep their existing classes and sanitized messages. Recognize them by `instanceof` when adapting thrown values; they do not need new tags solely for consistency with workspace errors. Broken invariants and unexpected exceptions remain defects.
- At each synchronous or Promise adapter into Effect, put recognized expected errors in the typed failure channel and preserve unexpected errors as defects. Native Effect code fails explicitly for expected conditions. Merely throwing a `Data.TaggedError` inside `Effect.sync` or rejecting inside `Effect.promise` produces a defect; default `Effect.tryPromise` wraps a rejection in `UnknownError`. Neither is sufficient for preserving expected errors. Apply this conversion where the operation enters Effect, before its stages record diagnostics.
- The entry adapter inspects `Exit` and `Cause` before squashing a cause or constructing a Promise rejection. A single recognized expected failure rejects with its existing message. Defects, interruption, and multiple causes, including an `AggregateError`, reject with `The CSV workspace could not complete the request.`. Do not recover a defect as an expected failure solely because its value has a recognized tag.
- Diagnostics retain Effect's distinction between failure, defect, and interruption. Use domain tags or existing error classes only for further classification. Preserve the existing cleanup-failure classification, including `ComparisonCleanupError` from finalizers, and keep cleanup status separate from the operation outcome. Do not rewrite this classification solely to remove `instanceof` checks.
- Retain original causes internally in the owning process through classification and cleanup. Diagnostic output contains only the existing allowlisted identifiers, stage names, timings, and normalized outcomes. Never serialize raw causes, error messages or stacks, Schema issues, request payloads, CSV values, source names or paths, SQL, or driver details into logs or traces. User-facing validation messages may contain column names and must not become diagnostic text.
- Operations that return declared outcomes today, such as `failed`, `rejected`, and `invalid-key`, keep them.

### Desktop transport

- The `csv-viewer:request` and `acquireDroppedSource` IPC handlers return `{ ok: true, value }` or `{ ok: false, message }`. The preload returns `value` or throws `new Error(message)`. The request handler uses the message already sanitized by the shared entry adapter. Web needs no transport change.
- `acquireDroppedSource` calls the desktop host directly and does not pass through that entry adapter. Keep its absolute-path payload check and its existing unsupported-file and directory messages as explicitly recognized expected failures. Normalize expected filesystem failures from `stat` and file-identity lookup into `CsvSourceUnavailableError` with sanitized messages. Unexpected failures use `The CSV workspace could not complete the request.`. Complete this translation before constructing the IPC response; never forward arbitrary `error.message` values or classify them by message text. Any diagnostics follow the same privacy allowlist.
- Main-process events stay trusted, as results are. Delete the preload event guard.

### Code to delete

- `isCsvViewerRequestEnvelope`, `CsvViewerRequestPayload`, `CsvViewerTransportValue`, and the `SAFETY` cast in `csv-viewer-ipc.ts`.
- `isCsvViewerEvent`, `CsvViewerEventPayload`, and `isCsvViewerIntent`. Keep `csvViewerIntents` only if something other than the guard still reads it.
- `unsupportedOperation` and the `default` branches of the dispatch switches, which decoding makes unreachable.
- `validateWindowInteger`, once the schema checks row window integers.
- The desktop IPC and preload tests for the deleted guards.

### Effect release

Use the installed Effect release, `effect` 4.0.0-rc.115, as the authority. The APIs this spec names exist in it: `Schema.Struct`, `Schema.Union`, `Schema.Literals`, `Schema.optional`, `Schema.toTaggedUnion` with the `operation` key, `Schema.decodeUnknownEffect`, `Schema.toEquivalence`, and `Data.TaggedError`. Consult its source before choosing other APIs.

## Testing Decisions

- The shared CsvViewer contract suites stay the primary seam, run against native DuckDB and DuckDB-Wasm. They must pass without weakened assertions. The only assertion that changes on purpose is `csv-viewer.contract.ts`, which expects `Unsupported CSV Viewer operation: workspace.dispose` today and will expect `Malformed CSV Viewer request.`.
- Add one decoding contract case that sends malformed requests through `call`: an unknown operation, a missing required field, a wrong value kind, an unknown `placement`, and a negative row window offset. Assert the sanitized message and that no Working CSV state or data revision changed.
- Add one contract case that forces a defect through a real request and asserts the generic message. Put sentinel SQL and a local path in the error and its nested cause, and assert that neither reaches the public rejection or captured diagnostics. Use the existing database failure injection if it can raise an error that remains a defect through the adapters. Otherwise add the smallest seam that can.
- Extend the diagnostics contract. A malformed request records `csv-viewer.request` with `malformed-request` and contains no request content. Exercise an expected synchronous validation failure and an expected Promise rejection through real requests, preserving their messages and reporting `recoverable-failure`. The defect case reports `defect`. Existing interruption and cleanup-failure assertions remain unchanged. Assert behavior and classification, not specific Effect combinators or error-class counts.
- Replace the desktop IPC test with a focused transport test: an expected rejected request and an expected rejected dropped-source call both reach the renderer side with their sanitized messages and no Electron prefix. A fake IPC pair is enough, because the test covers the transport and the shared contract covers decoding. Add a dropped-source case for a missing or inaccessible file and one injected unexpected failure; neither may expose its sentinel path or internal error text in the response or diagnostics.
- Before changing the transport, reproduce the prefixed message on desktop with the verify skill by renaming a column to a blank name. After the change, show that desktop and web show the same message for that rename and for one Comparison action.
- Run the required type, lint, and test checks and the desktop and web builds.

## Out of Scope

- Schemas or runtime decoding for results, events, or capabilities.
- Changes to public request, result, or event shapes, including converting rejections into declared results.
- Branded identifier types or identifier format checks.
- Effect RPC or any change to the IPC channels themselves.
- Effect in React state or the renderer.
- Host and database adapter lifetimes, DuckDB-Wasm startup, and fatal-worker recovery.

## Further Notes

This follows the Effect workspace adoption feature in `.scratch/effect-workspace-adoption/`. An oracle review on 2026-09-25 shaped this version. Moving the failure-message fix into the desktop transport kept the public contract unchanged, and limiting schemas to requests removed result and event decoding.

The runner-up next step was host and engine resource lifetimes, managed as Layers and scopes. This spec comes first because it closes the validation gap at the desktop IPC boundary and fixes a message difference that users can see.

## Comments
