import { describe, expect, it, vi } from 'vitest';
import type { ComparisonMutationOutcome, ComparisonRow, ComparisonView, ComparisonWindowOutcome } from '@csv-viewer/workspace/csv-viewer';
import { ComparisonTab } from './comparison-tab';
import { comparisonFixture } from '../test-helpers/csv-views';
import { createTestCsvViewer } from '../test-helpers/csv-viewer';

const invalidKey: ComparisonView['lastAttempt'] = {
  attemptId: 'attempt-1',
  status: 'invalid-key',
  diagnostics: {
    key: ['id'],
    baseline: { blankRowCount: 1, duplicateGroupCount: 0, blankExamples: [], duplicateExamples: [] },
    candidate: { blankRowCount: 0, duplicateGroupCount: 0, blankExamples: [], duplicateExamples: [] },
  },
};

const applied = (resultToken: string): NonNullable<ComparisonView['applied']> => ({
  key: ['id'],
  resultToken,
  freshness: { kind: 'current' },
  summary: {
    rows: { total: 1, changed: 0, baselineOnly: 0, candidateOnly: 0, unchanged: 1 },
    changedColumns: [],
  },
});

const window = (resultToken: string): ComparisonWindowOutcome => ({
  status: 'ready',
  window: { comparisonId: 'comparison-1', resultToken, offset: 0, totalRowCount: 0, keyColumns: ['id'], rows: [] },
});

