Status: ready-for-agent

# Host and database lifetimes owned by the workspace runtime

**Blocked by:** None.

## Problem Statement

The workspace runtime runs Working CSV and Comparison work as Effects, but it does not own the resources that work depends on. The desktop and web runtimes create the data engine and the host outside the runtime and give them to it as finished values. The runtime uses them. It does not acquire or release them.

For a maintainer, this causes the following problems:

- **Disposal ends with a hand-written sequence.** Store disposal releases every table, then calls the database's `close`, which returns an array of collected errors. The store then combines that array with its own failures. This is the only resource in the workspace that is released outside a scope.
- **Both database adapters open lazily and share the pending open.** Each adapter keeps a pending `opening` promise so that concurrent callers do not each create an engine. Each adapter also has "CSV workspace is disposing" checks and an `isOpen` flag that table cleanup reads. These guard against races that exist only because nothing owns the engine's lifetime.
- **Web startup is the least structured code in the product.** It uses `Promise.withResolvers`, `Promise.race`, AbortSignal wiring, and `console.error`. A wrapper session class sits in front of the workspace to intercept every call after a fatal Worker error. Startup failures, startup cleanup failures, and fatal engine stops do not appear in the workspace diagnostics. The earlier Effect specs left this code out of scope, so no plan covers it now.
- **Engine source access is a scope written as a callback.** The host's `withEngineSource(sourceId, use)` acquires a readable engine reference, runs `use`, and releases the reference. On web, a failure to drop the registered file after a successful load makes the open fail, although the Working CSV loaded correctly.
- **Desktop builds the workspace when the main module loads.** Construction is synchronous only because the database opens lazily. The workspace cannot report a failure to acquire the engine until the first request.

The user does not see most of these problems directly. When one of these paths fails, the maintainer cannot follow it in the diagnostics as they can follow a request. On web, a startup failure produces only a console line with raw error text.

## Solution

Make the host and the database services of the workspace runtime, acquired and released through Layers. Each runtime has one composition that acquires the data engine, builds the host on it, and builds the Working CSV and Comparison services on both. The workspace becomes available only after acquisition succeeds. Disposal releases the Working CSV tables and then closes the runtime scope, which releases the host and the database in reverse order of acquisition.

Web startup becomes the acquisition of the web data engine, including the existing startup check. A failed or cancelled startup releases what it acquired and shows the existing unsupported state. A fatal engine stop becomes a signal from the database service. The shared workspace turns it into the existing single `fatal-error` event and rejects later requests with the existing message. The web wrapper session is deleted.

Engine source access becomes a scoped acquisition that composes with the staging table's scope during open and reopen. A failure to release an engine source after a successful load is reported as a cleanup failure against that request. It no longer fails the open.

Users keep the existing desktop and web behavior: startup, the unsupported web state, the fatal engine message, open, reopen, Comparison, close confirmation, and quit.

## User Stories

