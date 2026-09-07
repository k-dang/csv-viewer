# Web runtime lifecycle

CSV Viewer Web checks the browser before it lets anyone pick a CSV, keeps every CSV Source in page memory, and turns a dead data engine into a single terminal screen rather than a partly-working window. Navigating away loses the workspace, so unexported changes are guarded at the browser level. None of this exists on desktop.

## Sub-features

- `web-startup-ready` shows the product UI only after the local data engine passes its feature check.
- `web-startup-checking` shows `Checking browser support` while that check runs.
- `web-startup-unsupported` shows `This browser cannot start CSV Viewer Web` and points at the desktop app.
- `web-fatal` replaces the whole window with `The workspace stopped` and a `Reload CSV Viewer` button when the data engine dies.
- `web-unload-guard` asks the browser to confirm navigation while any Working CSV has Unexported Changes.
- `web-session-scope` keeps CSV Sources for the page's lifetime only, described as `This browser session`.

## How to get to it (user POV)

- Load CSV Viewer Web. The startup card appears first and resolves into the app.
- On an unsupported browser, the same card becomes the unsupported message and stays there.
- If the data engine crashes mid-session, the window becomes the stopped screen; choose `Reload CSV Viewer` to start a new empty workspace.
- With unexported changes, close the tab or navigate away and the browser asks to confirm.

## Driving it with control-csv-viewer

Preconditions:

- `launch --web` has finished and `doctor` reports `target: "web"` and `status: "ok"`.

- **Startup resolved.** `web-startup-ready` is proven by launch itself. `doctor` reporting `inspect.hasHealth: true` means the `h1` is `CSV Viewer` rather than a startup-gate heading, which only happens once DuckDB-Wasm has answered its feature check. Snapshot and screenshot `evidence/web-lifecycle/started.aria.txt` and `started.png` showing `CSV Viewer`, `No CSV open`, and `Select your CSV Sources again after reload.`
- **Session-scoped sources.** Open a fixture with `upload --role button --name "Open CSV" --nth 0 --file fixtures/phase-2-sample.csv`, then open `Compare…` and read the candidate subtitle. It is `This browser session`, not a path. That is the observable form of `web-session-scope`.
- **Skip, do not fake.** `web-startup-checking`, `web-startup-unsupported`, `web-fatal`, and `web-unload-guard` are unreachable in an unattended run. Report each with the prerequisite below. Do not claim any of them from source reading or unit tests.

## Web differences

This whole feature is web-only. On desktop the equivalent surfaces do not exist: startup has no browser gate, a dead engine is a dead process, and there is no page to navigate away from.

## Gotchas

- `web-startup-checking` resolves in well under a second on a warm build, and `launch` does not return until it has. There is no reliable way to catch the intermediate card from outside the process.
- `web-startup-unsupported` needs a browser missing the WebAssembly features the engine requires. The web target runs Electron's bundled Chromium, which passes. Proving the unsupported path needs a real old browser and a human.
- `web-fatal` needs the DuckDB Worker to die. Nothing in the UI kills it, and reaching it through CDP eval would not be the user path. Leave it unverified rather than faking it.
- `web-unload-guard` is a `beforeunload` dialog. The helper never sends `Page.handleJavaScriptDialog`, so triggering it wedges the run, and the reload it guards would destroy the evidence anyway.
- Do not confuse the fatal screen with the unsupported screen. Both are centered cards under the eyebrow `CSV Viewer Web`; the headings differ (`The workspace stopped` versus `This browser cannot start CSV Viewer Web`), and only the fatal one has a `Reload CSV Viewer` button.
- Reloading the page for any reason drops every open CSV. There is no Recent list to recover from, so a reload mid-run means starting the whole recipe again.
