import { describe, expect, it } from 'vitest';
// The build runs this same check via `node scripts/check-workspace-isolation.mjs`.
import { findWorkspaceIsolationViolations } from '../../scripts/check-workspace-isolation.mjs';

describe('shared workspace isolation', () => {
  it('imports no Electron or Node runtime primitives', async () => {
    const { forbiddenRuntimeImports } = await findWorkspaceIsolationViolations();
    expect(forbiddenRuntimeImports).toEqual([]);
  });

  it('confines the native DuckDB driver to the named database modules', async () => {
    const { unexpectedDriverImporters } = await findWorkspaceIsolationViolations();
    expect(unexpectedDriverImporters).toEqual([]);
  });
});
