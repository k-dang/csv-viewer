import { defineCsvWorkspaceContract } from '../../../packages/workspace/test/contract/csv-workspace-contract';
import { CsvWorkspaceFixture } from './fixtures/desktop-workspace';

defineCsvWorkspaceContract({
  name: 'native DuckDB',
  create: (executor, diagnostics) => CsvWorkspaceFixture.create(executor, diagnostics),
});
