import { describe, expect, it, vi } from 'vitest';
import type { ComparisonView } from '@csv-viewer/workspace/csv-viewer';
import { CsvTab } from './csv-tab';
import { comparisonFixture, workingCsvFixture } from './test-helpers/csv-views';
import { createTestCsvViewer } from './test-helpers/csv-viewer';
import {
  initialRendererWorkspace,
  projectOpenTabs,
  rendererWorkspaceReducer,
} from './workspace-tabs';

const csv = (workingCsvId: string) => workingCsvFixture({ workingCsvId });
const csvTab = (workingCsvId: string) => new CsvTab(createTestCsvViewer(), csv(workingCsvId));
const comparison = (version = 1) =>
  comparisonFixture({ version, baseline: csv('a'), candidate: csv('b') });

describe('rendererWorkspaceReducer', () => {
  it('opens, orders, selects, and closes heterogeneous tabs atomically', () => {
    const a = csvTab('a');
    let state = rendererWorkspaceReducer(initialRendererWorkspace, { type: 'open-csv', tab: a });
    state = rendererWorkspaceReducer(state, { type: 'open-csv', tab: csvTab('b') });
    state = rendererWorkspaceReducer(state, { type: 'open-comparison', comparison: comparison() });

    expect(state.tabs.map((tab) => tab.id)).toEqual(['csv:a', 'csv:b', 'comparison:comparison-1']);
    expect(state.activeTabId).toBe('comparison:comparison-1');

    state = rendererWorkspaceReducer(state, { type: 'open-csv', tab: a });
    expect(state.tabs.map((tab) => tab.id)).toEqual(['csv:a', 'csv:b', 'comparison:comparison-1']);
    expect(state.activeTabId).toBe('csv:a');
    expect(projectOpenTabs(state)[0]).toEqual({ kind: 'csv', id: 'csv:a', tab: a });

    state = rendererWorkspaceReducer(state, {
      type: 'comparison-event',
      event: { kind: 'closed', comparisonId: 'comparison-1' },
    });
    expect(state.tabs.map((tab) => tab.id)).toEqual(['csv:a', 'csv:b']);
    expect(state.activeTabId).toBe('csv:a');
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
    let state = rendererWorkspaceReducer(initialRendererWorkspace, { type: 'open-csv', tab: csvTab('a') });
    state = rendererWorkspaceReducer(state, { type: 'open-csv', tab: csvTab('b') });
    state = rendererWorkspaceReducer(state, { type: 'open-csv', tab: csvTab('c') });

    state = rendererWorkspaceReducer(state, { type: 'cycle', direction: 1 });
    expect(state.activeTabId).toBe('csv:a');
    state = rendererWorkspaceReducer(state, { type: 'cycle', direction: -1 });
    expect(state.activeTabId).toBe('csv:c');
  });

  it('selects the next tab, then the previous tab, when the active CSV closes', () => {
    let state = rendererWorkspaceReducer(initialRendererWorkspace, { type: 'open-csv', tab: csvTab('a') });
    state = rendererWorkspaceReducer(state, { type: 'open-csv', tab: csvTab('b') });
    state = rendererWorkspaceReducer(state, { type: 'open-csv', tab: csvTab('c') });
    state = rendererWorkspaceReducer(state, { type: 'select', tabId: 'csv:b' });

    state = rendererWorkspaceReducer(state, { type: 'close-csv', workingCsvId: 'b' });
    expect(state.activeTabId).toBe('csv:c');
    expect(state.tabs.some((tab) => tab.id === 'csv:b')).toBe(false);
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
