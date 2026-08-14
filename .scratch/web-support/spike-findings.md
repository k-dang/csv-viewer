# DuckDB-Wasm feasibility spike findings

Measured on 2026-08-12 using the single-threaded MVP Worker in T3 Code Nightly's Chromium 146 browser on Windows 10 (Ryzen 7 7800X3D, 31.2 GiB RAM). These are feasibility measurements, not capacity limits or cross-browser performance promises. The temporary Vite harness and its DuckDB-Wasm dependency were removed after the measurements.

## Core parity

### Observed answer

The newest DuckDB core available in both packages is **v1.5.5**:

- `@duckdb/node-api@1.5.5-r.4`
- `@duckdb/duckdb-wasm@1.33.1-dev64.0`

The Wasm package version is a development release published under npm's `next` tag. Its runtime reported `v1.5.5`; the native package naming and runtime identify the same core. Reaching the newest parity therefore requires upgrading native from `1.5.2-r.1` by three patch releases, not downgrading it.

For a stable-only pairing, the newest Wasm release is `@duckdb/duckdb-wasm@1.32.0`, whose runtime reported **v1.4.3**. It pairs with `@duckdb/node-api@1.4.3-r.3` and would require downgrading native from v1.5.2 to v1.4.3.

### Evidence

- npm registry versions and tags were queried on 2026-08-12 (`duckdb-wasm` latest `1.33.1-dev57.0`, next `1.33.1-dev64.0`; `node-api` latest `1.5.5-r.4`).
- `SELECT version()` returned `v1.5.5` in Wasm `1.33.1-dev64.0`, `v1.4.3` in Wasm `1.32.0`, and `v1.5.2` in the repository's original native package.
- The cancellation and connection-scheduling probes ran on both Wasm builds. On stable `1.32.0` / core v1.4.3, blocking versus pending comparison/owner latency was 3,737/2,806 ms versus 3,850/56.6 ms, and direct cancellation completed in 256 ms. On development `1.33.1-dev64.0` / core v1.5.5, representative values were 3,539/2,923 ms versus 3,455/188 ms, and direct cancellation completed in 238 ms.

### Consequence for tickets 03, 05, and 06

Ticket 06 can achieve same-core parity at v1.5.5, but it must explicitly decide whether a DuckDB-Wasm development build is acceptable for production. If only stable Wasm releases are allowed, the alternative is the v1.4.3 stable pairing and its native downgrade. Ticket 03 does not need to encode a known version divergence.

## Existing native suite against the parity pairing

### Observed answer

Upgrading native DuckDB to `@duckdb/node-api@1.5.5-r.4` did not regress the current suite.

### Evidence

- Baseline at `1.5.2-r.1`: 12 test files and 113 tests passed.
- Proposed v1.5.5 parity package: typechecking passed; the same 12 test files and 113 tests passed.

### Consequence for tickets 03, 05, and 06

The newest parity pairing has no observed native behavior blocker. The package changes remain ticket 06 work; the spike did not retain them.

## Cancellation

### Observed answer

The asynchronous Wasm connection has a per-connection cancellation operation: `AsyncDuckDBConnection.cancelSent()`. It applies to work started through the pending-query `send()` API. This is not an `interrupt()` method and does not apply to a blocking `query()` call, but it **does cancel an already executing statement**; cancellation is not limited to application-created SQL statement boundaries.

On a comparison-shaped `CREATE TABLE ... FULL OUTER JOIN` that otherwise took about 3.5-3.9 seconds, an immediately queued `cancelSent()`:

- returned `true`;
- rejected the query with `query was canceled` after 238-257 ms;
- left no comparison table in `information_schema.tables`; and
- left the same connection usable (`SELECT 42` succeeded).

### Evidence

The spike reproduced the current executor's load-bearing path—a comparison artifact CTAS on a dedicated connection, cancellation while it was executing, artifact inspection, and reuse of that connection—directly with the Wasm API. The published type surface and implementation also expose `send()`/`cancelSent()` on `AsyncDuckDBConnection`; there is no `interrupt()` equivalent.

