import { afterAll } from 'vitest';

afterAll(async () => {
  // Imported lazily so files that never touch DuckDB-Wasm do not load the helper or its engine.
  const { closeSharedWasmEngine } = await import('./apps/web/integration/fixtures/wasm-workspace');
  await closeSharedWasmEngine();
});
