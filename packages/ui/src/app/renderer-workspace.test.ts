import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CloseImpact, CloseWorkingCsvOutcome, CsvRowWindow, CsvViewerEvent, OpenComparisonResult, OpenCsvResult } from '@csv-viewer/workspace/csv-viewer';
import { RendererWorkspace, type RendererWorkspaceHost } from './renderer-workspace';
import { comparisonFixture, workingCsvFixture } from '../test-helpers/csv-views';
import { createTestCsvViewer } from '../test-helpers/csv-viewer';

const csv = (id: string) => workingCsvFixture({ workingCsvId: id, source: { sourceId: id, name: `${id}.csv`, location: id, sizeBytes: 20 } });
const comparison = (version = 1) => comparisonFixture({ version, baseline: csv('a'), candidate: csv('b') });
const owned: RendererWorkspace[] = [];
afterEach(() => { for (const workspace of owned.splice(0)) workspace.dispose(); });

function setup(overrides: Parameters<typeof createTestCsvViewer>[0] = {}, host: Partial<RendererWorkspaceHost> = {}) {
  const listeners = new Set<(event: CsvViewerEvent) => void>();
  const unsubscribe = vi.fn();
  const viewer = createTestCsvViewer({
    ...overrides,
    handlers: {
      'csv.open': async () => ({ status: 'opened', workingCsv: csv('a') }),
      'csv.open-recent': async ({ sourceId }) => ({ status: 'opened', workingCsv: csv(sourceId) }),
      'csv.reopen': async ({ workingCsvId }) => ({ status: 'opened', workingCsv: csv(workingCsvId) }),
      'csv.close': async ({ workingCsvId }) => ({ status: 'closed', closedWorkingCsvId: workingCsvId, closedComparisonIds: [] }),
      'comparison.open': async () => ({ status: 'created', comparison: comparison() }),
      'comparison.close': async ({ comparisonId }) => ({ status: 'closed', comparisonId }),
      ...overrides.handlers,
    },
    onEvent: overrides.onEvent ?? ((listener) => {
      listeners.add(listener);
      return () => { unsubscribe(); listeners.delete(listener); };
    }),
  });
  const workspace = new RendererWorkspace(viewer, { confirmClose: () => true, ...host });
  owned.push(workspace);
  return { workspace, unsubscribe, emit: (event: CsvViewerEvent) => { for (const listener of listeners) listener(event); } };
}

function csvTab(workspace: RendererWorkspace, id: string) {
  const entry = workspace.snapshot().tabs.find((tab) => tab.id === `csv:${id}`);
  if (entry?.kind !== 'csv') throw new Error(`CSV Tab ${id} is absent.`);
  return entry.tab;
}

