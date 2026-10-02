import '@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js';

// DuckDB can leave its startup task pending when an asset fetch rejects. Convert uncaught
// Worker rejections to error events so the runtime stops the engine and settles pending calls.
globalThis.addEventListener('unhandledrejection', (event) => {
  event.preventDefault();
  throw new Error('The data engine Worker failed.', { cause: event.reason });
});
