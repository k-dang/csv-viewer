import { describe, expect, it } from 'vitest';
import { WorkspaceArtifactRegistry } from './workspace-artifact-registry';

describe('WorkspaceArtifactRegistry', () => {
  it('tracks ownership and lifecycle roles for generated tables', () => {
    const registry = new WorkspaceArtifactRegistry();

    registry.register({
      tableName: 'csv_session_physical',
      owner: { kind: 'working-csv', workingCsvId: 'working-1' },
      role: 'staging',
    });
    registry.transition('csv_session_physical', 'current');

    expect(registry.get('csv_session_physical')).toEqual({
      tableName: 'csv_session_physical',
      owner: { kind: 'working-csv', workingCsvId: 'working-1' },
      role: 'current',
    });

    registry.transition('csv_session_physical', 'retired');
    registry.remove('csv_session_physical');
    expect(() => registry.assertEmpty()).not.toThrow();
  });

  it('audits comparison artifacts independently from current sources', () => {
    const registry = new WorkspaceArtifactRegistry();
    registry.register({
      tableName: 'csv_session_physical',
      owner: { kind: 'working-csv', workingCsvId: 'working-1' },
      role: 'current',
    });
    registry.register({
      tableName: 'csv_comparison_operation',
      owner: { kind: 'comparison', comparisonId: 'comparison-1', operationId: 'operation-1' },
      role: 'active',
    });

    expect(registry.list().map((artifact) => artifact.tableName)).toEqual([
      'csv_session_physical',
      'csv_comparison_operation',
    ]);

    expect(() => registry.assertNoArtifactsOwnedBy('comparison')).toThrow(
      'comparison artifacts remain',
    );
    registry.transition('csv_comparison_operation', 'retired');
    registry.remove('csv_comparison_operation');
    expect(() => registry.assertNoArtifactsOwnedBy('comparison')).not.toThrow();
  });

  it('rejects a duplicate registration and a missing artifact', () => {
    const registry = new WorkspaceArtifactRegistry();
    registry.register({
      tableName: 'csv_session_physical',
      owner: { kind: 'working-csv', workingCsvId: 'working-1' },
      role: 'staging',
    });

    expect(() => registry.register({
      tableName: 'csv_session_physical',
      owner: { kind: 'working-csv', workingCsvId: 'working-2' },
      role: 'current',
    })).toThrow('Workspace artifact csv_session_physical is already registered.');
    expect(registry.get('csv_session_physical')).toEqual({
      tableName: 'csv_session_physical',
      owner: { kind: 'working-csv', workingCsvId: 'working-1' },
      role: 'staging',
    });
    expect(registry.get('missing')).toBeNull();
    expect(() => registry.transition('missing', 'current')).toThrow(
      'Workspace artifact missing is not registered.',
    );
    expect(() => registry.remove('missing')).toThrow(
      'Workspace artifact missing is not registered.',
    );
    expect(() => registry.assertEmpty()).toThrow(
      'Workspace artifact invariant violated: registered artifacts remain.',
    );
  });

  it('returns copies so a caller cannot change the registered artifact', () => {
    const registry = new WorkspaceArtifactRegistry();
    registry.register({
      tableName: 'csv_session_physical',
      owner: { kind: 'working-csv', workingCsvId: 'working-1' },
      role: 'staging',
    });

    const read = registry.get('csv_session_physical');
    expect(read).toEqual({
      tableName: 'csv_session_physical',
      owner: { kind: 'working-csv', workingCsvId: 'working-1' },
      role: 'staging',
    });
    if (!read || read.owner.kind !== 'working-csv') throw new Error('Expected the registered working CSV artifact.');
    read.role = 'retired';
    read.owner.workingCsvId = 'changed';

    const listed = registry.list()[0];
    expect(listed).toBeDefined();
    if (!listed || listed.owner.kind !== 'working-csv') throw new Error('Expected the listed working CSV artifact.');
    listed.role = 'active';
    listed.owner.workingCsvId = 'listed';

    expect(registry.get('csv_session_physical')).toEqual({
      tableName: 'csv_session_physical',
      owner: { kind: 'working-csv', workingCsvId: 'working-1' },
      role: 'staging',
    });
  });
});
