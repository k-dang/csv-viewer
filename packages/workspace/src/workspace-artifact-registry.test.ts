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
      owner: { kind: 'comparison', comparisonId: 'comparison-1' },
      role: 'active',
      operationId: 'operation-1',
    });

    expect(() => registry.assertNoArtifactsOwnedBy('comparison')).toThrow(
      'comparison artifacts remain',
    );
    registry.transition('csv_comparison_operation', 'retired');
    registry.remove('csv_comparison_operation');
    expect(() => registry.assertNoArtifactsOwnedBy('comparison')).not.toThrow();
  });
});
