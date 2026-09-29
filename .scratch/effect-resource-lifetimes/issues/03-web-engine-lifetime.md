# 03 - The shared workspace owns the web engine lifetime: startup and fatal stop

**What to build:** Web startup becomes the build of the web workspace Layer, and a fatal engine stop becomes a signal that the shared workspace handles. The web wrapper session is deleted.

Startup: the Wasm database acquisition includes the existing security settings and the existing in-memory CSV startup check. A startup failure, cancellation, or fatal stop during acquisition fails the build. The scope then releases the Worker, and startup returns the existing `unsupported` result. Page hide during startup interrupts the build. The interruption terminates the Worker without waiting for a Worker request that might never settle.

Fatal stop: the database service exposes a one-time signal that the engine stopped. The Wasm adapter completes it on a Worker error, and the native adapter never completes it. The shared workspace watches the signal for the life of the runtime. When the signal completes, the workspace emits the existing `fatal-error` event once, with the existing message, and replays it to later subscribers. Every later `receive` (and so every `call`) and every `confirmClose` rejects with the existing reload message as an expected failure. After a fatal stop, disposal skips Working CSV table release and releases only the runtime scope.

The dropped-source entry and the capacity rules stay on the web host with their current behavior.

**Blocked by:** 01 - The workspace runtime acquires and releases the database.

**Status:** in review (manual web UI verification pending)

- [x] The web wrapper session, its `call` and `receive` forwarding, and its duplicate stopped-engine error are deleted.
- [x] `cancelStartup`, the fatal-error listener set, the `Promise.race` and AbortSignal wiring, and the web startup `console.error` calls are deleted.
- [x] The workspace checks for the stop before it decodes, so a stopped workspace gives the same rejection for any payload.
- [x] Diagnostics report `web.startup-check`, startup cleanup, and `workspace.engine-stopped` as stages with normalized outcomes. A cancelled startup is reported as `interrupted`, not as a failure. No Worker error text, driver message, file name, or registered file reference reaches diagnostic output. Add a normalized outcome to the allowlist only where no existing outcome fits.
- [x] The web composition test keeps its cases, pointed at the Layer-based startup: the startup check runs, an unsupported result when the Worker cannot start, page hide cancelling a pending startup without waiting for the Worker, and one terminal event after a fatal Worker stop with later requests rejected.
- [x] The web composition test captures diagnostics and asserts that a startup failure and a fatal stop are reported without their error text.
- [x] Driver tests still prove that the Wasm adapter reports a Worker crash once, and that cancellation settles a query and keeps the connection usable.
- [x] Both contract suites pass without weakened assertions. Desktop behavior is unchanged.
- [x] The Wasm adapter and web composition comments describe the Layer lifetime and the stopped signal. If the diff grows the Wasm adapter, the ticket comments explain why.
- [x] The verify skill's diagnostics section lists the new stages, and its `.agents` mirror is regenerated.
- [ ] With the verify skill on web: open two CSV Sources, run and cancel an Aligned Comparison, reopen one Working CSV with changed dialect options, then reload during startup. Read the startup, acquisition, and release stages in the diagnostics. Inspect the checking, unsupported, and fatal states for visual defects.
- [x] The type, lint, and test checks and the desktop and web builds pass.

## Comments

- Effect's build signal now reaches the Wasm adapter, which terminates an acquired Worker on interruption and terminates a Worker that arrives after cancellation. The adapter exposes one stopped signal and retains failed startup release status so `web.startup-cleanup` can report it. A late termination failure has its own `web.startup-late-cleanup` stage because page navigation must return before the Worker creation promise settles. These responsibilities account for the adapter's net growth; pending-open sharing and the listener set are gone.
- Web UI verification opened two CSV Sources, applied an Aligned Comparison, and reopened one with `Headers: None`. A page transition released the database; acquisition, probe, and release stages shared a workspace ID in diagnostics. A generated 250,001-row Comparison finished before its Cancel control could be clicked. The verification skill identifies checking, unsupported, and fatal visuals as unavailable in an unattended run; composition and component tests cover their behavior.
- Review follow-up releases browser-held CSV Sources after a fatal engine stop without sending table queries to the stopped engine. A web composition test reproduces the capacity reservation and checks its release, and a pending startup-check test checks database release after a fatal stop.
