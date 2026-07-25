import { describe, expect, it } from 'vitest';
import type { ComparisonView, CsvSessionMetadata } from '../shared/ipc';
import { initialRendererWorkspace, rendererWorkspaceReducer } from './workspace-tabs';

function csv(sessionId: string): CsvSessionMetadata {
  return {
    sessionId,
    dataRevision: 0,
    file: { path: `C:/${sessionId}.csv`, name: `${sessionId}.csv`, sizeBytes: 10 },
    columns: [{ name: 'id', type: 'VARCHAR' }],
    rowCount: 1,
    dialect: {},
  };
}

function comparison(version = 1): ComparisonView {
  return {
    comparisonId: 'comparison-1',
    version,
    baseline: csv('a'),
    candidate: csv('b'),
    availableKeyColumns: ['id'],
    operation: null,
    applied: null,
    lastAttempt: null,
  };
}

describe('rendererWorkspaceReducer', () => {
  it('opens, orders, selects, and closes heterogeneous tabs atomically', () => {
    let state = rendererWorkspaceReducer(initialRendererWorkspace, {
      type: 'open-csv',
      session: csv('a'),
    });
    state = rendererWorkspaceReducer(state, { type: 'open-csv', session: csv('b') });
    state = rendererWorkspaceReducer(state, { type: 'open-comparison', comparison: comparison() });

    expect(state.tabs.map((tab) => tab.id)).toEqual(['csv:a', 'csv:b', 'comparison:comparison-1']);
    expect(state.activeTabId).toBe('comparison:comparison-1');

    state = rendererWorkspaceReducer(state, {
      type: 'comparison-event',
      event: { kind: 'closed', comparisonId: 'comparison-1' },
    });
    expect(state.tabs.map((tab) => tab.id)).toEqual(['csv:a', 'csv:b']);
    expect(state.activeTabId).toBe('csv:b');
    expect(state.comparisons.has('comparison-1')).toBe(false);
  });

  it('ignores obsolete comparison projections without disturbing presentation state', () => {
    let state = rendererWorkspaceReducer(initialRendererWorkspace, {
      type: 'open-comparison',
      comparison: comparison(3),
    });
    state = rendererWorkspaceReducer(state, {
      type: 'update-comparison-presentation',
      comparisonId: 'comparison-1',
      presentation: { draftKey: ['id'], rows: 'all', columns: 'csv-order' },
    });
    const unchanged = rendererWorkspaceReducer(state, {
      type: 'comparison-event',
      event: { kind: 'changed', comparison: comparison(2) },
    });

    expect(unchanged).toBe(state);
    expect(unchanged.tabs[0]).toMatchObject({
      kind: 'comparison',
      presentation: { draftKey: ['id'], rows: 'all', columns: 'csv-order' },
    });
  });
});
