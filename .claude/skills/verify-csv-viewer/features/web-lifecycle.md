# Web runtime lifecycle

CSV Viewer Web checks the browser before it lets anyone pick a CSV, keeps every CSV Source in page memory, and turns a dead data engine into a single terminal screen rather than a partly-working window. Navigating away loses the workspace, so unexported changes are guarded at the browser level. None of this exists on desktop.

## Sub-features

- `web-startup-ready` shows the product UI only after the local data engine passes its feature check.
- `web-startup-checking` shows `Checking browser support` while that check runs.
- `web-startup-unsupported` shows `This browser cannot start CSV Viewer Web` and points at the desktop app.
- `web-fatal` replaces the whole window with `The workspace stopped` and a `Reload CSV Viewer` button when the data engine dies.
- `web-unload-guard` asks the browser to confirm navigation while any Working CSV has Unexported Changes.
- `web-session-scope` keeps CSV Sources for the page's lifetime only, described as `This browser session`.
- `web-navigation` starts disposal when the page hides and starts a usable empty workspace on the next load.

## How to get to it (user POV)

- Load CSV Viewer Web. The startup card appears first and resolves into the app.
- On an unsupported browser, the same card becomes the unsupported message and stays there.
- If the data engine crashes mid-session, the window becomes the stopped screen; choose `Reload CSV Viewer` to start a new empty workspace.
- With unexported changes, close the tab or navigate away and the browser asks to confirm.
- Navigate away or reload a clean workspace; the next load has no CSV Tabs and requires selecting sources again.

## Driving it with control-csv-viewer

Preconditions:

- For helper-driven flows, `launch --web` has finished and `doctor` reports `target: "web"`, `status: "ok"`, and `viteAlive: true`.

For the automated failure and navigation checks, run from the repository root:

```powershell
pnpm exec playwright test e2e/web-lifecycle.spec.ts --workers=1
pnpm exec playwright test --config playwright.web-build.config.ts e2e/web-lifecycle.spec.ts --workers=1
```

These commands own isolated Playwright browsers and servers; they need no helper launch and fail if their server port is occupied. The first runs source-instrumented source-preparation, Worker-failure, and navigation cases against Vite on port 4173. The second builds the web app and runs startup-failure and Worker-failure/recovery cases against production assets on port 4174. Inspect screenshots, accessibility attachments, and diagnostics under `test-results/` and `test-results/web-build/`; copy evidence you need to keep into `evidence/web-lifecycle/` before another test run replaces the output.

Run both commands when the web lifecycle changes. `@dev` tests inject faults or delays into Vite source modules; the built suite runs every other web scenario. Run `pnpm test:browser` and `pnpm test:browser:built` for the complete web suite.

- **Startup resolved.** `web-startup-ready` is proven by launch itself. `doctor` reporting `inspect.hasHealth: true` means the `h1` is `CSV Viewer` rather than a startup-gate heading, which only happens once DuckDB-Wasm has answered its feature check. Snapshot and screenshot `evidence/web-lifecycle/started.aria.txt` and `started.png` showing `CSV Viewer`, `No CSV open`, and `Select your CSV Sources again after reload.`
- **Session-scoped sources.** Open `fixtures/phase-2-sample.csv` and `fixtures/phase-2-sample-edited.csv` with `upload` or `drop`. `Compare…` stays disabled until two CSV tabs are open, so one file cannot show the subtitle. Click `Compare…` and read the candidate subtitle. It is `This browser session`, not a path. That is the observable form of `web-session-scope`.
- **Checking and unsupported.** The built-suite startup test holds the actual WASM request until the Checking browser support screen is captured, then aborts it. Require This browser cannot start CSV Viewer Web, the desktop alternative, and no Open CSV control. This proves startup-failure behavior and layout; it does not certify an old browser's compatibility.
- **Fatal and recovery.** The Worker-failure test opens a CSV through the file picker, creates an unhandled promise rejection inside the live DuckDB Worker, and captures The workspace stopped. The built suite exercises production assets; the dev suite also injects a faulty event subscriber. Require no tabs or Open CSV control, one sanitized engine-stopped diagnostic, and no injected private error text in the UI or workspace diagnostics. Reload CSV Viewer must start an empty workspace that can open and read the CSV again.
- **Navigation.** The dev-suite navigation test opens a clean CSV and performs a real navigation. A test-only synchronous observer records entry to the existing disposal callback. Require one invocation, closure of the old Worker, a different workspace identity, no old tabs, and successful CSV selection and reads in the new workspace. Complete asynchronous disposal logs after unload are not an acceptance requirement; release ordering and failures are covered by the shared workspace and web composition tests while their context is alive.
- **Unload guard.** The helper does not answer beforeunload dialogs. `e2e/tab-lifecycle.spec.ts` dismisses and then accepts a comparison-close confirm, `dependent Comparison Tabs will also close`, which is a different dialog. No Playwright test drives beforeunload. The guard's decision is covered by `pnpm exec vitest run packages/ui/src/app/App.test.tsx -t "warns before page unload"` with a synthetic event; the real browser prompt stays unverified.

## Web differences

This whole feature is web-only. On desktop the equivalent surfaces do not exist: startup has no browser gate, a dead engine is a dead process, and there is no page to navigate away from.

## Gotchas

- The helper's launch waits past the checking screen. Use the lifecycle test's request barrier to capture that state instead of racing it or adding sleeps.
- Inject faults at the platform/driver boundary, then assert the real rendered UI and recovery. Setting renderer state or dispatching a fake fatal workspace event does not prove Worker failure handling.
- A real browser compatibility claim needs that browser. The controlled startup-failure test proves the failure path in Chromium.
- Navigation can destroy the old JavaScript context before asynchronous disposal completes. Verify initiation and new-workspace usability; do not wait for every old-context completion log after unload or keep the page alive artificially and call that navigation proof.
- The helper never sends `Page.handleJavaScriptDialog`. Finish dirty-workspace navigation through Playwright or human interaction instead of wedging a helper run.
- Do not confuse the fatal screen with the unsupported screen. Both are centered cards under the eyebrow `CSV Viewer Web`; the headings differ (`The workspace stopped` versus `This browser cannot start CSV Viewer Web`), and only the fatal one has a `Reload CSV Viewer` button.
- Reloading the page for any reason drops every open CSV. There is no Recent list to recover from, so a reload mid-run means starting the whole recipe again. The dev server is live: editing `apps/web/src/*` or any non-component module forces a full reload, and component edits in `packages/ui` hot-swap but can still reset React state. Do not edit product source mid-run.
- A dev-server pass does not prove emitted Worker/WASM assets work. Use the built-bundle lifecycle command above for that claim.
