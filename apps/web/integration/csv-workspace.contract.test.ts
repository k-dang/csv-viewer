import { describe } from 'vitest';
import { defineCsvWorkspaceContract } from '../../../packages/workspace/test/contract/csv-workspace-contract';
import { WasmWorkspaceFixture } from './fixtures/wasm-workspace';

// The first case compiles the real Wasm engine before exercising the contract.
describe('Wasm workspace', { timeout: 15_000 }, () => {
  defineCsvWorkspaceContract({
    name: 'DuckDB-Wasm',
    create: (executor, diagnostics) => WasmWorkspaceFixture.create(executor, diagnostics),
  });
});
