# 01 - The workspace runtime acquires and releases the database

**What to build:** Each runtime builds the workspace through one asynchronous composition entry that the shared workspace module exports: a database Layer, a host Layer built on it, and the Working CSV, Comparison, and diagnostics services built on both. The database Layer acquires the engine and the owner connection eagerly with `acquireRelease`, and its finalizer closes the owner connection and then the engine. The workspace exists only after acquisition succeeds. A build failure rejects, and the Layer scope releases whatever it acquired. Disposal keeps its order (stop admission, settle Comparisons, release every Working CSV table, close the runtime scope) and rejects when any release fails, including the database release.

Desktop builds the workspace after the app is ready and before it registers the IPC handlers. The quit handler treats "not built yet" as "nothing to dispose". Both contract fixtures build the workspace through the same composition entry. The Wasm fixture supplies a database Layer that shares one compiled engine per test file and resets it on release.

On web, this ticket moves only the existing startup and wrapper session onto the composition entry, and the existing startup check moves into the Wasm database acquisition. The fatal-error listener set, `cancelStartup`, the `Promise.race` wiring, and the wrapper session stay until ticket 03 deletes them. Keep the web startup, unsupported, and fatal behavior unchanged.

Out of scope for this ticket: the engine source change (02) and the fatal engine stop and web startup rework (03).

**Blocked by:** None - can start immediately.

**Status:** done

- [x] The composition entry is asynchronous and returns the workspace owner after the Layer is built. It replaces the synchronous constructor that uses `runSync`. The optional Comparison executor override and the diagnostics configuration stay composition inputs.
- [x] Desktop main, the web startup, and both contract fixtures use the composition entry. No caller constructs the workspace implementation directly.
- [x] Both database adapters acquire eagerly. `close(): Promise<Error[]>`, `isOpen`, the pending `opening` promise and its comments, and the "CSV workspace is disposing" checks are deleted. Table cleanup no longer checks whether the database is open.
- [x] Store disposal no longer closes the database or combines an error array. The runtime scope releases the host and then the database.
- [x] Disposal carries the release outcome to its result explicitly. It does not rely on `ManagedRuntime.dispose`, whose error type is `never`. Confirm the behavior in the installed `effect` 4.0.0-rc.115 source before choosing an API.
- [x] The runtime scope closes only once. After a release failure, a later `dispose` returns the same rejection. Concurrent disposal stays idempotent, and disposal that races an admitted open still waits for it.
- [x] Diagnostics report `workspace.acquire-database` and `workspace.release-database` as stages with normalized outcomes, correlated with the workspace identifier. Each failed close step is its own reported failure. No driver message, path, or file name reaches diagnostic output.
- [x] Desktop quit still confirms Unexported Changes and dependent Comparisons, and still exits when a release fails. The two-attempt quit policy and timeout are unchanged.
- [x] New contract case: a database release failure makes disposal reject. Diagnostics report it as its own stage, and a sentinel driver message appears in neither the rejection nor the diagnostics. Add the smallest injection seam, following the `failNextTableDrop` pattern.
- [x] New contract case: the diagnostics contract shows the database acquisition and release stages correlated with the workspace identifier.
- [x] All existing lifecycle, Working CSV, editing, Comparison, and diagnostics contract cases pass on native DuckDB and DuckDB-Wasm without weakened assertions.
- [x] The driver tests for the removed lazy opening ("opens one instance no matter how many callers ask at once" and "waits for an in-flight owner connection before closing") are deleted. The cancellation and Worker crash driver tests still pass.
- [x] The workspace package README describes the ownership order: database, then host, then workspace services, released in reverse. The comments on the composition, the adapters, and the host interface describe the Layer lifetime.
- [x] The verify skill's diagnostics section lists the new stages, and its `.agents` mirror is regenerated.
- [x] With the verify skill on desktop: start the app, open two CSV Sources, run and cancel an Aligned Comparison, reopen one Working CSV with changed dialect options, and quit with Unexported Changes to see the confirmation. On web: start the app and open a CSV Source. Read the acquisition and release stages in the diagnostics.
- [x] The type, lint, and test checks and the desktop and web builds pass.

## Comments

- **Composition entry.** `createCsvViewer(openDatabase, host, executor?, diagnostics?)` takes the adapter's acquisition and the host rather than prebuilt Layers, so the apps do not author Effect code. The shared runtime turns them into the database Layer (`acquireRelease`) and a host Layer. This departs from the PRD's "host Layer depends on the database Layer": no host has a release step and no caller needed the acquired database to build its host (the web host holds the same Wasm database object before it opens), so the host Layer is `Layer.succeed`. Ticket 02 can add the dependency if the scoped engine source needs it.
- **Release steps.** `OwnedWorkspaceDatabase` adds `closeOwnerConnection` and `closeEngine`. The finalizer runs both under `workspace.release-database`, each as its own stage (`workspace.close-database-connection`, `workspace.close-database-engine`), and runs the engine step even if the connection step failed.
- **Release outcome.** The installed `ManagedRuntime` was replaced by `Layer.buildWithScope` into a scope the workspace owns, because nothing else from `ManagedRuntime` was used. Finalizers have error type `never`, so the database finalizer records failure on a flag owned by `makeWorkspaceLayer`, and disposal reads it after `Scope.close` and marks the `workspace.dispose` cleanup as failed.
- **Disposal is memoized.** Disposal closes the runtime scope even when Comparison or table release failed, as the old store closed the database even when table release failed. After that, retrying table release against a released database cannot succeed, so the first result is kept for every later call. Table retry inside one disposal (tables left registered by a failed user close) is unchanged.
- **Adapter size.** Both adapters shrink: native -38 lines, Wasm -7 lines even after absorbing the startup check.
- **Verification.** Desktop: startup acquisition, two CSV Sources, Aligned Comparison run and cancelled, reopen with `Headers: None`, and the quit confirmation for Unexported Changes plus a dependent Comparison were all driven through the UI. The confirmation's `Close` button exposes no UIA pattern, so the confirmed-quit click needs a human. The unconfirmed quit path was driven with `window.close()`. It released the tables, the connection, and the engine, and the app exited. Web: startup acquisition, open, and page-hide release were read from the console.
- **For ticket 03.** The Wasm adapter still guards every call with `opened()`, because its object exists before `open` for `cancelStartup` and `onFatalError`. Giving it a static `open` like the native adapter removes that guard.
