import { afterAll } from 'vitest';

afterAll(async () => {
  // Imported lazily so files that never touch DuckDB-Wasm do not load the helper or its engine.
  const { closeSharedWasmEngine } = await import('./packages/workspace/test-helpers/wasm-workspace');
  await closeSharedWasmEngine();
});