describe('RendererWorkspace lifecycle', () => {
  it('retains a known CSV Tab and its query, then resets that same Tab on Reopen', async () => {
    const reopened = { ...csv('a'), rowCount: 15 };
    const { workspace } = setup({ handlers: {
      'csv.open': async () => ({ status: 'already-open', workingCsv: csv('a') }),
      'csv.reopen': async () => ({ status: 'opened', workingCsv: reopened }),
    } });
    await workspace.openRecent('a');
    const tab = csvTab(workspace, 'a');
    tab.setSearch('Ada');
    tab.setSelection(['row-1']);
    await workspace.openRecent('b');
    await workspace.open();
    expect(workspace.snapshot().tabs.map((entry) => entry.id)).toEqual(['csv:a', 'csv:b']);
    expect(workspace.snapshot().activeTabId).toBe('csv:a');
    expect(csvTab(workspace, 'a')).toBe(tab);
    expect(tab.snapshot().query.search).toBe('Ada');
    await workspace.reopen();
    expect(csvTab(workspace, 'a')).toBe(tab);
    expect(tab.snapshot()).toMatchObject({ query: { search: '' }, selectedRowIds: [], workingCsv: { rowCount: 15 } });
  });

  it('shares Open/Reopen admission across commands and intents, and releases it after cancellation', async () => {
    const pending = Promise.withResolvers<OpenCsvResult>();
    const open = vi.fn(() => pending.promise);
    const reopen = vi.fn(async () => ({ status: 'opened' as const, workingCsv: csv('a') }));
    const { workspace, emit } = setup({ handlers: { 'csv.open': open, 'csv.reopen': reopen } });
    await workspace.openRecent('a');
    const first = workspace.open();
    emit({ type: 'intent', intent: 'open-csv' });
    emit({ type: 'intent', intent: 'reopen-csv' });
    await workspace.openRecent('b');
    await workspace.reopen();
    expect(open).toHaveBeenCalledTimes(1);
    expect(reopen).not.toHaveBeenCalled();
    expect(workspace.snapshot().isOpening).toBe(true);
    pending.resolve({ status: 'cancelled' });
    await first;
    await workspace.reopen();
    expect(reopen).toHaveBeenCalledTimes(1);
    expect(workspace.snapshot().isOpening).toBe(false);
    expect(workspace.snapshot().tabs).toHaveLength(1);
  });

  it('validates dialect inputs and clears busy state after failures', async () => {
    const open = vi.fn().mockRejectedValueOnce(new Error('Read failed')).mockResolvedValueOnce({ status: 'opened', workingCsv: csv('a') });
    const { workspace } = setup({ handlers: { 'csv.open': open } });
    workspace.updateDialect('xx', 'auto');
    await workspace.open();
    expect(open).not.toHaveBeenCalled();
    expect(workspace.snapshot().dialectError).toBe('Delimiter must be one character, or blank for automatic detection.');
    workspace.updateDialect(';', 'auto');
    await workspace.open();
    expect(workspace.snapshot()).toMatchObject({ dialectError: null, error: 'Read failed', isOpening: false });
    expect(open).toHaveBeenCalledWith({ operation: 'csv.open', options: { delimiter: ';' } });
    await workspace.open();
    expect(workspace.snapshot()).toMatchObject({ error: null, isOpening: false, activeTabId: 'csv:a' });
  });

  it('captures the Reopen target and focuses it on completion after selection changes', async () => {
    const pending = Promise.withResolvers<OpenCsvResult>();
    const reopen = vi.fn(() => pending.promise);
    const { workspace } = setup({ handlers: { 'csv.reopen': reopen } });
    await workspace.openRecent('a');
    await workspace.openRecent('b');
    workspace.select('csv:a');
    const completed = workspace.reopen();
    workspace.select('csv:b');
    expect(workspace.snapshot().activeTabId).toBe('csv:b');
    expect(reopen).toHaveBeenCalledWith({ operation: 'csv.reopen', workingCsvId: 'a', options: {} });
    pending.resolve({ status: 'opened', workingCsv: csv('a') });
    await completed;
    expect(workspace.snapshot().activeTabId).toBe('csv:a');
  });

  it.each(['reopen', 'open'] as const)('close wins over delayed %s, while a later explicit Open works', async (command) => {
    const pending = Promise.withResolvers<OpenCsvResult>();
    const { workspace } = setup({ handlers: { 'csv.reopen': () => pending.promise, 'csv.open': () => pending.promise } });
    await workspace.openRecent('a');
    const completed = workspace[command]();
    await workspace.close('csv:a');
    pending.resolve({ status: command === 'open' ? 'already-open' : 'opened', workingCsv: csv('a') });
    await completed;
    expect(workspace.snapshot()).toMatchObject({ tabs: [], activeTabId: null, isOpening: false, error: null });
    await workspace.openRecent('a');
    expect(workspace.snapshot().activeTabId).toBe('csv:a');
  });

  it('keeps a CSV Tab after close cancellation and applies its pending Reopen', async () => {
    const pending = Promise.withResolvers<OpenCsvResult>();
    const impact: CloseImpact = { hasUnexportedChanges: true, dependentComparisons: [] };
    const { workspace } = setup({ handlers: {
      'csv.reopen': () => pending.promise,
      'csv.close': async () => ({ status: 'confirmation-required', impact }),
    } }, { confirmClose: () => false });
    await workspace.openRecent('a');
    const completed = workspace.reopen();
    await workspace.close();
    pending.resolve({ status: 'opened', workingCsv: { ...csv('a'), rowCount: 32 } });
    await completed;
    expect(csvTab(workspace, 'a').snapshot().workingCsv.rowCount).toBe(32);
  });

  it('reconfirms changed impact, closes dependents, and preserves a newly selected Active Tab', async () => {
    const first: CloseImpact = { hasUnexportedChanges: true, dependentComparisons: [] };
    const second: CloseImpact = { ...first, dependentComparisons: [{ comparisonId: 'comparison-1', baselineName: 'a.csv', candidateName: 'b.csv' }] };
    const confirmation = Promise.withResolvers<boolean>();
    const confirm = vi.fn<RendererWorkspaceHost['confirmClose']>().mockReturnValueOnce(confirmation.promise).mockReturnValue(true);
    const close = vi.fn<() => Promise<CloseWorkingCsvOutcome>>()
      .mockResolvedValueOnce({ status: 'confirmation-required', impact: first })
      .mockResolvedValueOnce({ status: 'confirmation-required', impact: second })
      .mockResolvedValue({ status: 'closed', closedWorkingCsvId: 'a', closedComparisonIds: ['comparison-1'] });
    const { workspace } = setup({ handlers: { 'csv.close': close } }, { confirmClose: confirm });
    await workspace.openRecent('a');
    await workspace.openRecent('b');
    await workspace.openComparison('a', 'b');
    workspace.select('csv:a');
    const completed = workspace.close();
    await vi.waitFor(() => expect(confirm).toHaveBeenCalledOnce());
    workspace.select('csv:b');
    confirmation.resolve(true);
    await completed;
    expect(confirm.mock.calls).toEqual([['a.csv', first], ['a.csv', second]]);
    expect(close.mock.calls).toEqual([
      [{ operation: 'csv.close', workingCsvId: 'a' }],
      [{ operation: 'csv.close', workingCsvId: 'a', confirmedImpact: first }],
      [{ operation: 'csv.close', workingCsvId: 'a', confirmedImpact: second }],
    ]);
    expect(workspace.snapshot().tabs.map((tab) => tab.id)).toEqual(['csv:b']);
    expect(workspace.snapshot().activeTabId).toBe('csv:b');
  });

  it('cycles with wraparound and chooses the next, then previous neighbor on close', async () => {
    const { workspace } = setup();
    for (const id of ['a', 'b', 'c']) await workspace.openRecent(id);
    workspace.cycle(1);
    expect(workspace.snapshot().activeTabId).toBe('csv:a');
    workspace.cycle(-1);
    expect(workspace.snapshot().activeTabId).toBe('csv:c');
    workspace.select('csv:b');
    await workspace.close();
    expect(workspace.snapshot().activeTabId).toBe('csv:c');
    await workspace.close();
    expect(workspace.snapshot().activeTabId).toBe('csv:a');
    await workspace.close();
    expect(workspace.snapshot().activeTabId).toBeNull();
  });

  it('routes Comparison projections to the same Comparison Tab and removes it on close', async () => {
    const { workspace, emit } = setup();
    await workspace.openRecent('a');
    await workspace.openRecent('b');
    await workspace.openComparison('a', 'b');
    const entry = workspace.snapshot().tabs.at(-1);
    if (entry?.kind !== 'comparison') throw new Error('Comparison Tab is absent.');
    entry.tab.setRowsMode('all');
    emit({ type: 'comparison', event: { kind: 'changed', comparison: comparison(3) } });
    await workspace.openComparison('a', 'b');
    expect(workspace.snapshot().tabs.at(-1)?.tab).toBe(entry.tab);
    expect(entry.tab.snapshot()).toMatchObject({ comparison: { version: 3 }, rows: 'all' });
    emit({ type: 'comparison', event: { kind: 'closed', comparisonId: 'comparison-1' } });
    expect(workspace.snapshot().tabs.map((tab) => tab.id)).toEqual(['csv:a', 'csv:b']);
  });

  it('does not restore a Comparison Tab from an open response delivered after close', async () => {
    const pending = Promise.withResolvers<OpenComparisonResult>();
    const open = vi.fn().mockResolvedValueOnce({ status: 'created', comparison: comparison() }).mockReturnValue(pending.promise);
    const { workspace } = setup({ handlers: { 'comparison.open': open } });
    await workspace.openRecent('a');
    await workspace.openRecent('b');
    await workspace.openComparison('a', 'b');
    const completed = workspace.openComparison('a', 'b');
    await workspace.close();
    pending.resolve({ status: 'existing', comparison: comparison() });
    expect(await completed).toBe(false);
    expect(workspace.snapshot().tabs.map((tab) => tab.id)).toEqual(['csv:a', 'csv:b']);
  });

  it('retains Tabs on cleanup failure and allows a later close retry', async () => {
    const close = vi.fn<() => Promise<CloseWorkingCsvOutcome>>()
      .mockResolvedValueOnce({ status: 'failed', failure: { code: 'cleanup-failed', message: 'Retry cleanup', retryable: true } })
      .mockResolvedValue({ status: 'closed', closedWorkingCsvId: 'a', closedComparisonIds: [] });
    const { workspace } = setup({ handlers: { 'csv.close': close } });
    await workspace.open();
    await workspace.close();
    expect(workspace.snapshot()).toMatchObject({ activeTabId: 'csv:a', error: 'Retry cleanup' });
    await workspace.close();
    expect(workspace.snapshot().tabs).toEqual([]);
  });

  it.each(['dispose', 'fatal'] as const)('rejects late results and further intents after %s', async (ending) => {
    const pending = Promise.withResolvers<OpenCsvResult>();
    const open = vi.fn(() => pending.promise);
    const { workspace, emit, unsubscribe } = setup({ handlers: { 'csv.open': open } });
    const completed = workspace.open();
    if (ending === 'dispose') workspace.dispose();
    else emit({ type: 'fatal-error', message: '' });
    const stopped = workspace.snapshot();
    pending.resolve({ status: 'opened', workingCsv: csv('a') });
    await completed;
    emit({ type: 'intent', intent: 'open-csv' });
    await workspace.open();
    expect(workspace.snapshot()).toBe(stopped);
    expect(workspace.snapshot().tabs).toHaveLength(0);
    expect(open).toHaveBeenCalledOnce();
    expect(unsubscribe).toHaveBeenCalledOnce();
    if (ending === 'fatal') expect(stopped.fatalError).toBe('');
  });

  it('releases a subscription even when it immediately replays a fatal event', () => {
    const unsubscribe = vi.fn();
    const { workspace } = setup({ onEvent: (listener) => { listener({ type: 'fatal-error', message: 'Stopped' }); return unsubscribe; } });
    expect(workspace.snapshot().fatalError).toBe('Stopped');
    workspace.dispose();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it.each(['close', 'dispose', 'fatal'] as const)('disposes owned CSV Tabs on %s so their pending rows are discarded', async (ending) => {
    const pending = Promise.withResolvers<CsvRowWindow>();
    const { workspace, emit } = setup({ handlers: { 'csv.get-rows': () => pending.promise } });
    await workspace.open();
    const rows = csvTab(workspace, 'a').rows(0, 100);
    if (ending === 'close') await workspace.close();
    else if (ending === 'dispose') workspace.dispose();
    else emit({ type: 'fatal-error', message: 'Stopped' });
    pending.resolve({ workingCsvId: 'a', offset: 0, filteredRowCount: 1, rows: [] });
    expect(await rows).toBeNull();
  });

  it('does not submit confirmed close after the renderer is disposed during the prompt', async () => {
    const confirmation = Promise.withResolvers<boolean>();
    const confirm = vi.fn(() => confirmation.promise);
    const close = vi.fn<() => Promise<CloseWorkingCsvOutcome>>().mockResolvedValue({
      status: 'confirmation-required', impact: { hasUnexportedChanges: true, dependentComparisons: [] },
    });
    const { workspace } = setup({ handlers: { 'csv.close': close } }, { confirmClose: confirm });
    await workspace.open();
    const completed = workspace.close();
    await vi.waitFor(() => expect(confirm).toHaveBeenCalledOnce());
    workspace.dispose();
    confirmation.resolve(true);
    await completed;
    expect(close).toHaveBeenCalledOnce();
  });
});

describe('recent sources', () => {
  const sources = [{ sourceId: 'a', name: 'a.csv', location: '/a.csv', sizeBytes: 20, lastOpenedAt: '2026-01-01T00:00:00.000Z' }];

  it('loads initially, refreshes after failed opens, and reloads after closing the last tab', async () => {
    const recent = vi.fn().mockResolvedValueOnce(sources).mockResolvedValueOnce([]).mockResolvedValue(sources);
    const openRecent = vi.fn().mockResolvedValue({ status: 'failed', message: 'Missing source' });
    const { workspace } = setup({ handlers: { 'csv.get-recent-sources': recent, 'csv.open-recent': openRecent } });
    await vi.waitFor(() => expect(workspace.snapshot().recentSources).toEqual(sources));
    await workspace.openRecent('a');
    expect(workspace.snapshot().recentSources).toEqual([]);
    await workspace.open();
    expect(recent).toHaveBeenCalledTimes(2);
    await workspace.close();
    await vi.waitFor(() => expect(workspace.snapshot().recentSources).toEqual(sources));
    expect(recent).toHaveBeenCalledTimes(3);
  });

  it('does not request recent sources when the runtime cannot reopen them', async () => {
    const recent = vi.fn();
    const { workspace } = setup({ capabilities: { recentCsvSources: false }, handlers: { 'csv.get-recent-sources': recent } });
    await workspace.open();
    await workspace.close();
    expect(recent).not.toHaveBeenCalled();
  });

  it('ignores old history responses after an open attempt or disposal', async () => {
    const first = Promise.withResolvers<typeof sources>();
    const last = Promise.withResolvers<typeof sources>();
    const recent = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValueOnce([]).mockReturnValueOnce(last.promise);
    const { workspace } = setup({ handlers: {
      'csv.get-recent-sources': recent,
      'csv.open': async () => ({ status: 'cancelled' }),
    } });
    await workspace.open();
    first.resolve(sources);
    await first.promise;
    expect(workspace.snapshot().recentSources).toEqual([]);
    const opening = workspace.open();
    await vi.waitFor(() => expect(recent).toHaveBeenCalledTimes(3));
    workspace.dispose();
    last.resolve(sources);
    await opening;
    expect(workspace.snapshot().recentSources).toEqual([]);
  });
});