A second integration probe imported the current `DuckDbComparisonExecutor` unchanged and supplied a throwaway Wasm connection wrapper for its native-shaped methods. Cancelling `createSnapshot()` after the executor started its CTAS released both acquired sources, left no staging table, and left the owner connection usable. The low-level error surfaced as `_setThrew is not defined` rather than `query was canceled`, which confirms that ticket 06 must normalize cancellation errors instead of depending on driver text. The domain service's existing cancellation flag remains the source of the observable cancelled outcome.

### Consequence for tickets 03, 05, and 06

Ticket 05 should keep outcome-based cancellation assertions, but it does not need to model Wasm as statement-boundary-only. Ticket 06's database seam must distinguish ordinary execution from cancellable pending execution or otherwise hide that API pairing. Cancellation capability is still not identical to native `interrupt()`, so no latency guarantee should enter the domain contract.

## Concurrency

### Observed answer

Connections still share one Worker and do not execute DuckDB work in parallel. However, owner responsiveness depends materially on the Wasm query API:

- With dedicated-connection `query()`, a 3.54-second comparison made an owner row-window-shaped count wait **2.92 seconds** and finish after the comparison.
- With dedicated-connection `send()`, a 3.46-second comparison allowed the owner query to finish in **188 ms**, before the comparison. Earlier repeated runs measured 56.6 ms and 138.8 ms.
- A follow-up using the workspace's actual two-query row-window shape (`count(*)`, then ordered `LIMIT 1000 OFFSET 0`, including Arrow-to-object materialization) finished 1,000 rows in **239 ms**, before its 378 ms pending comparison.
- A final stable-build run kept the same complete row-window probe beside a **1,957 ms** pending comparison. The count plus 1,000 materialized rows completed in **340 ms**, well before the comparison.

Thus connection separation is logical rather than parallel, but the pending-query polling API yields scheduling turns within one long SQL statement. A long comparison need not starve owner work if it uses `send()`.

### Evidence

Both measurements used two `AsyncDuckDBConnection` instances over one MVP Worker with `threads = 1`, the same million-row comparison CTAS, and the same owner query. Promise completion order—not elapsed-time inference—determined whether the owner finished first.

### Consequence for tickets 03, 05, and 06

Ticket 06 should preserve dedicated connections for ownership and cleanup, use the pending-query path for long cancellable comparison work, and test owner responsiveness through the shared contract. It should not claim physical concurrency.

## Chunking

### Observed answer

Bounded statements also restore scheduling boundaries, but they are not required solely to achieve cancellation or owner responsiveness because `send()` already provides both inside one statement.

For the million-row comparison, sequential range chunks produced these rough statement maxima after the engine had been exercised:

| Rows per range | Total time | Longest statement |
| ---: | ---: | ---: |
| 25,000 | 2,094 ms | 646 ms |
| 100,000 | 718 ms | 84 ms |
| 250,000 | 546 ms | 141 ms |

The 25,000-row run paid compilation/cache warm-up costs and demonstrates that row count alone does not predict latency. These figures are directional, not a production chunk-size recommendation.

### Evidence

Each run populated the same comparison-shaped table using bounded `INSERT ... FULL OUTER JOIN` statements. The unchunked `send()` measurement delivered better semantics without restructuring the comparison into partial artifacts.

The review follow-up also measured the requested observable outcomes with 50,000-row chunks: the actual two-query owner row window completed in 65.2 ms while the active statement completed at 67.6 ms, and cancellation of an intentionally expensive active chunk returned `true` and rejected with `query was canceled` after 196.7 ms. The owner probe did not finish before that very short statement, but the bounded statement capped its delay at about 68 ms in this run.

### Consequence for tickets 03, 05, and 06

Do not require a chunked ComparisonExecutor design in ticket 06 based on this spike. Prefer one pending query plus `cancelSent()`; retain chunking as an optimization/fallback to investigate only if representative contract benchmarks show a need. If a blocking API must be used, start benchmarking near 100,000-250,000 rows per range and measure statement duration rather than assuming row count is sufficient.