1. As a maintainer, I want the workspace runtime to acquire the data engine, so that one owner controls the engine from start to release.
2. As a maintainer, I want the workspace runtime to own the host, so that the host is released after the work that uses it.
3. As a maintainer, I want one composition per runtime that I can read from top to bottom, so that I know what each runtime supplies and in what order it is released.
4. As a maintainer, I want the database released by a scope finalizer, so that disposal does not end with a hand-written close sequence.
5. As a maintainer, I want the database adapters to stop sharing a pending open between callers, so that I do not have to reason about races that the Layer lifetime removes.
6. As a maintainer, I want the workspace to exist only after the engine is acquired, so that no request can reach an engine that is still starting.
7. As a maintainer, I want a failure to acquire the engine reported as a diagnostics stage, so that I can see why the workspace did not start.
8. As a maintainer, I want the release of each resource reported as a diagnostics stage with its outcome, so that I can see which release failed during disposal.
9. As a maintainer, I want a failed release to make disposal reject, so that a successful disposal result always means every resource was released.
10. As a maintainer, I want engine source access to be a scoped resource, so that it composes with the staging table's cleanup during open and reopen.
11. As a maintainer, I want a failure to release an engine source reported against the open that used it, so that a secondary failure does not hide the result of the open.
12. As a maintainer, I want the fatal engine stop handled by the shared workspace, so that one implementation emits the fatal event and rejects later requests.
13. As a maintainer, I want the web wrapper session deleted, so that there is no second object in front of the workspace to keep in sync with its contract.
14. As a maintainer, I want web startup written as resource acquisition, so that cancellation and failure release the Worker through the same finalizers as disposal.
15. As a maintainer, I want web startup failures, startup cleanup failures, and fatal engine stops in the workspace diagnostics, so that I can find them without reading the browser console.
16. As a maintainer, I want these diagnostics limited to the existing privacy allowlist, so that engine errors, paths, and file names stay out of diagnostic output.
17. As a maintainer, I want the contract fixtures to compose the workspace through the same composition the apps use, so that the contract tests cover the real acquisition and release path.
18. As a maintainer, I want the contract fixtures to keep sharing one compiled Wasm engine per test file, so that the test suite stays fast.
19. As a desktop user, I want CSV Viewer to start as it does today, so that this change does not affect me.
20. As a desktop user, I want quitting to confirm Unexported Changes and dependent Comparisons as it does today, so that I do not lose work.
21. As a desktop user, I want quitting to finish even when a resource fails to release, so that the app does not stay open after I quit.
22. As a web user, I want the same checking and unsupported startup states as today, so that I know whether CSV Viewer can run in my browser.
23. As a web user, I want leaving the page during startup to stop startup without waiting for the Worker, so that navigation is not delayed.
24. As a web user, I want one clear message when the local data engine stops, so that I know to reload CSV Viewer.
25. As a web user, I want every action after the engine stops to fail with the existing reload message, so that I do not see engine errors.
26. As a user, I want an open to succeed when the CSV loaded but a temporary engine reference could not be released, so that a cleanup problem does not discard a Working CSV that loaded correctly.
27. As a user, I want open, reopen, edit, Comparison, Export CSV, and close to keep their results and messages, so that this change does not affect my work.

## Implementation Decisions

### Composition

- Each runtime builds one workspace Layer from a database Layer and a host Layer. The Working CSV, Comparison, and diagnostics services depend on them as they do today. The shared workspace module exports the composition entry. Desktop, web, and the contract fixtures all use it.
- The composition entry is asynchronous and returns the workspace owner after the Layer is built. A build failure rejects, and the Layer's scope releases whatever it acquired. This replaces the synchronous constructor that runs the runtime with `runSync` today.
- Desktop builds the workspace after the app is ready and before it registers the IPC handlers. The quit handler treats "not built yet" as "nothing to dispose". Desktop does not add a new startup-failure UI. A failure to acquire native DuckDB is a defect that is reported through diagnostics, and the app exits as it does for other startup failures today.
- The optional Comparison executor override and the diagnostics configuration stay composition inputs for tests.

### Database service

- The database Layer acquires the engine and the owner connection eagerly with `acquireRelease`. Its finalizer closes the owner connection and then the engine (native instance, or Wasm Worker). Each close step that fails is reported as a stage. The finalizer does not collect errors into an array.
- The database interface keeps its promise-returning query methods: `run`, `readObjects`, the cancellable variants, `cancelRunning`, and worker connections. These are driver edges, and converting them is not part of this spec.
- Delete `close(): Promise<Error[]>`, `isOpen`, the pending `opening` promise and its comments, and the "CSV workspace is disposing" checks from both adapters. The Layer lifetime makes them unreachable. Table cleanup no longer checks whether the database is open. Tables are always released before the database, and a release that fails after a fatal engine stop is reported like any other release failure.
- Worker connections stay acquired by the operations that use them, as they are today. This spec does not change their ownership.

