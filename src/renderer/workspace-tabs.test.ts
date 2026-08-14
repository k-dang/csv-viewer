import { describe, expect, it, vi } from 'vitest';
import type { ComparisonView, WorkingCsvView } from '../shared/ipc';
import {
  initialRendererWorkspace,
  projectOpenTabs,
  rendererWorkspaceReducer,
} from './workspace-tabs';

function csv(workingCsvId: string): WorkingCsvView {
  return {
    workingCsvId,
    dataRevision: 0,
    file: { path: `C:/${workingCsvId}.csv`, name: `${workingCsvId}.csv`, sizeBytes: 10 },
    columns: [{ name: 'id', type: 'VARCHAR' }],
    rowCount: 1,
    dialect: {},
    editState: { workingCsvId, hasUnexportedChanges: false, canUndo: false, canRedo: false },
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

  it('cycles through tabs in both directions with wraparound', () => {
    let state = rendererWorkspaceReducer(initialRendererWorkspace, {
      type: 'open-csv',
      session: csv('a'),
    });
    state = rendererWorkspaceReducer(state, { type: 'open-csv', session: csv('b') });
    state = rendererWorkspaceReducer(state, { type: 'open-csv', session: csv('c') });

    state = rendererWorkspaceReducer(state, { type: 'cycle', direction: 1 });
    expect(state.activeTabId).toBe('csv:a');
    state = rendererWorkspaceReducer(state, { type: 'cycle', direction: -1 });
    expect(state.activeTabId).toBe('csv:c');
  });

  it('selects the next tab, then the previous tab, when the active CSV closes', () => {
    let state = rendererWorkspaceReducer(initialRendererWorkspace, {
      type: 'open-csv',
      session: csv('a'),
    });
    state = rendererWorkspaceReducer(state, { type: 'open-csv', session: csv('b') });
    state = rendererWorkspaceReducer(state, { type: 'open-csv', session: csv('c') });
    state = rendererWorkspaceReducer(state, { type: 'select', tabId: 'csv:b' });

    state = rendererWorkspaceReducer(state, { type: 'close-csv', workingCsvId: 'b' });
    expect(state.activeTabId).toBe('csv:c');
    state = rendererWorkspaceReducer(state, { type: 'close-csv', workingCsvId: 'c' });
    expect(state.activeTabId).toBe('csv:a');
    state = rendererWorkspaceReducer(state, { type: 'close-csv', workingCsvId: 'a' });
    expect(state.activeTabId).toBeNull();
  });

  it('omits an orphaned comparison tab from the rendered projection', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const state = rendererWorkspaceReducer(initialRendererWorkspace, {
      type: 'open-comparison',
      comparison: comparison(),
    });
    const orphaned = { ...state, comparisons: new Map<string, ComparisonView>() };

    expect(projectOpenTabs(orphaned)).toEqual([]);
    expect(error).toHaveBeenCalledWith(
      'Renderer Comparison Tab comparison-1 has no projection.',
    );
    error.mockRestore();
  });
});