## Ingest shape

### Observed answer

A browser-selected `File` reaches SQL as bytes registered under a runtime-controlled virtual filename:

```ts
await database.registerFileBuffer('browser-source.csv', new Uint8Array(await file.arrayBuffer()));
await connection.query(
  `SELECT * FROM read_csv_auto('browser-source.csv', all_varchar = true, delim = ',', header = true)`,
);
```

This preserves the current `read_csv_auto` option shape. A browser `File` object with the fixture's name, size, MIME type, and bytes was converted through `file.arrayBuffer()`. A sniff-only call (`all_varchar = true`) and the explicit `delim = ',', header = true` call produced identical schemas and row values on the existing fixture. One adapter detail matters: registration transfers/detaches the supplied `Uint8Array` in this build, so byte accounting must be captured before registration and callers must not expect to reuse that buffer.

### Evidence

The 662-byte `phase-2-sample.csv` fixture was wrapped as a browser `File`, registered from its bytes, and read both with sniffing and with the explicit arguments used by `WorkingCsvStore`. Both calls produced all 5 rows and the expected quoted commas/quotes, empty cells, unusual column names, and null cells. The spike used a constructed `File` rather than automating the picker because file selection is a host concern; the byte path from the resulting browser object was the seam under test.

### Consequence for tickets 03, 05, and 06

Ticket 03's host seam should expose source bytes/registration without exposing filesystem paths. Ticket 06 can reuse shared dialect option construction after substituting an adapter-owned virtual name for a native path. Capacity admission must happen before buffer registration.

### Direct WorkingCsvStore wiring

The compiled, otherwise unchanged `WorkingCsvStore` was also exercised directly against stable Wasm v1.4.3 by injecting a throwaway native-shaped connection wrapper and registering the existing fixture under the same relative name that the store passed to `read_csv_auto`. Its public `open()` and `getRows()` methods returned 5 rows, 10 user columns (all `VARCHAR`), the requested comma/header dialect, stable string row identities, literal fixture values, and null empty cells in **111 ms**. `disposeStore()` released the injected connection cleanly.

This deliberately rough experiment confirmed that the store's SQL and public result normalization work against Wasm; it did not propose an interface. It also exposed why ticket 03 must remove filesystem shape before ticket 06: passing a Windows absolute path as a registered virtual filename triggered a low-level `_setThrew is not defined` failure in the Node Wasm worker, while a runtime-controlled relative virtual name succeeded.

## Row materialization

### Observed answer

Wasm returns an Apache Arrow `Table`, not a native reader with `getRowObjectsJS()`. The direct equivalent is:

```ts
table.toArray().map((row) => row.toJSON())
```

With `all_varchar = true`, existing fixture values had the same observable shapes as native: CSV cells and the synthetic row id were strings, and empty cells were `null`. DuckDB BIGINT results remain JavaScript `bigint` unless the Wasm query config requests lossy conversion.

On the 28,958,845-byte, 100,000-row fixture, Wasm query execution took 552 ms and full object materialization took 1,043 ms. Native v1.5.5 on the same machine took 74 ms and 481 ms respectively. The small 5-row fixture took 9.7 ms to query and 0.5 ms to materialize in the final Wasm run.

### Evidence

Literal first and nullable rows matched native output field-for-field. The large fixture measured full `toArray()` plus `toJSON()` conversion rather than a lazy row window.

### Consequence for tickets 03, 05, and 06

Ticket 06's adapter must normalize Arrow rows and BIGINT values behind the database seam. Workspace queries should keep bounded windows and must not materialize an entire large Working CSV. The measured conversion cost belongs in later dual-engine contract/runtime budgeting.

## PRD correction

The PRD's engine constraints were corrected to reflect the observed pending-query behavior: execution is serialized, but `send()` yields Worker scheduling turns and `cancelSent()` cancels an in-flight pending statement. The previous statement-boundary-only cancellation and mandatory SQL chunking claims were false for both tested Wasm builds.
