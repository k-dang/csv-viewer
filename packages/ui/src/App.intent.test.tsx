// @vitest-environment jsdom
import { act, cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CsvViewerEvent, WorkingCsvView } from '@csv-viewer/workspace/csv-viewer';
import { App } from './App';
import { CsvViewerProvider } from './csv-viewer';
import { workingCsvFixture } from './test-helpers/csv-views';
import { createTestCsvViewer } from './test-helpers/csv-viewer';

/** Calls a rendered CSV Tab makes on its own, leaving each test to stub what it asserts on. */
const tabHandlers = (workingCsv: WorkingCsvView) => ({
  'csv.get-recent-sources': async () => [],
  'csv.get-edit-state': async () => workingCsv.editState,
  'csv.get-rows': async () => ({
    workingCsvId: workingCsv.workingCsvId,
    offset: 0,
    rows: [],
    filteredRowCount: 0,
  }),
});

beforeEach(() => {
  // jsdom ships neither of these: the App reads matchMedia for the initial theme and confirm on close.
  vi.stubGlobal('matchMedia', () => ({ matches: false }));
  vi.spyOn(window, 'confirm').mockReturnValue(true);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe('App CsvViewer intents', () => {
  it('maps all four menu intents to the active CsvViewer behavior', async () => {
    const workingCsv = workingCsvFixture();
    const open = vi.fn(async () => ({ status: 'opened' as const, workingCsv }));
    const reopen = vi.fn(async () => ({ status: 'opened' as const, workingCsv }));
    const exportCsv = vi.fn(async () => ({ status: 'cancelled' as const }));
    const close = vi.fn(async () => ({
      status: 'closed' as const,
      closedWorkingCsvId: workingCsv.workingCsvId,
      closedComparisonIds: [],
    }));
    let receiveEvent: ((event: CsvViewerEvent) => void) | undefined;
    const viewer = createTestCsvViewer({
      handlers: {
        ...tabHandlers(workingCsv),
        'csv.open': open,
        'csv.reopen': reopen,
        'csv.export': exportCsv,
        'csv.close': close,
      },
      onEvent: (listener) => {
        receiveEvent = listener;
        return () => {};
      },
    });

    render(
      <CsvViewerProvider viewer={viewer}>
        <App />
      </CsvViewerProvider>,
    );
    if (!receiveEvent) throw new Error('App did not subscribe to CsvViewer events.');

    await act(async () => receiveEvent?.({ type: 'intent', intent: 'open-csv' }));
    expect(open).toHaveBeenCalledWith({ operation: 'csv.open', options: {} });

    await act(async () => receiveEvent?.({ type: 'intent', intent: 'reopen-csv' }));
    expect(reopen).toHaveBeenCalledWith({
      operation: 'csv.reopen',
      workingCsvId: workingCsv.workingCsvId,
      options: {},
    });

    await act(async () => receiveEvent?.({ type: 'intent', intent: 'export-csv' }));
    expect(exportCsv).toHaveBeenCalledWith({
      operation: 'csv.export',
      workingCsvId: workingCsv.workingCsvId,
    });

    await act(async () => receiveEvent?.({ type: 'intent', intent: 'close-tab' }));
    expect(close).toHaveBeenCalledWith({
      operation: 'csv.close',
      workingCsvId: workingCsv.workingCsvId,
    });
  });

  it('shows an error when opening a Comparison rejects', async () => {
    const baseline = workingCsvFixture({ workingCsvId: 'baseline' });
    const candidate = workingCsvFixture({ workingCsvId: 'candidate' });
    const openedCsvs = [baseline, candidate];
    let receiveEvent: ((event: CsvViewerEvent) => void) | undefined;
    const viewer = createTestCsvViewer({
      handlers: {
        ...tabHandlers(candidate),
        'csv.open': async () => ({ status: 'opened', workingCsv: openedCsvs.shift() ?? candidate }),
        'comparison.get-candidates': async () => [
          { workingCsv: baseline, compatibility: { kind: 'compatible' } },
        ],
        'comparison.open': async () => {
          throw new Error('Comparison request failed.');
        },
      },
      onEvent: (listener) => {
        receiveEvent = listener;
        return () => {};
      },
    });

    render(
      <CsvViewerProvider viewer={viewer}>
        <App />
      </CsvViewerProvider>,
    );
    if (!receiveEvent) throw new Error('App did not subscribe to CsvViewer events.');

    await act(async () => receiveEvent?.({ type: 'intent', intent: 'open-csv' }));
    await act(async () => receiveEvent?.({ type: 'intent', intent: 'open-csv' }));

    await act(async () => {
      screen.getByRole('button', { name: /Compare/ }).click();
    });

    await act(async () => {
      within(screen.getByRole('dialog')).getByRole('button', { name: /baseline\.csv/ }).click();
    });

    expect(screen.getByRole('alert').textContent).toBe('Comparison request failed.');
  });

  it('warns before page unload only while a Working CSV has Unexported Changes', async () => {
    const workingCsv = workingCsvFixture({
      editState: {
        workingCsvId: 'working-csv-1',
        hasUnexportedChanges: true,
        canUndo: true,
        canRedo: false,
      },
    });
    let receiveEvent: ((event: CsvViewerEvent) => void) | undefined;
    const viewer = createTestCsvViewer({
      capabilities: { warnOnPageUnload: true },
      handlers: {
        ...tabHandlers(workingCsv),
        'csv.open': async () => ({ status: 'opened', workingCsv }),
        'csv.export': async () => ({
          status: 'exported',
          editState: {
            ...workingCsv.editState,
            hasUnexportedChanges: false,
          },
        }),
      },
      onEvent: (listener) => {
        receiveEvent = listener;
        return () => {};
      },
    });

    render(
      <CsvViewerProvider viewer={viewer}>
        <App />
      </CsvViewerProvider>,
    );

    const cleanUnload = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(cleanUnload);
    expect(cleanUnload.defaultPrevented).toBe(false);

    await act(async () => receiveEvent?.({ type: 'intent', intent: 'open-csv' }));
    const changedUnload = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(changedUnload);
    expect(changedUnload.defaultPrevented).toBe(true);

    await act(async () => {
      screen.getByRole('button', { name: 'Export CSV' }).click();
    });
    expect(screen.getByRole('status').textContent).toBe('Export complete');
    const exportedUnload = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(exportedUnload);
    expect(exportedUnload.defaultPrevented).toBe(false);
  });

  it('replaces the workspace with one reload action after a fatal data engine failure', async () => {
    let receiveEvent: ((event: CsvViewerEvent) => void) | undefined;
    const viewer = createTestCsvViewer({
      handlers: {
        'csv.get-recent-sources': async () => [],
      },
      onEvent: (listener) => {
        receiveEvent = listener;
        return () => {};
      },
    });

    render(
      <CsvViewerProvider viewer={viewer}>
        <App />
      </CsvViewerProvider>,
    );
    if (!receiveEvent) throw new Error('App did not subscribe to CsvViewer events.');

    await act(async () =>
      receiveEvent?.({
        type: 'fatal-error',
        message: 'The local data engine stopped unexpectedly.',
      }),
    );

    expect(screen.getByRole('alert').textContent).toContain(
      'The local data engine stopped unexpectedly.',
    );
    expect(screen.getByRole('button', { name: 'Reload CSV Viewer' })).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Open CSV' })).toBeNull();
  });
});
