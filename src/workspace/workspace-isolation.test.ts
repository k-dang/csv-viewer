import { beforeAll, describe, expect, it } from 'vitest';
// The build runs this same check via `node scripts/check-workspace-isolation.mjs`.
import {
  findWorkspaceIsolationViolations,
  isForbiddenRuntimeModule,
} from '../../scripts/check-workspace-isolation.mjs';

describe('shared workspace isolation', () => {
  let violations: Awaited<ReturnType<typeof findWorkspaceIsolationViolations>>;

  beforeAll(async () => {
    violations = await findWorkspaceIsolationViolations();
  });

  it('imports no Electron or Node runtime primitives', () => {
    expect(violations.forbiddenRuntimeImports).toEqual([]);
  });

  it('imports nothing from a runtime-specific tree such as src/main', () => {
    expect(violations.crossLayerImports).toEqual([]);
  });

  it('confines the native DuckDB driver to the named database modules', () => {
    expect(violations.unexpectedDriverImporters).toEqual([]);
  });

  it.each([
    'electron',
    'electron/main',
    'electron/renderer',
    'fs',
    'node:fs',
    'fs/promises',
    'node:fs/promises',
    'path',
    'node:path/posix',
    'child_process',
    'node:worker_threads',
  ])('rejects %s', (specifier) => {
    expect(isForbiddenRuntimeModule(specifier)).toBe(true);
  });

  it.each(['@duckdb/node-api', 'electronic-tape', './csv-query', '../shared/ipc', 'vitest'])(
    'allows %s',
    (specifier) => {
      expect(isForbiddenRuntimeModule(specifier)).toBe(false);
    },
  );
});