describe('ComparisonTab', () => {
  it('drafts a Comparison Key in order and applies it', async () => {
    const begin = vi.fn(async () => ({ status: 'accepted' as const, operationId: 'operation-1' }));
    const tab = new ComparisonTab(createTestCsvViewer({ handlers: { 'comparison.begin': begin } }), comparisonFixture({
      availableKeyColumns: ['id', 'region', 'sku'],
    }));

    tab.toggleKeyColumn('region', true);
    tab.toggleKeyColumn('sku', true);
    tab.toggleKeyColumn('sku', true);
    tab.moveKeyColumn(1, -1);
    tab.moveKeyColumn(0, -1);
    expect(tab.snapshot().draftKey).toEqual(['sku', 'region']);

    await tab.applyKey();
    expect(begin).toHaveBeenCalledWith({ operation: 'comparison.begin', kind: 'apply-key', comparisonId: 'comparison-1', key: ['sku', 'region'] });

    tab.toggleKeyColumn('sku', false);
    tab.toggleKeyColumn('region', false);
    await tab.applyKey();
    expect(begin).toHaveBeenCalledTimes(1);
  });

  it('hides the current invalid-key diagnostics once the draft is edited', () => {
    const tab = new ComparisonTab(createTestCsvViewer(), comparisonFixture({ lastAttempt: invalidKey }));
    tab.toggleKeyColumn('id', true);
    expect(tab.snapshot().acknowledgedAttemptId).toBe('attempt-1');
    tab.receive(comparisonFixture({ version: 2, lastAttempt: { ...invalidKey, attemptId: 'attempt-2' } }));
    expect(tab.snapshot().acknowledgedAttemptId).toBe('attempt-1');
  });

  it('surfaces a rejected command and a failed call as the action error, clearing it on the next command', async () => {
    const swap = vi.fn()
      .mockResolvedValueOnce({ status: 'rejected', fault: { code: 'incompatible-columns', message: 'Sides differ.' } })
      .mockRejectedValueOnce(new Error(''))
      .mockResolvedValueOnce({ status: 'changed', comparison: comparisonFixture({ version: 5 }) });
    const tab = new ComparisonTab(createTestCsvViewer({ handlers: { 'comparison.swap': swap } }), comparisonFixture());

    await tab.swap();
    expect(tab.snapshot().actionError).toBe('Sides differ.');
    await tab.swap();
    expect(tab.snapshot().actionError).toBe('Unable to swap comparison sides.');
    await tab.swap();
    expect(tab.snapshot().actionError).toBeNull();
    expect(tab.snapshot().comparison.version).toBe(5);
  });

  it('refreshes only an applied result and cancels only an operation in flight', async () => {
    const begin = vi.fn(async () => ({ status: 'accepted' as const, operationId: 'operation-2' }));
    const cancel = vi.fn(async () => ({ status: 'requested' as const }));
    const tab = new ComparisonTab(createTestCsvViewer({ handlers: { 'comparison.begin': begin, 'comparison.cancel': cancel } }), comparisonFixture());

    await tab.refresh();
    await tab.cancel();
    expect(begin).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();

    tab.receive(comparisonFixture({ version: 2, applied: applied('result-1') }));
    await tab.refresh();
    expect(begin).toHaveBeenCalledWith({ operation: 'comparison.begin', kind: 'refresh', comparisonId: 'comparison-1' });

    tab.receive(comparisonFixture({ version: 3, operation: { operationId: 'operation-2', intent: 'refresh', phase: 'comparing' } }));
    await tab.cancel();
    expect(cancel).toHaveBeenCalledWith({ operation: 'comparison.cancel', comparisonId: 'comparison-1', operationId: 'operation-2' });
  });

  it('ignores older projections and drops results after dispose', async () => {
    const swap = vi.fn().mockResolvedValue({ status: 'rejected', fault: { code: 'incompatible-columns', message: 'Late.' } });
    const tab = new ComparisonTab(createTestCsvViewer({ handlers: { 'comparison.swap': swap } }), comparisonFixture({ version: 3 }));
    tab.receive(comparisonFixture({ version: 2, availableKeyColumns: ['old'] }));
    expect(tab.snapshot().comparison.version).toBe(3);

    const settled = tab.swap();
    tab.dispose();
    await settled;
    expect(tab.snapshot().actionError).toBeNull();
  });

  it('serves a row window under the current view mode and drops one the result or mode moved past', async () => {
    const getWindow = vi.fn(async ({ resultToken }: { resultToken: string }) => window(resultToken));
    const tab = new ComparisonTab(createTestCsvViewer({ handlers: { 'comparison.get-window': getWindow } }), comparisonFixture());

    expect(await tab.rows(0, 100)).toBeNull();
    expect(getWindow).not.toHaveBeenCalled();

    tab.receive(comparisonFixture({ version: 2, applied: applied('result-1') }));
    tab.setRowsMode('all');
    expect((await tab.rows(0, 100))?.resultToken).toBe('result-1');
    expect(getWindow).toHaveBeenLastCalledWith({
      operation: 'comparison.get-window',
      comparisonId: 'comparison-1',
      resultToken: 'result-1',
      offset: 0,
      limit: 100,
      rows: 'all',

      search: '',
      order: 'changed-first',
    });

    const pendingMode = tab.rows(0, 100);
    tab.setOrder('csv-order');
    expect(await pendingMode).toBeNull();

    const pendingResult = tab.rows(0, 100);
    tab.receive(comparisonFixture({ version: 3, applied: applied('result-2') }));
    expect(await pendingResult).toBeNull();
  });

  it('drops a pending row window after disposal and does not start more requests', async () => {
    const pending = Promise.withResolvers<ComparisonWindowOutcome>();
    const getWindow = vi.fn(() => pending.promise);
    const swap = vi.fn();
    const tab = new ComparisonTab(createTestCsvViewer({ handlers: {
      'comparison.get-window': getWindow,
      'comparison.swap': swap,
    } }), comparisonFixture({ applied: applied('result-1') }));

    const rows = tab.rows(0, 100);
    tab.dispose();
    pending.resolve(window('result-1'));
    expect(await rows).toBeNull();
    expect(await tab.rows(0, 100)).toBeNull();
    await tab.swap();
    expect(getWindow).toHaveBeenCalledTimes(1);
    expect(swap).not.toHaveBeenCalled();
  });

  it('keeps selection across views and a later row choice when page navigation finishes', async () => {
    const row = (id: string): ComparisonRow => ({
      keyValues: [id], classification: 'unchanged', baseline: { rowId: id, values: [] },
      candidate: { rowId: id, values: [] }, changed: [],
    });
    const nextPage = Promise.withResolvers<ComparisonWindowOutcome>();
    const getWindow = vi.fn().mockResolvedValueOnce({
      status: 'ready', window: { comparisonId: 'comparison-1', resultToken: 'result-1',
        offset: 0, totalRowCount: 205, keyColumns: ['id'], rows: [row('1')] },
    }).mockReturnValueOnce(nextPage.promise);
    const tab = new ComparisonTab(createTestCsvViewer({ handlers: {
      'comparison.get-window': getWindow,
    } }), comparisonFixture({ applied: applied('result-1') }));
    const firstPage = await tab.rows(0, 100);
    if (!firstPage) throw new Error('Missing first page.');
    tab.receiveRows(firstPage, tab.snapshot().queryVersion);
    expect(getWindow).toHaveBeenCalledTimes(1);
    tab.setView('grid');
    tab.setChangedOnly(false);
    expect(tab.snapshot().selection?.row.keyValues).toEqual(['1']);
    const selecting = tab.selectIndex(100);
    tab.inspectRow(row('50'), 49);
    nextPage.resolve({ status: 'ready', window: {
      comparisonId: 'comparison-1', resultToken: 'result-1', offset: 100,
      totalRowCount: 205, keyColumns: ['id'], rows: [row('101')],
    } });
    await selecting;
    expect(tab.snapshot().selection?.row.keyValues).toEqual(['50']);
    expect(tab.snapshot().selectionLoading).toBe(false);
    expect(tab.snapshot().view).toBe('inspector');
    tab.setRowsMode('all');
    expect(tab.snapshot().selection).toBeNull();
  });

  it('keeps the original row-window rejection for the caller', async () => {
    const failure = new Error('The row request failed.');
    const tab = new ComparisonTab(createTestCsvViewer({ handlers: {
      'comparison.get-window': vi.fn().mockRejectedValue(failure),
    } }), comparisonFixture({ applied: applied('result-1') }));

    await expect(tab.rows(0, 100)).rejects.toBe(failure);
    expect(tab.snapshot().actionError).toBeNull();
  });

  it('commits search once after typing pauses and cancels the timer on disposal', async () => {
    vi.useFakeTimers();
    try {
      const getWindow = vi.fn(async () => window('result-1'));
      const tab = new ComparisonTab(createTestCsvViewer({ handlers: {
        'comparison.get-window': getWindow,
      } }), comparisonFixture({ applied: applied('result-1') }));
      const version = tab.snapshot().queryVersion;
      tab.setSearch('N');
      await vi.advanceTimersByTimeAsync(100);
      tab.setSearch('New');
      await vi.advanceTimersByTimeAsync(149);
      expect(tab.snapshot()).toMatchObject({ search: 'New', queryVersion: version });
      await tab.rows(0, 100);
      expect(getWindow).toHaveBeenLastCalledWith(expect.objectContaining({ search: '' }));
      await vi.advanceTimersByTimeAsync(1);
      expect(tab.snapshot().queryVersion).toBe(version + 1);
      await tab.rows(0, 100);
      expect(getWindow).toHaveBeenLastCalledWith(expect.objectContaining({ search: 'New' }));
      tab.setSearch('Other');
      tab.dispose();
      await vi.advanceTimersByTimeAsync(150);
      expect(tab.snapshot().queryVersion).toBe(version + 1);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    { status: 'result-replaced', currentResultToken: 'result-2' },
    { status: 'comparison-not-found' },
  ] as const)('silently discards $status instead of reporting a read failure', async outcome => {
    const getWindow = vi.fn().mockResolvedValueOnce(outcome).mockResolvedValueOnce(window('result-1'));
    const tab = new ComparisonTab(createTestCsvViewer({ handlers: {
      'comparison.get-window': getWindow,
    } }), comparisonFixture({ applied: applied('result-1') }));
    expect(await tab.rows(0, 100)).toBeNull();
    expect(tab.snapshot().rowsError).toBeNull();
    expect(await tab.rows(0, 100)).not.toBeNull();
  });

  it('keeps a newer projection when a pending swap completes with an older one', async () => {
    const pending = Promise.withResolvers<ComparisonMutationOutcome>();
    const tab = new ComparisonTab(createTestCsvViewer({ handlers: {
      'comparison.swap': () => pending.promise,
    } }), comparisonFixture());

    const swap = tab.swap();
    tab.receive(comparisonFixture({ version: 3, availableKeyColumns: ['current'] }));
    pending.resolve({ status: 'changed', comparison: comparisonFixture({ version: 2, availableKeyColumns: ['old'] }) });
    await swap;
    expect(tab.snapshot().comparison.version).toBe(3);
    expect(tab.snapshot().comparison.availableKeyColumns).toEqual(['current']);
  });

  it('dismisses the current attempt banner', () => {
    const tab = new ComparisonTab(createTestCsvViewer(), comparisonFixture({
      lastAttempt: { attemptId: 'attempt-9', status: 'cancelled' },
    }));
    tab.dismissAttempt();
    expect(tab.snapshot().acknowledgedAttemptId).toBe('attempt-9');
  });
});
