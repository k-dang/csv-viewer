// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CsvViewerEvent, OpenCsvResult, WorkingCsvView } from '@csv-viewer/workspace/csv-viewer';
import { RendererWorkspace } from './renderer-workspace';
import { confirmTabClose } from './confirm-tab-close';
import { App } from './App';
import { CsvViewerProvider } from './csv-viewer';
import { workingCsvFixture } from '../test-helpers/csv-views';
import { createTestCsvViewer } from '../test-helpers/csv-viewer';

/** Calls a rendered CSV Tab makes on its own, leaving each test to stub what it asserts on. */
const tabHandlers = (workingCsv: WorkingCsvView) => ({
  'csv.get-recent-sources': async () => [],
  'csv.get-rows': async () => ({
    workingCsvId: workingCsv.workingCsvId,
    offset: 0,
    rows: [],
    filteredRowCount: 0,
  }),
});

const owned: RendererWorkspace[] = [];
function createWorkspace(viewer: ReturnType<typeof createTestCsvViewer>) {
  const workspace = new RendererWorkspace(viewer, { confirmClose: confirmTabClose });
  owned.push(workspace);
  return workspace;
}

beforeEach(() => {
  // jsdom ships neither of these: the App reads matchMedia for the initial theme and confirm on close.
  vi.stubGlobal('matchMedia', () => ({ matches: false }));
  vi.spyOn(window, 'confirm').mockReturnValue(true);
});

afterEach(() => {
  cleanup();
  for (const workspace of owned.splice(0)) workspace.dispose();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe('App', () => {
  it('uses current dialect input and validation for both menu and button commands', async () => {
    const open = vi.fn(async () => ({ status: 'cancelled' as const }));
    let receiveEvent: ((event: CsvViewerEvent) => void) | undefined;
    const viewer = createTestCsvViewer({
      handlers: { 'csv.open': open, 'csv.get-recent-sources': async () => [] },
      onEvent: (listener) => { receiveEvent = listener; return () => {}; },
    });
    render(<CsvViewerProvider viewer={viewer}><App workspace={createWorkspace(viewer)} /></CsvViewerProvider>);
    fireEvent.change(screen.getByRole('textbox', { name: 'Delimiter' }), { target: { value: 'xx' } });
    await act(async () => receiveEvent?.({ type: 'intent', intent: 'open-csv' }));
    expect(open).not.toHaveBeenCalled();
    expect(screen.getByText('Delimiter must be one character, or blank for automatic detection.')).toBeTruthy();

    fireEvent.change(screen.getByRole('textbox', { name: 'Delimiter' }), { target: { value: ';' } });
    await act(async () => screen.getAllByRole('button', { name: 'Open CSV' })[0].click());
    expect(open).toHaveBeenLastCalledWith({ operation: 'csv.open', options: { delimiter: ';' } });
    expect(screen.queryByText('Delimiter must be one character, or blank for automatic detection.')).toBeNull();

    fireEvent.change(screen.getByRole('textbox', { name: 'Delimiter' }), { target: { value: ',' } });
    await act(async () => receiveEvent?.({ type: 'intent', intent: 'open-csv' }));
    expect(open).toHaveBeenLastCalledWith({ operation: 'csv.open', options: { delimiter: ',' } });
  });

  it('ignores a repeated Open intent while the first selection is pending', async () => {
    const pending = Promise.withResolvers<OpenCsvResult>();
    const open = vi.fn(() => pending.promise);
    const listeners = new Set<(event: CsvViewerEvent) => void>();
    const viewer = createTestCsvViewer({
      handlers: { 'csv.open': open, 'csv.get-recent-sources': async () => [] },
      onEvent: (listener) => {
        listeners.add(listener);
        return () => { listeners.delete(listener); };
      },
    });
    const workspace = createWorkspace(viewer);
    const rendered = render(<StrictMode><CsvViewerProvider viewer={viewer}><App workspace={workspace} /></CsvViewerProvider></StrictMode>);
    expect(listeners.size).toBe(1);
    act(() => {
      for (const listener of listeners) {
        listener({ type: 'intent', intent: 'open-csv' });
        listener({ type: 'intent', intent: 'open-csv' });
      }
    });
    await act(async () => pending.resolve({ status: 'cancelled' }));
    expect(open).toHaveBeenCalledTimes(1);
    fireEvent.change(screen.getByRole('textbox', { name: 'Delimiter' }), { target: { value: ';' } });
    rendered.unmount();
    expect(listeners.size).toBe(1);
    render(<StrictMode><CsvViewerProvider viewer={viewer}><App workspace={workspace} /></CsvViewerProvider></StrictMode>);
    expect(screen.getByRole('textbox', { name: 'Delimiter' }).getAttribute('value')).toBe(';');
    expect(listeners.size).toBe(1);
    workspace.dispose();
    expect(listeners.size).toBe(0);
  });

  it.each(['source-bytes', 'workspace-source-bytes'] as const)('shows the %s capacity outcome while keeping the existing Tab', async (limit) => {
    const workingCsv = workingCsvFixture();
    const message = limit === 'source-bytes'
      ? 'CSV Viewer Web supports files up to 100 MB. Use the desktop application for larger files.'
      : 'CSV Viewer Web supports up to 200 MB of open CSV files. Use the desktop application for larger workspaces.';
    const open = vi.fn<() => Promise<OpenCsvResult>>()
      .mockResolvedValueOnce({ status: 'opened', workingCsv })
      .mockResolvedValue({
        status: 'capacity-exceeded',
        limit,
        limitBytes: limit === 'source-bytes' ? 100_000_000 : 200_000_000,
        message,
      });
    let receiveEvent: ((event: CsvViewerEvent) => void) | undefined;
    const viewer = createTestCsvViewer({
      handlers: {
        ...tabHandlers(workingCsv),
        'csv.open': open,
      },
      onEvent: (listener) => {
        receiveEvent = listener;
        return () => {};
      },
    });
    render(
      <CsvViewerProvider viewer={viewer}>
        <App workspace={createWorkspace(viewer)} />
      </CsvViewerProvider>,
    );
    await act(async () => receiveEvent?.({ type: 'intent', intent: 'open-csv' }));
    await act(async () => receiveEvent?.({ type: 'intent', intent: 'open-csv' }));
    expect(screen.getByText(message)).toBeTruthy();
    expect(screen.getByRole('tab', { name: new RegExp(workingCsv.source.name) }).getAttribute('aria-selected')).toBe('true');
  });

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
        <App workspace={createWorkspace(viewer)} />
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
        <App workspace={createWorkspace(viewer)} />
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
        <App workspace={createWorkspace(viewer)} />
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

  it.each(['The local data engine stopped unexpectedly.', ''])(
    'replaces the workspace with one reload action after a fatal data engine failure (%j)',
    async (message) => {
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
          <App workspace={createWorkspace(viewer)} />
        </CsvViewerProvider>,
      );
      if (!receiveEvent) throw new Error('App did not subscribe to CsvViewer events.');

      await act(async () => receiveEvent?.({ type: 'fatal-error', message }));

      expect(screen.getByRole('alert').textContent).toContain(message);
      expect(screen.getByRole('button', { name: 'Reload CSV Viewer' })).toBeDefined();
      expect(screen.queryByRole('button', { name: 'Open CSV' })).toBeNull();
    },
  );
});
