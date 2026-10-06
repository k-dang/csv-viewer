# Contributing to CSV Viewer

## Check your change

Before you submit a change, run these commands:

```powershell
pnpm test
pnpm test:browser
pnpm test:browser:built
pnpm build
```

If you change desktop behavior, also run `pnpm test:desktop`.

`pnpm build` runs type checking and Oxlint, and any lint warning fails it. To run those checks alone, use `pnpm typecheck` and `pnpm lint`.

The web browser tests need Chromium's headless shell. Install it once with `pnpm exec playwright install --only-shell chromium`. On Linux, add `--with-deps`. Desktop tests use Electron's own browser and need no Playwright browser download.

## End-to-end tests

| Command | What it covers |
| --- | --- |
| `pnpm test:browser` | Scenarios tagged `@dev` that inject faults or delays into Vite source modules: races, cancellation, cleanup, and navigation. |
| `pnpm test:browser:built` | Builds the web app and runs all other web scenarios against production assets: editing, queries and stats, comparison, parsing, export, drag and drop, tabs, engine failure, and recovery. |
| `pnpm test:desktop` | Builds the Electron app and launches it with isolated profiles. Covers preload and IPC, native DuckDB, export source protection, recent sources across a restart, dropped-file identity, and reopen confirmation. |

Together, the two web commands run every scenario once. Tag tests that intercept Vite source modules with `@dev`; tests that work against emitted assets belong in the built suite.

CI runs unit tests, type checking, lint, and the desktop build in one Linux job, with each web suite in its own parallel Linux job. The built suite owns the web build. Desktop end-to-end tests run in parallel on Windows. A failed browser test keeps its screenshots and traces. A failed desktop test attaches the Electron window and its trace.

The desktop tests fake only the answers from the OS file chooser and message boxes. Check native dialog appearance and keyboard behavior by hand. Each test uses temporary files and a throwaway profile, so it never touches your recent files or app session.

To drive the real app by hand or with an agent, use the [verification skill](.agents/skills/verify-csv-viewer/SKILL.md). It launches an isolated desktop or web instance, sends user actions, and captures evidence. The [verification map](.agents/skills/verify-csv-viewer/features/README.md) lists each user workflow and how it differs between desktop and web.

## Where the code lives

| Directory | Owns |
| --- | --- |
| `apps/desktop` | The Electron main process, preload and IPC, native DuckDB, file dialogs, recent sources, and export delivery. |
| `apps/web` | DuckDB-Wasm and its Worker, browser file access, downloads, and the startup and recovery screens. |
| `packages/ui` | The shared React UI: AG Grid, CSV and comparison tabs, themes, and clipboard actions. |
| `packages/workspace` | Shared CSV queries, editing and history, export serialization, comparison, and resource ownership. |

Desktop and web share one `CsvViewer` request and event contract. `packages/workspace` implements it with Effect 4. Edits to one file run in order, and reads run alongside them. A table stays alive while any admitted request holds it. Shutdown waits for that work, then releases tables, connections, and source buffers, and retries any cleanup that failed. [Workspace resource ownership](packages/workspace/README.md) describes these rules in detail.

The renderer controllers use `async`/`await` for commands and expose Promises to React and AG Grid. They keep result-version checks to discard stale replies. A CSV Tab owns an Effect fiber for stats delivery and interrupts it when superseded or closed; the underlying `CsvViewer` request still runs, and the workspace owns its cleanup. Admitted edits finish, and acquired sources complete their handoff, even when the renderer stops.

## Diagnostics

The app logs each operation's stages, timings, outcome, and cleanup failures. Logs never contain file names, paths, column names, cell values, query text, SQL, or driver errors. To capture logs on desktop or web, see [Read diagnostics](.agents/skills/verify-csv-viewer/SKILL.md#read-diagnostics).

## Latency benchmarks

`pnpm perf:latency` measures cold and warm user workflows on both runtimes. To measure one runtime, add `--runtime web` or `--runtime desktop`. Each run uses isolated sessions and records the machine and fixture details. Benchmarks don't run with tests or builds. [Working CSV latency](docs/perf/working-csv-latency.md) defines the measurements and records a baseline.
