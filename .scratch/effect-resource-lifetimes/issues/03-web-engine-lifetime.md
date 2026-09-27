# 03 - The shared workspace owns the web engine lifetime: startup and fatal stop

**What to build:** Web startup becomes the build of the web workspace Layer, and a fatal engine stop becomes a signal that the shared workspace handles. The web wrapper session is deleted.

Startup: the Wasm database acquisition includes the existing security settings and the existing in-memory CSV startup check. A startup failure, cancellation, or fatal stop during acquisition fails the build. The scope then releases the Worker, and startup returns the existing `unsupported` result. Page hide during startup interrupts the build. The interruption terminates the Worker without waiting for a Worker request that might never settle.

Fatal stop: the database service exposes a one-time signal that the engine stopped. The Wasm adapter completes it on a Worker error, and the native adapter never completes it. The shared workspace watches the signal for the life of the runtime. When the signal completes, the workspace emits the existing `fatal-error` event once, with the existing message, and replays it to later subscribers. Every later `receive` (and so every `call`) and every `confirmClose` rejects with the existing reload message as an expected failure. After a fatal stop, disposal skips Working CSV table release and releases only the runtime scope.

The dropped-source entry and the capacity rules stay on the web host with their current behavior.

**Blocked by:** 01 - The workspace runtime acquires and releases the database.

**Status:** ready-for-agent

- [ ] The web wrapper session, its `call` and `receive` forwarding, and its duplicate stopped-engine error are deleted.
- [ ] `cancelStartup`, the fatal-error listener set, the `Promise.race` and AbortSignal wiring, and the web startup `console.error` calls are deleted.
- [ ] The workspace checks for the stop before it decodes, so a stopped workspace gives the same rejection for any payload.
- [ ] Diagnostics report `web.startup-check`, startup cleanup, and `workspace.engine-stopped` as stages with normalized outcomes. A cancelled startup is reported as `interrupted`, not as a failure. No Worker error text, driver message, file name, or registered file reference reaches diagnostic output. Add a normalized outcome to the allowlist only where no existing outcome fits.
- [ ] The web composition test keeps its cases, pointed at the Layer-based startup: the startup check runs, an unsupported result when the Worker cannot start, page hide cancelling a pending startup without waiting for the Worker, and one terminal event after a fatal Worker stop with later requests rejected.
- [ ] The web composition test captures diagnostics and asserts that a startup failure and a fatal stop are reported without their error text.
- [ ] Driver tests still prove that the Wasm adapter reports a Worker crash once, and that cancellation settles a query and keeps the connection usable.
- [ ] Both contract suites pass without weakened assertions. Desktop behavior is unchanged.
- [ ] The Wasm adapter and web composition comments describe the Layer lifetime and the stopped signal. If the diff grows the Wasm adapter, the ticket comments explain why.
- [ ] The verify skill's diagnostics section lists the new stages, and its `.agents` mirror is regenerated.
- [ ] With the verify skill on web: open two CSV Sources, run and cancel an Aligned Comparison, reopen one Working CSV with changed dialect options, then reload during startup. Read the startup, acquisition, and release stages in the diagnostics. Inspect the checking, unsupported, and fatal states for visual defects.
- [ ] The type, lint, and test checks and the desktop and web builds pass.

## Comments