### Host service

- The host Layer depends on the database Layer. On web, the host uses the database service to register engine sources. On desktop, the host needs only its prompts and the Recent CSV Sources path.
- Replace `withEngineSource(sourceId, use)` with a scoped acquisition that returns the engine source reference and releases it when the scope closes. This is the only host method that changes shape. The other host methods stay promise-returning.
- Open and reopen acquire the engine source inside the staging scope. An engine source release failure after a successful load is reported as `cleanup-failed` against the open or reopen and does not change its result. A load failure still fails the open with its current message, and the staging finalizer still drops the staging table.
- Desktop's engine source is the file path and has no release step. Web's engine source is a registered file buffer, and its release drops it.

### Fatal engine stop

- The database service exposes a one-time signal that the engine stopped. The Wasm adapter completes it on a Worker error. The native adapter never completes it.
- The shared workspace watches the signal for the life of the runtime. When the signal completes, the workspace emits the existing `fatal-error` event once, with the existing message, and replays it to later subscribers. It rejects every later `receive` (and so every `call`, which delegates to it) and every `confirmClose` with the existing reload message as an expected failure. Check for the stop before decoding, so that a stopped workspace gives the same rejection for any payload. It reports the stop as a diagnostics stage without the Worker's error text.
- After a fatal stop, disposal skips Working CSV table release and releases only the runtime scope, as the web session does today.
- Delete the web wrapper session, including its `call` and `receive` forwarding, and its duplicate stopped-engine error.

### Web startup

- Web startup builds the web workspace Layer. The Wasm database acquisition includes the existing security settings and the existing in-memory CSV startup check. A startup failure, cancellation, or fatal stop during acquisition fails the build. The scope then releases the Worker, and startup returns the existing `unsupported` result.
- Page hide during startup interrupts the build. Interruption terminates the Worker without waiting for a Worker request that might never settle, as `cancelStartup` does today. Delete `cancelStartup`, the fatal-error listener set, and the `Promise.race` wiring.
- Startup failure and startup cleanup failure are reported as diagnostics stages with normalized outcomes. Delete their `console.error` calls. A cancelled startup is reported as `interrupted`, not as a failure.
- The dropped-source entry and the capacity rules stay on the web host and keep their behavior.

### Disposal

- Disposal keeps its current order: stop admission, settle Comparisons, release every Working CSV table, then close the runtime scope. Closing the scope releases the host and then the database.
- Disposal still rejects when any release fails, and diagnostics report each failure as its own stage. The installed `ManagedRuntime` closes its scope with an effect whose error type is `never`, so do not rely on it to report a finalizer failure. Carry the release outcome to the disposal result explicitly, and confirm the behavior in the installed Effect source before choosing an API.
- Working CSV table release keeps its current retry behavior. The runtime scope closes only once. After a release failure, a later `dispose` call returns the same rejection. Desktop's quit loop then exits the app with its existing failure path. Desktop's two-attempt quit policy and timeout stay unchanged.
- Concurrent disposal stays idempotent. Disposal that races an admitted open still waits for it.

### Diagnostics

- New stages use the existing observation helper and the existing allowlist. Name them after the resource and action, for example `workspace.acquire-database`, `workspace.release-database`, `web.startup-check`, `csv.release-engine-source`, and `workspace.engine-stopped`. Add a normalized outcome to the allowlist only where no existing outcome fits.
- Never write Worker error text, driver messages, file names, paths, or registered file references to diagnostic output.
- The desktop Recent CSV Sources warnings stay as they are. They were categorized on purpose in earlier work, and they do not concern resource lifetime.

### Documentation

- Update the workspace package README with the ownership order: database, then host, then workspace services, released in reverse. Update the comments on the composition, the database adapters, and the host interface to describe the Layer lifetime and not the removed lazy opening.
- Update the verify skill's diagnostics section with the new stages, then regenerate its `.agents` mirror.

