import { defineCsvWorkspaceContract } from '../../../packages/workspace/test/contract/csv-workspace-contract';
import { WasmWorkspaceFixture } from './fixtures/wasm-workspace';

defineCsvWorkspaceContract({
  name: 'DuckDB-Wasm',
  create: (executor, diagnostics) => WasmWorkspaceFixture.create(executor, diagnostics),
});
