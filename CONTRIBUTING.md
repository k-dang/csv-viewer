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

The browser tests need Chromium. Install it once with `pnpm exec playwright install chromium`. On Linux, add `--with-deps`.

## End-to-end tests

| Command | What it covers |
| --- | --- |
| `pnpm test:browser` | The full web suite in Chromium: editing, queries and stats, comparison, parsing, export, drag and drop, and the page lifecycle. |
| `pnpm test:browser:built` | User workflows, engine failure, and recovery against the production web build. Race and cancellation cases need source instrumentation, so only `pnpm test:browser` runs them. |
| `pnpm test:desktop` | Builds the Electron app and launches it with isolated profiles. Covers preload and IPC, native DuckDB, export source protection, recent sources across a restart, dropped-file identity, and reopen confirmation. |

CI runs the web suites on Linux and the desktop suite on Windows. A failed browser test keeps its screenshots and traces. A failed desktop test attaches the Electron window and its trace.

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

## Diagnostics

The app logs each operation's stages, timings, outcome, and cleanup failures. Logs never contain file names, paths, column names, cell values, query text, SQL, or driver errors. To capture logs on desktop or web, see [Read diagnostics](.agents/skills/verify-csv-viewer/SKILL.md#read-diagnostics).

## Latency benchmarks

`pnpm perf:latency` measures cold and warm user workflows on both runtimes. To measure one runtime, add `--runtime web` or `--runtime desktop`. Each run uses isolated sessions and records the machine and fixture details. Benchmarks don't run with tests or builds. [Working CSV latency](docs/perf/working-csv-latency.md) defines the measurements and records a baseline.