## Testing Decisions

- A good test drives the workspace the way a runtime does and asserts results, events, released resources, and diagnostic meaning. It does not assert Layer structure, finalizer order by inspection, Effect combinators, or private adapter fields.
- **Primary seam: the shared CsvViewer contract suites**, run against native DuckDB and DuckDB-Wasm. Change both fixtures to build the workspace through the composition entry the apps use. The Wasm fixture supplies a database Layer that shares one compiled engine per test file and resets it on release, as the shared-engine database does today. The existing failure-injection helpers keep working on the database the fixture holds.
- All existing lifecycle, Working CSV, editing, Comparison, and diagnostics contract cases must pass without weakened assertions. They already cover disposal order, idempotent disposal, waiting for admitted work, and cleanup-failure reporting.
- Add contract cases only for new guarantees:
  - A database release failure during disposal makes disposal reject. Diagnostics report it as its own stage, and a sentinel driver message does not appear in the rejection or in the diagnostics. Add the smallest injection seam that fails one database release, following the existing `failNextTableDrop` pattern.
  - An engine source release failure after a successful load returns `opened` and reports `cleanup-failed` for that request. The Working CSV is readable afterward.
  - The diagnostics contract shows database acquisition and release stages correlated with the workspace identifier.
- **Secondary seam: the existing web composition test.** It covers what the shared contract cannot express: the startup check, an unsupported result when the Worker cannot start, page hide cancelling a pending startup without waiting for the Worker, and one terminal event after a fatal Worker stop with later requests rejected. Keep these cases and point them at the Layer-based startup. Extend them to capture diagnostics and assert that a startup failure and a fatal stop are reported without their error text.
- **Driver tests:** Keep the native and Wasm adapter tests that prove cancellation settles a query and keeps the connection usable, and the Wasm test that a Worker crash is reported once. Delete the tests for the removed lazy opening, "opens one instance no matter how many callers ask at once" and "waits for an in-flight owner connection before closing". The Layer build replaces the guarantee they protect.
- Use synchronization barriers, not sleeps, for ordering.
- With the verify skill, on desktop: start the app, open two CSV Sources, run and cancel an Aligned Comparison, reopen one Working CSV with changed dialect options, and quit with Unexported Changes to see the confirmation. On web: do the same flow, then reload during startup, and read the diagnostics for acquisition, release, and startup stages. Inspect the checking, unsupported, and fatal states for visual defects.
- Run the required type, lint, and test checks, and the desktop and web builds.

## Out of Scope

- Converting the database query methods, worker connections, or the Working CSV store's promise adapters to native Effect.
- Effect in the renderer or React state, and Effect RPC.
- Restarting the engine after a fatal stop. A fatal stop stays terminal for the page.
- New startup-failure UI on desktop, and changes to desktop's quit retry count or timeout.
- Changes to public requests, results, events, capabilities, or messages.
- Desktop Recent CSV Sources warnings.
- Multi-threaded DuckDB-Wasm, remote telemetry, and new diagnostic viewers.
- An Effect version upgrade. Use the installed `effect` 4.0.0-rc.115 as the API authority, and consult its source before choosing Layer, scope, or runtime APIs.

## Further Notes

Earlier Effect work gave the workspace runtime ownership of its work (Comparison execution, Working CSV coordination) and of failure translation (request decoding, sanitized messages). This spec adds ownership of its resources.

The spec deletes more code than it adds. Expected deletions: the web wrapper session, the lazy-open logic and its races in both adapters, `close(): Promise<Error[]>` and the error collection that combines its result, `isOpen`, `cancelStartup`, the fatal-error listener set, and the web startup `console.error` calls. If the diff grows either database adapter, explain why in the ticket comments.

The next spec, `.scratch/effect-driver-edges/PRD.md`, converts the remaining promise adapters. It is a separate spec so that each diff has one kind of risk: this spec changes startup and disposal, and that one changes every request path.

## Comments
