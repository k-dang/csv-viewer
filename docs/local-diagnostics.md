# Local Comparison diagnostics

CSV Viewer uses Effect's built-in `Logger.consoleLogFmt` on desktop and web. Stages log their start and completion with `Effect.logInfo`. `Effect.withLogSpan` supplies elapsed times, and `Effect.withSpan` supplies tracing context. There is no custom output format, separate viewer or network export.

## Read the output

Start the app with `pnpm run dev:desktop` or `pnpm run dev:web`. Open two CSV Sources, choose **Compare**, select a Candidate and apply a Comparison Key.

Desktop diagnostics appear in the main-process console. For an isolated verification run, the launcher captures them in a local file:

```powershell
node .agents/skills/verify-csv-viewer/bin/control-csv-viewer.mjs launch --rebuild
$run = Get-Content .agents/skills/verify-csv-viewer/runs/current.json | ConvertFrom-Json
Get-Content $run.logPath | Select-String 'message="?(comparison|workspace)\.'
```

Web diagnostics appear in the browser console, not the Vite server's console. An agent can capture them through the browser debugging connection. The verification launcher supports `launch --web`; clean up the prior run before switching runtimes.

## Follow an operation

Effect's text output includes a timestamp, log level, fiber identifier, message, log-span timings and annotations. The message names the stage, such as `comparison.snapshot`. For that stage's duration, read the matching log-span value on its completion line. Ancestor timings are elapsed times at the moment of logging, not independent durations to add together.

Filter by `operationId` to follow one Comparison attempt through validation, snapshot computation and resource release. `requestId` ties background work to its initiating request; `workspaceId` connects separate requests and disposal. Applicable Comparison and Working CSV identifiers are also included.

Background work and later cleanup retain the original context. Nested log spans show the enclosing stages. Snapshot release and failed-release retries keep the original operation identifiers even if they run during refresh or disposal.

`outcome` distinguishes `applied`, `invalid-key`, `sources-changed`, `cancelled` and `failed`. `failureCategory` and the `recoverableFailure`, `defect` and `interrupted` flags identify normalized causes without printing raw errors. `cleanup` reports whether temporary resources were released. A result can be applied successfully while cleanup fails; it remains usable.

Closing a Comparison releases its published snapshot. Graceful workspace close logs `workspace.dispose`, `comparison.dispose` and `workspace.release-csvs`. A start without a completion means completion was not observed. Browser navigation or a forced process kill can stop JavaScript before final logs are emitted.

## Privacy and tests

Only approved identifiers and normalized outcomes are added to log annotations. CSV contents, column names, source names and locations, SQL, and raw driver errors are excluded. Failures are classified before logging; their Effect causes are not passed to the logger.

`createCsvViewer(host, database, diagnostics)` accepts an optional Effect `Logger` for tests. Tests capture Effect's standard logger events and formatters through normal CsvViewer requests, events and disposal. A throwing logger does not prevent Comparison work or cleanup.

Native and Wasm contracts verify success, cancellation, source changes, invalid keys, defects, cleanup failures, timing, correlation and privacy. Deferred table deletion remains owned by the artifact registry for disposal retry after its source lease has been released.
