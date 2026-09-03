import mainModule from '@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url';
import mainWorker from '@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url';
import { DuckDbWasmWorkspaceDatabase } from './duckdb-wasm-database';

/** Creates the browser's single-threaded database from assets emitted by the web build. */
export function createWebDuckDb(): DuckDbWasmWorkspaceDatabase {
  return new DuckDbWasmWorkspaceDatabase({
    mainModule: localExecutableAsset(mainModule, window.location.href),
    mainWorker: localExecutableAsset(mainWorker, window.location.href),
    createWorker: (reference) => Promise.resolve(new Worker(reference)),
  });
}

/** Keeps Vite's emitted asset URL on this origin before it reaches the network-isolated adapter. */
export function localExecutableAsset(reference: string, pageUrl: string): string {
  const page = new URL(pageUrl);
  const asset = new URL(reference, page);
  if (asset.origin !== page.origin) {
    throw new Error('DuckDB-Wasm executable assets must use the same origin as CSV Viewer Web.');
  }
  return `${asset.pathname}${asset.search}`;
}
